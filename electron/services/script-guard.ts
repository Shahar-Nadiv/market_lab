/**
 * Static hardening applied to user scripts before they run.
 *
 * This is the second of the sandbox's three layers. The first is the Web
 * Worker itself (no DOM, and networking globals deleted); the third is a
 * watchdog that terminates a worker that overruns its time budget.
 *
 * This layer rewrites the source so that:
 *   - every loop and function body checks a step budget, so `while(true){}`
 *     throws instead of wedging the worker (a terminated worker loses its
 *     error message; a thrown error can be reported against the right line);
 *   - obvious escape hatches are rejected at parse time with a clear message,
 *     rather than failing obscurely at runtime.
 */

import { parse } from 'acorn';
import { generate } from 'astring';
import type { Node } from 'acorn';

/** Identifiers a script may never reference. */
const BANNED_IDENTIFIERS = new Set([
  'eval', 'Function', 'importScripts', 'fetch', 'XMLHttpRequest', 'WebSocket',
  'postMessage', 'self', 'globalThis', 'window', 'document', 'localStorage',
  'indexedDB', 'Worker', 'SharedWorker', 'Notification', 'navigator',
  'require', 'process', 'module', 'exports', '__proto__', 'constructor',
]);

export class ScriptCompileError extends Error {
  constructor(message: string, readonly line?: number) {
    super(message);
    this.name = 'ScriptCompileError';
  }
}

/** Name of the injected budget function. Deliberately awkward to collide with. */
export const TICK_FN = '__mlTick__';

/**
 * Parse, validate and instrument a user script.
 *
 * Returns JavaScript ready to be wrapped in the worker's function scope.
 */
export function compileScript(source: string): string {
  let ast: Node;
  try {
    // No modules: a script cannot import anything, so there is nothing to
    // resolve and no path for pulling in host capabilities.
    ast = parse(source, {
      ecmaVersion: 2022,
      sourceType: 'script',
      locations: true,
      allowAwaitOutsideFunction: false,
    });
  } catch (e: any) {
    throw new ScriptCompileError(e?.message ?? 'Syntax error', e?.loc?.line);
  }

  reject(ast);
  instrument(ast);
  return generate(ast as any);
}

/** Walk the AST and refuse anything that could break out of the sandbox. */
function reject(ast: Node): void {
  walk(ast, (node: any) => {
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ImportExpression':
        throw new ScriptCompileError('Imports are not allowed in indicator scripts.', node.loc?.start.line);

      case 'WithStatement':
        throw new ScriptCompileError('`with` is not allowed.', node.loc?.start.line);

      case 'Identifier':
        if (BANNED_IDENTIFIERS.has(node.name)) {
          throw new ScriptCompileError(
            `"${node.name}" is not available inside an indicator script.`,
            node.loc?.start.line,
          );
        }
        break;

      case 'MemberExpression':
        // Block computed access to the banned names too: obj["constructor"]
        // is the classic route to the Function constructor.
        if (node.computed && node.property?.type === 'Literal' && BANNED_IDENTIFIERS.has(String(node.property.value))) {
          throw new ScriptCompileError(
            `Access to "${node.property.value}" is not allowed.`,
            node.loc?.start.line,
          );
        }
        break;
    }
  });
}

/**
 * Insert a budget check at the top of every loop body and function body.
 *
 * Recursion and unbounded loops both burn the same budget, so a single counter
 * covers runaway iteration and runaway recursion.
 */
function instrument(ast: Node): void {
  const tick = {
    type: 'ExpressionStatement',
    expression: { type: 'CallExpression', callee: { type: 'Identifier', name: TICK_FN }, arguments: [], optional: false },
  };

  walk(ast, (node: any) => {
    const isLoop =
      node.type === 'WhileStatement' ||
      node.type === 'DoWhileStatement' ||
      node.type === 'ForStatement' ||
      node.type === 'ForOfStatement' ||
      node.type === 'ForInStatement';
    const isFn =
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression';

    if (!isLoop && !isFn) return;

    if (isLoop) {
      // A single-statement body (`while (x) doThing()`) has nowhere to put the
      // check, so promote it to a block first.
      if (node.body.type !== 'BlockStatement') {
        node.body = { type: 'BlockStatement', body: [node.body] };
      }
      node.body.body.unshift(structuredCloneNode(tick));
    } else if (node.body?.type === 'BlockStatement') {
      node.body.body.unshift(structuredCloneNode(tick));
    } else if (node.body) {
      // Concise arrow body: `x => expr` becomes `x => { tick(); return expr }`.
      node.body = {
        type: 'BlockStatement',
        body: [structuredCloneNode(tick), { type: 'ReturnStatement', argument: node.body }],
      };
      node.expression = false;
    }
  });
}

function structuredCloneNode<T>(n: T): T {
  return JSON.parse(JSON.stringify(n)) as T;
}

/** Depth-first walk over every child node. */
function walk(node: any, visit: (n: any) => void): void {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) walk(c, visit);
    } else if (child && typeof child === 'object') {
      walk(child, visit);
    }
  }
}
