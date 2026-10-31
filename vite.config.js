import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages (/GenTrification/) or any other path.
export default defineConfig({
  base: './',
  server: { port: 5173, host: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
