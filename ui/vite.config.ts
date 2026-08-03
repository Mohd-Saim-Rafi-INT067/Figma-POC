import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      // Dev only. In the demo build, Express serves ui/dist on 5173 and there
      // is no proxy and no Vite in the room at all - see plan §10.
      '/api': {
        target: 'http://localhost:5173',
        changeOrigin: true,
        // The progress stream is Server-Sent Events; buffering it would make
        // every stage arrive at once, at the end.
        ws: false,
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
