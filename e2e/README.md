# Visual Verification Harness (Zone 3)

Deterministic, **gateway-free** screenshot matrix of every UI state the styling epic (M3)
touches. The Fastify gateway, Go engine, Redis, and the real network are **never contacted**:
every gateway endpoint is stubbed at the browser network layer with envelopes that mirror the
verified wire contracts, and any request the stubs don't cover aborts and **fails the test**.

## Run it

```bash
# one-time on a dev machine (the hosted container already has a browser):
npx playwright install chromium

npm run test:visual
```

Output (gitignored, regenerated on demand):

```
e2e/screenshots/
├── desktop/            # 1280×800
│   ├── 01-landing.png
│   ├── 02-casino-syncing.png
│   ├── 03-casino-synced.png
│   ├── 04-casino-unauthorized.png
│   ├── 05-casino-ledger-unavailable.png
│   ├── 06-casino-login-failed.png
│   ├── 07-purchase-inflight.png
│   ├── 08-purchase-settled.png
│   ├── 09-purchase-declined.png
│   └── 10-game-spinning.png
└── mobile/             # 390×844 — same ten states
```

## State matrix

| # | State | Stub scenario |
| --- | --- | --- |
| 01 | Landing page | static (no gateway calls) |
| 02 | Wallet read in flight | `GET /api/wallet` held pending → honest placeholders |
| 03 | Ledger-synced | wallet resolves engine strings verbatim (`1000.0000` → `1,000`) |
| 04 | Unauthorized | wallet 401 `UNAUTHORIZED` → "log in" state (after RQ retry backoff) |
| 05 | Ledger unavailable | wallet 503 `ENGINE_UNAVAILABLE` → stale, fail-closed |
| 06 | Dev login failed | mock-login 503 → persistent failure banner |
| 07 | Purchase in flight | confirm POST held pending → BUYING…, all buttons locked |
| 08 | Purchase settled | intent → confirm → wallet re-read returns credited balances |
| 09 | Purchase declined | initiate 402 `PAYMENT_DECLINED` → error toast |
| 10 | Spin animation | reels spinning, button locked |

## Determinism guarantees

- **Network isolation:** a catch-all route aborts anything that isn't the Next dev server,
  and each spec asserts zero "escaped" requests.
- **Stub fidelity:** envelope builders in `fixtures/gateway-stubs.ts` mirror the gateway's
  `okBody`/`errBody` (nested error codes), the wallet route's verbatim decimal strings, and
  `store.service.ts`'s purchase/confirm payloads — the same shapes the unit suite asserts.
- **Frozen motion:** contexts run with `reducedMotion: "reduce"` so captures don't race
  animations.
- **Sequential:** one worker, one dev server, numbered states — before/after diffs line up
  across tasks.
