/**
 * Typed accessor for the preload bridge.
 *
 * Importing this instead of touching `window.marketlab` directly keeps the
 * global assertion in one place and gives the rest of the app real types.
 */

import type { MarketLabApi } from '../../electron/preload';
import { createBrowserBridge } from './browserBridge';

declare global {
  interface Window {
    marketlab?: MarketLabApi;
  }
}

/** True when running inside Electron rather than a bare browser tab. */
export const hasBridge = typeof window !== 'undefined' && !!window.marketlab;

/**
 * The real bridge in Electron, a browser implementation of the same contract
 * everywhere else.
 *
 * Outside Electron there is no main process, so no SQLite and no market feed —
 * `browserBridge.ts` answers with a seeded series and localStorage instead. That
 * makes the whole interface reachable from any browser, which it was not before:
 * the app rendered a single "no preload bridge" message and stopped.
 *
 * `hasBridge` still tells the truth, so anything that genuinely needs the desktop
 * app can check it and say so rather than failing quietly.
 */
export const api: MarketLabApi = window.marketlab ?? (createBrowserBridge() as MarketLabApi);
