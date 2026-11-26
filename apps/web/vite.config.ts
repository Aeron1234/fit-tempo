import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: 'fit-tempo-offline-shell',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter(name => name.startsWith('assets/')).sort()
      const worker = readFileSync(new URL('./pwa-worker.js', import.meta.url), 'utf8')
      const hash = createHash('sha256').update(worker)
      for (const name of ['index.html', ...assets]) {
        const entry = bundle[name]
        if (entry) hash.update(entry.type === 'chunk' ? entry.code : entry.source)
      }
      this.emitFile({
        type: 'asset',
        fileName: 'fit-tempo-sw.js',
        source: `const CACHE = "fit-tempo-shell-${hash.digest('hex').slice(0, 16)}";\nconst ASSETS = ${JSON.stringify(assets.map(name => '/' + name))};\n${worker}`,
      })
    },
  }],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: false },
    },
  },
})
