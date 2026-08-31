# QueenRoyal — Road to Production

The path from the current MVP to a launch-ready US social sweepstakes casino. Spans both
repositories: **`True`** (Go ledger engine) and **`QueenRoyal`** (Fastify gateway + Next.js client).

**Where we are.** The financial core is production-grade: an ACID double-entry ledger with
three-currency sweepstakes segregation, pessimistic wallet locking, three-layer idempotency with
ghost-spin recovery, HMAC + replay + geo perimeter, monthly partitioning, async GGR aggregation,
and an observe-only balance reconciler. What is missing is almost entirely *the casino on top of
it*: one slot game, no meta-game economy, no redemption path, no lobby, and no backoffice.

**The rule that governs every item below** is `.claude-instructions` (G1–G4: zero-state gateway,
decimal-string money, mandatory idempotency, fail-closed). Nothing here overrides it.

Legend: `[ ]` open · `[x]` done · **⚖️** legal/compliance blocker for launch

---

## Phase 0 — Core Loop

*The product loop is not closed. The engine has a server-authoritative `/spin` and the gateway has
`POST /api/spin`, but nothing calls it, and `SC_REDEEMABLE` has no path out of the system.*

### 0.1 Wire the spin loop (frontend → gateway → engine)
- [x] `src/lib/spinIntent.ts` — per-attempt idempotency token with retain/rotate lifecycle
- [x] `src/lib/apiClient.ts` — `submitSpin()` + `parseSpinEnvelope()` runtime validation
- [x] `src/hooks/useSpinMutation.ts` — TanStack Query mutation, typed outcome, never throws
- [x] `MockGameWindow.tsx` — render the engine's authoritative reels; no local outcome math
- [x] UI loading state, disabled-while-pending, cooldown on service-unavailable
- [x] Edge case: `400 INSUFFICIENT_FUNDS` — error notice, reels restored, no fabricated outcome
- [x] Edge case: `503` / network timeout — button disabled with bounded cooldown, honest copy
- [x] Edge case: `409 TRANSACTION_PENDING` / `200 GHOST_RECOVERED` — handled without crashing
- [x] Wallet cache invalidated through the shared choke point on every ledger-moving outcome
- [x] Vitest coverage for the hook and the component across 200/400/409/503/network
- [x] Playwright e2e for the spin journey

### 0.2 Redemption path (**⚖️** the whole point of SC_REDEEMABLE)
- [ ] `lib/true-engine.ts`: `sendRedeem()` mirroring `purchase()`
- [ ] Prisma: add `REDEEM` to `EngineRequestType`; add `RedemptionRequest` (review queue, **no balances**)
- [ ] `services/redemption.service.ts`: auth → KYC gate → journal intent → engine `/store/redeem`
- [ ] `kyc-policy.ts`: add a `REDEEM` action requiring `VERIFIED`
- [ ] `POST /api/store/redeem` + minimum-redemption and daily-cap policy
- [ ] Payout provider seam (ACH / gift card / check) behind the `PaymentProvider` interface
- [ ] Frontend redemption screen with playthrough-eligibility copy

### 0.3 CI and hygiene
- [ ] `.github/workflows` for `True`: `go build`, `go vet`, `go test ./...`, `golangci-lint`
- [ ] **RTP assertion as a build gate**: `TestDeclaredRTPMatchesModel`, `TestRTPInRegulatoryBand`
      and the Monte-Carlo `TestSpinConvergesToRTP` all exist in `True/internal/game` and pass —
      what is missing is a workflow that RUNS them on every PR. The outstanding work is the CI
      wiring, not the tests. (Corrected in M0-T5: this item previously said `ARCHITECTURE.md`
      claims the gate is enforced in CI. No architecture doc makes that claim — verified across
      both repos and their git history — so there was no false claim to retract, only this
      one. Nothing should assert the gate exists until the workflow does.)
- [ ] `.github/workflows` for `QueenRoyal`: `tsc --noEmit` + `vitest run` for both workspaces,
      `playwright test` on PR
- [ ] Remove the committed 53 MB `engine.exe` from `True` and gitignore it
- [x] Fix stale docs: `.claude-instructions` documented `GET /session?player_id=…`; the router
      serves `POST /session` with the id in the signed body. Corrected in M0-T5.

---

## Phase 1 — Real-Time & Lobby

*`src/lib/realtime/sseChannel.ts` is a complete, tested EventSource client — heartbeat watchdog, equal-jitter
backoff, opaque payload-free events. It has no server.*

### 1.1 Server-Sent Events
- [ ] `GET /api/wallet/stream` on the gateway: named `event: heartbeat` every ~20s,
      `event: wallet` (opaque, no payload) on settlement
- [ ] Ticket auth: `GET /api/wallet/stream/ticket` mints a short-lived signed ticket
      (EventSource cannot send an `Authorization` header)
- [ ] Redis pub/sub fan-out so any pod can notify any connected player
- [ ] Publish from `spin.service`, `store.service`, `psp-webhook.service`, `game-adapter.service`
- [ ] Set `NEXT_PUBLIC_WALLET_CHANNEL_URL` to activate the existing client flag
- [ ] Connection-count metric + a cap per player; graceful drain on shutdown
- [ ] **G1 check:** the stream carries *no money bytes* — it is an invalidation signal only

