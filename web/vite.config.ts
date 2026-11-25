import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../internal/ui/dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'https://127.0.0.1:8555',
        changeOrigin: true,
        secure: false,
        ws: true,
      },
      '/healthz': {
        target: 'https://127.0.0.1:8555',
        secure: false,
      },
      '/readyz': {
        target: 'https://127.0.0.1:8555',
        secure: false,
      },
    },
  },
});
