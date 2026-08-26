/**
 * Typed accessor for the preload bridge.
 *
 * Importing this instead of touching `window.marketlab` directly keeps the
 * global assertion in one place and gives the rest of the app real types.
 */

import type { MarketLabApi } from '../../electron/preload';

declare global {
  interface Window {
    marketlab: MarketLabApi;
  }
}

export const api: MarketLabApi = window.marketlab;

/** True when running inside Electron rather than a bare browser tab. */
export const hasBridge = typeof window !== 'undefined' && !!window.marketlab;
