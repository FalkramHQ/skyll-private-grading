import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // html2pdf.js bundles old html2canvas, which cannot parse Tailwind v4 oklch().
  resolve: {
    alias: {
      html2canvas: 'html2canvas-pro',
    },
  },
  optimizeDeps: {
    include: ['html2canvas-pro'],
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3456',
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          // Framework code changes rarely; its own chunk stays cached across deploys.
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          katex: ['katex', 'remark-math', 'rehype-katex'],
          'html2pdf': ['html2pdf.js', 'html2canvas-pro'],
        },
      },
    },
  },
})
