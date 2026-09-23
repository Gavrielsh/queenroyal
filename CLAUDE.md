# queenroyal — notes for Claude Code

- **What to build next:** `docs/PLAN.md` (shared with the `True` repo; keep both copies identical).
  `ROADMAP.md` is out of date.
- **Rules:** `.claude-instructions` (G1–G4). Read it before any change to money, wallet or
  engine calls.
- **Layout:** web app in `src/` (Next.js), gateway in `apps/financial-gateway/` (Fastify + Prisma).
  The ledger engine is the separate `True` repo; the gateway talks to it over HMAC-signed HTTP.
- **Checks before commit:** `npm run typecheck && npm run lint && npm test` at the root and in
  `apps/financial-gateway`; `npx playwright test` for user-facing changes.
- Work on a feature branch, one PR per plan item, and tick the item in `docs/PLAN.md`.
