import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/** Production locks the renderer down; the dev server needs room for Vite's
 *  inline refresh preamble and its HMR websocket, so the policy differs. */
const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'self'"
const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; " +
  "connect-src 'self' ws: http://localhost:*"

function cspPlugin(): Plugin {
  return {
    name: 'kreos-csp',
    transformIndexHtml(html, ctx) {
      return html.replace('%CSP%', ctx.server ? DEV_CSP : PROD_CSP)
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') } }
    },
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } }
    },
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), cspPlugin()],
    // Node resolves `localhost` to ::1 first on Windows, and Vite would bind
    // IPv6-only — leaving Electron's loadURL refused. Pinning both ends to
    // 127.0.0.1 keeps the address the dev server listens on and the address
    // the window loads identical.
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
    }
  }
})