### 1.2 Casino lobby
- [ ] Prisma `Game` model (engine `gameId`, title, thumbnail, category, `rtpDisplay`, enabled, sort)
- [ ] `GET /api/games`; seed from the engine's `game.Lookup` registry — the catalog must never
      list a game the engine will reject
- [ ] `/casino` lobby grid: categories, search, recently played, "hot" merchandising
- [ ] Game detail / launch route; move the KYC gate to launch time (settlement-time is a backstop)
- [ ] Real login + registration UI (today the only path is `DevAutoLogin` → `mock-login`)

---

## Phase 2 — Game Engine

### 2.1 Abstraction
- [ ] Extract a `Game` interface (`Play(bet, rng) (Outcome, error)`) in `internal/game`;
      `ReelCount = 3` and the left-to-right line rules are currently package constants
- [ ] Make `repository.ProcessSpin` game-agnostic; keep `Outcome` in ledger metadata for replay
- [ ] Per-game config: min/max stake, enabled currencies, volatility class

### 2.2 Game breadth
- [ ] 5-reel, multi-line slot with configurable paylines
- [ ] Scatter symbols and **free spins** — requires persisted round state (`FreeSpinState`),
      since a free-spin round spans multiple requests
- [ ] Hold-and-spin / respin feature
- [ ] One table game (blackjack) with server-held hand state
- [ ] Extend the Monte-Carlo RTP test to every new paytable

### 2.3 Provably fair
- [ ] Commit-reveal: per-round server seed hash, client seed, nonce
- [ ] `GET /api/rounds/:id/verify` → `{server_seed, client_seed, nonce, reels, paytable_version}`
      (`game.Evaluate` is already pure and re-runnable from a recorded `Outcome`)
- [ ] Player-facing fairness page

### 2.4 Jackpots
- [ ] `HOUSE_JACKPOT_POOL` account type + per-spin contribution rate
- [ ] Async pool aggregation (never a hot single row — architecture §6.C)
- [ ] Trigger, award, and reseed logic; live jackpot ticker over the SSE channel

---

## Phase 3 — Economy & Meta-Game

*All gateway-side state; coin grants are issued by calling the engine's `/store/purchase`.
Nothing here touches a balance directly (G1).*

- [ ] **Daily bonus / streak** — `DailyBonusClaim` (unique on `(userId, gamingDate)`),
      `POST /api/bonus/daily/claim`, anchor `bonus:daily:<userId>:<date>` (naturally idempotent)
- [ ] **VIP progression** — `User.vipLevel` exists and is never read or written. Add `VipTier`
      config (thresholds, perks, GC multiplier), XP accrual on spin settlement, tier-up grants
- [ ] **Leaderboards** — Redis sorted sets, `ZINCRBY` on settlement; daily/weekly boards
- [ ] **Tournaments / slot races** — `Tournament` model, entry, live scoring, prize settlement
- [ ] **⚖️ Free Method of Entry (AMOE)** — postal/no-purchase SC grant. Legally mandatory for the
      US sweepstakes model; the landing page already promises "no purchase necessary"
- [ ] **Store depth** — first-purchase offer, time-limited bundles, personalized offers,
      A/B framework (today: 4 hardcoded packages in a `.ts` file)
- [ ] Missions/quests, achievements, referral program

---

## Phase 4 — Compliance & Operations

- [ ] **Admin panel** (Next.js app over new gateway endpoints): player search + detail, ledger
      view, KYC review queue, redemption approval, manual adjustment via the engine's existing
      `ADJUSTMENT` transaction type, bonus/tournament CMS
- [ ] **⚖️ Enforce `SUSPENDED` in the Go bet path** — `user_status` has `SUSPENDED`/`CLOSED` and
      nothing checks either at wager time. Self-exclusion is unenforceable until this lands
- [ ] **⚖️ Responsible gaming** — self-exclusion, deposit/loss/session limits, reality checks,
      cool-off periods
- [ ] **KYC provider integration** — Jumio/Persona/Veriff, document upload, webhook status
      updates into `kycStatus`, re-verification triggers
- [ ] **⚖️ Fraud & AML** — velocity rules, device/IP fingerprinting, multi-account and
      shared-payment-instrument detection, bonus abuse, chargeback handling, threshold reporting
      on redemptions
- [ ] **Analytics** — CDC/read-replica → warehouse; DAU/MAU, ARPDAU, retention cohorts, funnels,
      per-game actual-vs-declared RTP monitoring, segmentation
- [ ] **Notifications** — in-app inbox, push, email/SMS
- [ ] Load testing beyond `k6_bet_win.js`: a `/spin` scenario, since `/spin` is the preferred
      first-party path and is currently untested under load

---

## Sequencing note

Phases 3 and 4 carry a dependency that is easy to get backwards: **responsible gaming, AMOE, and
redemption review are launch blockers, not post-launch polish.** If timeline pressure forces a cut,
cut game breadth (Phase 2) — not compliance.
