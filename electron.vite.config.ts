import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: 'src/main/index.ts', runtime: 'src/runtime/index.ts' } },
    },
  },
  preload: {},
  renderer: { plugins: [react()], build: { chunkSizeWarningLimit: 1800 } },
})
