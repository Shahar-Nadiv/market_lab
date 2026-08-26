/**
 * Runs user scripts in disposable worker threads.
 *
 * A fresh thread per run costs a few milliseconds and buys unconditional
 * termination: `vm`'s own timeout handles well-behaved synchronous code, but a
 * thread we own can always be killed, whatever the script does.
 */

import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import type { Candle, ScriptRunResult } from '../../shared/types';
import { compileScript, ScriptCompileError } from './script-guard';

const TIMEOUT_MS = 4000;
const MAX_STEPS = 20_000_000;
/** Leave headroom so vm's internal timeout usually fires first, with a better message. */
const HARD_KILL_MS = TIMEOUT_MS + 1500;

export async function runUserScript(
  source: string,
  candles: Candle[],
  inputs: Record<string, any> = {},
): Promise<ScriptRunResult> {
  let code: string;
  try {
    code = compileScript(source);
  } catch (e) {
    if (e instanceof ScriptCompileError) {
      return {
        ok: false,
        error: {
          message: e.message,
          line: e.line,
          kind: /not available|not allowed/.test(e.message) ? 'security' : 'syntax',
        },
      };
    }
    return { ok: false, error: { message: String(e), kind: 'syntax' } };
  }

  const started = Date.now();
  const workerPath = path.join(__dirname, 'script-worker.js');

  return new Promise<ScriptRunResult>((resolve) => {
    let settled = false;
    const finish = (r: ScriptRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      void worker.terminate();
      resolve(r);
    };

    const worker = new Worker(workerPath, {
      workerData: {
        code,
        // Plain data only — the worker never receives live references.
        candles: candles.map((c) => ({
          time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
        })),
        inputs,
        maxSteps: MAX_STEPS,
        timeoutMs: TIMEOUT_MS,
      },
      // The script cannot reach the environment or stdio.
      env: {},
      stdout: true,
      stderr: true,
    });

    const killTimer = setTimeout(() => {
      finish({ ok: false, error: { message: `Script timed out after ${TIMEOUT_MS}ms.`, kind: 'timeout' } });
    }, HARD_KILL_MS);

    worker.on('message', (msg: any) => {
      finish(
        msg?.ok
          ? { ok: true, descriptor: msg.descriptor, durationMs: Date.now() - started }
          : { ok: false, error: msg?.error ?? { message: 'Unknown script error', kind: 'runtime' } },
      );
    });

    worker.on('error', (err) => {
      const timedOut = /timed out/i.test(err.message);
      finish({
        ok: false,
        error: { message: err.message, kind: timedOut ? 'timeout' : 'runtime' },
      });
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        finish({ ok: false, error: { message: `Script worker exited with code ${code}.`, kind: 'runtime' } });
      }
    });
  });
}
