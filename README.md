# Gateway & Cashier Service

The **"Dumb but Secure" middleman** between frontend players and the Go **"True Engine"**
ledger for a US Social Sweepstakes Casino. Built with Next.js 15 (App Router) + TypeScript.

This service is an **auth layer, API gateway, and B2B adapter**. It holds **zero financial
state** — the Go engine is the single source of truth for all GC / SC balances.

## Architectural guarantees

| Rule | How it's enforced |
| --- | --- |
| **Zero financial state** | The `User` schema holds only `email`, `passwordHash`, `kycStatus`, `vipLevel`. No `gc_balance`/`sc_balance` anywhere (`prisma/schema.prisma`). |
| **Zero-trust / HMAC** | Every outbound call signs `HMAC-SHA256(rawBody, ENGINE_SECRET_KEY)` → `X-Signature` (`src/lib/true-engine.ts`). The exact serialized bytes are signed and sent. |
| **Idempotency** | Every financial call generates a UUID v4 `transaction_id`, also sent as `X-Idempotency-Key`. |
| **Integers only** | All money values are validated as integers via Zod (`.int()`); no float ever reaches the ledger. |
| **Graceful failure** | The engine client never throws for HTTP/transport errors — it returns a typed `TrueEngineResult`, mapped to clean JSON. The Node process never crashes on a ledger error. |

## Layout

```
src/
├── app/api/
│   ├── auth/register/route.ts   # POST – create account, return JWT
│   ├── auth/login/route.ts      # POST – login, return JWT
│   ├── store/purchase/route.ts  # POST – fiat → coins (mock Stripe → sendDeposit)
│   ├── game/spin/route.ts       # POST – bet (+ optional win) via the adapter
│   └── health/route.ts          # GET  – liveness
├── lib/
│   ├── true-engine.ts           # ★ Signed HMAC client (sendBet/sendWin/sendDeposit)
│   ├── jwt.ts, auth-guard.ts    # JWT sign/verify + Bearer guard
│   ├── prisma.ts, env.ts, http.ts, mock-stripe.ts
├── services/                    # business logic (auth / store / game-adapter)
├── schemas/                     # Zod request validation
├── types/true-engine.ts         # strict DTOs
└── config/store-packages.ts     # fiat package catalog (source of truth)
```

## Endpoints

All bodies are JSON. Authenticated routes require `Authorization: Bearer <jwt>`.

### `POST /api/auth/register` · `POST /api/auth/login`
```json
{ "email": "player@example.com", "password": "hunter2hunter2" }
```
→ `{ "success": true, "data": { "user": { "id": "…", "kycStatus": "PENDING", … }, "token": "<jwt>" } }`

### `POST /api/store/purchase` (auth)
```json
{ "packageId": "pkg_value_20", "idempotencyKey": "optional-stable-key" }
```
Validates the package → KYC gate → journals a `PENDING` deposit intent → opens a PSP
PaymentIntent (no capture) → returns `{ status: "requires_payment_confirmation",
clientSecret, paymentIntentId, operatorTransactionId, package }`. The frontend confirms the
card (and any 3DS/SCA) with `clientSecret`; the ledger is credited **asynchronously, exactly
once**, when the verified `payment_intent.succeeded` webhook arrives (see below). No raw card
data ever reaches this service.

### `POST /api/webhooks/psp` (PSP → gateway)
The PSP's signed settlement webhook. The raw body's HMAC signature is verified, then a
`payment_intent.succeeded` triggers the idempotent True Engine credit for the referenced
deposit intent, while `payment_intent.payment_failed` marks it terminal. A lost webhook is
recovered by the reconciler polling the PSP.

### `POST /api/game/spin` (auth)
```json
{ "gameId": "pragmatic_wolf_gold", "currency": "SC", "betAmount": 100, "winAmount": 250 }
```
Generates one shared `round_id` → `sendBet()` → on 200, if `winAmount > 0`, `sendWin()` with
`round_id = "win_<round_id>"` → returns the final state.

## Error envelope
```json
{ "success": false, "error": { "code": "LEDGER_REJECTED", "message": "…", "details": { } } }
```
Engine codes are passed through (`INSUFFICIENT_FUNDS`, `UNAUTHORIZED_SIGNATURE`, …). Transport
issues map to `ENGINE_TIMEOUT` / `ENGINE_UNREACHABLE` (HTTP 502).

## Getting started

```bash
cp .env.example .env        # fill in secrets
npm install
npm run prisma:generate
npm run prisma:migrate      # create the users / store_packages tables
npm run db:seed             # load the package catalog
npm run dev
```

Required env: `DATABASE_URL`, `JWT_SECRET`, `ENGINE_BASE_URL`, `ENGINE_SECRET_KEY`
(`ENGINE_SECRET` is accepted as an alias). See `.env.example`.

## Notes / future hardening
- Auth uses stateless JWT + bcrypt (cost 12) — appropriate for an API gateway and avoids edge-runtime crypto limits. Routes pin `runtime = "nodejs"`.
- The engine must recompute the HMAC over the **raw request body bytes** for signatures to match.
- Not yet implemented (out of current scope): rate limiting, HMAC replay protection (timestamp/nonce), inbound signature verification from B2B providers, and automated refund on a captured-but-uncredited deposit.
