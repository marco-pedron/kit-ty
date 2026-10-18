import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    // The UI talks to the agent (SPEC §14), same origin through this proxy; the relay is only
    // read, to check the log without trusting anyone.
    proxy: {
      '/api': `http://127.0.0.1:${process.env.AGENT_PORT ?? 4100}`,
      // Read-only: the Log screen re-verifies the relay's chain in the browser (task C6).
      '/relay': {
        target: `http://127.0.0.1:${process.env.RELAY_PORT ?? 4000}`, rewrite: (p) => p.replace(/^\/relay/, '') },
    },
  },
});
