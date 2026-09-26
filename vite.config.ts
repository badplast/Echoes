import { defineConfig } from 'vite';

// base: './' keeps the build portable (GitHub Pages sub-path, local file hosting).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  server: { port: 5173 },
});
