import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // The UI talks only to the agent (SPEC §14), same origin through this proxy.
    proxy: { '/api': 'http://127.0.0.1:4100' },
  },
});
