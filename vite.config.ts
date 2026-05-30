import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      // When watching, IGNORE files the browser never serves. Editing tests, docs,
      // the server, the inert SQLite scaffold, or ledger/log/json state files was
      // triggering [vite] full-page reloads that tore down the live voice WebSocket
      // + AudioContext mid-session (the connection "flapping").
      watch: process.env.DISABLE_HMR === 'true' ? null : {
        ignored: [
          '**/tests/**',
          '**/docs/**',
          '**/logs/**',
          '**/src/store/**',
          '**/server.ts',
          '**/*.log',
          '**/.janus_*',
          '**/DEBUG_NOTES.md',
        ],
      },
    },
  };
});
