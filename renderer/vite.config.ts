import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import * as path from 'node:path';

export default defineConfig({
  root: __dirname,
  // Electron loads the built renderer from the filesystem, so assets must be
  // referenced relatively rather than from the server root.
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: path.resolve(__dirname, '../dist/renderer'),
    emptyOutDir: true,
    // Electron ships a known-modern Chromium, so there is no reason to
    // downlevel past what it supports.
    target: 'chrome130',
    // Production bundles ship no source maps: they roughly double the payload
    // and expose the original sources inside a distributed app. The dev server
    // provides its own maps regardless of this setting.
    sourcemap: false,
  },
});
