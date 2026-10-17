import { defineConfig } from 'vitest/config'

// Unit tests for pure logic (src/lib, src/server). They run in Node and must not import
// `cloudflare:*` modules; pass bindings in as arguments instead so they can be faked.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
