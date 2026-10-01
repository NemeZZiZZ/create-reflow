import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  // GitHub Pages hosts the production build under the repo subpath;
  // the dev server (owner's IDE, Web Serial grants) stays at /.
  base: command === 'build' ? '/create-reflow/' : '/',
  plugins: [react(), tailwindcss()],
}))
