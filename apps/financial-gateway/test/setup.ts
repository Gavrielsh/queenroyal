// Vitest global setup. Provide safe, non-secret defaults so the fail-closed `getEnv()` can
// parse during unit/smoke tests. Real values are injected by the environment in CI /
// integration runs. Uses `??=` so an explicitly-set env (e.g. a real test DB) always wins.
process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test?schema=public";

// Outbound True Engine + inbound webhook secrets (the gateway env fails closed without them).
process.env.ENGINE_BASE_URL ??= "http://engine.test";
process.env.ENGINE_SECRET_KEY ??= "test-engine-secret-key-0123456789";
process.env.ENGINE_OPERATOR_CODE ??= "TEST_OP";
process.env.PROVIDER_WEBHOOK_SECRETS ??= '{"PRAGMATIC":"test-provider-secret"}';
process.env.PSP_WEBHOOK_SECRET ??= "test-psp-secret";

// Auth (JWT). A fixed test secret so tests can mint/verify access tokens deterministically.
process.env.JWT_SECRET ??= "test-jwt-secret-0123456789abcdef";
process.env.JWT_ACCESS_TTL ??= "15m";

// Jurisdiction enforcement is ON by default and fails closed, so without a
// simulated trusted edge every player-facing route test would 403 on
// `no_trusted_edge`. Route tests are about routing, auth, and validation —
// the fence's own behaviour (blocked states, spoofed headers, fail-closed
// paths) is covered directly in test/geo.test.ts against an explicit policy.
process.env.GEO_ENFORCEMENT_DISABLED ??= "disabled";
