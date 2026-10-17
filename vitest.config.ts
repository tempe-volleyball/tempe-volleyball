import { defineConfig } from 'vitest/config'

// Unit tests for pure logic (src/lib, src/server, and scripts/ for the one-off data scripts). They run in Node and must not import
// `cloudflare:*` modules; pass bindings in as arguments instead so they can be faked.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
  },
})
