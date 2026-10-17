# Tempe Volleyball

New website and admin for [Tempe Volleyball](https://www.tempevb.com), on Cloudflare Workers + D1.

- **PLAN.md**: architecture, data model, phases, open questions, account setup
- **CLAUDE.md**: commands, structure, conventions, domain rules

```sh
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

## Environments

- Staging: https://tempe-volleyball-staging.tempevb.workers.dev
- Production (until the domain moves): https://tempe-volleyball-production.tempevb.workers.dev
- Each PR gets a preview URL, linked in the CI run's summary.
