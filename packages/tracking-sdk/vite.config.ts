import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'Revynta',
      fileName: 'tracker',
      formats: ['iife', 'es'],
    },
    sourcemap: true,
    minify: 'esbuild',
  },
  // @ts-ignore - Vitest config types
  test: {
    environment: 'happy-dom',
  },
});
