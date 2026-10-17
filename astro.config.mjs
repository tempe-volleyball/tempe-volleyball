// @ts-check
import { defineConfig } from 'astro/config'
import cloudflare from '@astrojs/cloudflare'
import react from '@astrojs/react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // Canonical URLs and the sitemap always point at the real domain, even on *.workers.dev.
  site: 'https://www.tempevb.com',
  trailingSlash: 'ignore',
  // Pages render on the Worker by default. Static pages opt in with `export const prerender = true`.
  output: 'server',
  adapter: cloudflare({
    // Optimise images at build time only, so no Cloudflare Images binding (a paid add-on) is needed.
    imageService: 'compile',
  }),
  // Astro sessions would need a KV namespace. Auth sessions live in D1 instead.
  session: false,
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
})
