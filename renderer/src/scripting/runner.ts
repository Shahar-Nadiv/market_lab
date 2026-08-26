/**
 * Renderer-side entry point for running user scripts.
 *
 * Execution happens in the main process (see `electron/services/script-host.ts`):
 * a worker thread with a `vm` context, which gives a genuinely separate V8
 * realm and sidesteps the renderer's Content-Security-Policy — the UI
 * deliberately forbids `unsafe-eval`, so user code could not run here even if
 * we wanted it to.
 */

import type { Candle, ScriptRunResult } from '@shared/types';
import { api } from '../api';

export async function runScript(
  source: string,
  candles: Candle[],
  inputs: Record<string, any> = {},
): Promise<ScriptRunResult> {
  try {
    return (await api.runScript(source, candles, inputs)) as ScriptRunResult;
  } catch (e) {
    return {
      ok: false,
      error: { message: e instanceof Error ? e.message : String(e), kind: 'runtime' },
    };
  }
}
