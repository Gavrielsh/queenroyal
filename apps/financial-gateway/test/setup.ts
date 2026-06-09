// Vitest global setup. Provide safe, non-secret defaults so the fail-closed `getEnv()` can
// parse during unit/smoke tests. Real values are injected by the environment in CI /
// integration runs. Uses `??=` so an explicitly-set env (e.g. a real test DB) always wins.
process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test?schema=public";
