import { defineConfig } from 'drizzle-kit'

// drizzle-kit only GENERATES SQL here. Apply it with `npm run db:migrate:local` (or the CI workflow),
// which runs `wrangler d1 migrations apply` so wrangler tracks what has been applied.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/server/db/schema.ts',
  out: './migrations',
})
