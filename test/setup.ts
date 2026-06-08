// Vitest setup: deterministic env for the gateway, plus the global fetch mock install.
process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-16-chars";
process.env.ENGINE_BASE_URL = "http://engine.test";
process.env.ENGINE_SECRET_KEY = "test-engine-secret-at-least-16-chars";
process.env.ENGINE_OPERATOR_CODE = "QUEENROYAL";
process.env.PROVIDER_WEBHOOK_SECRETS = '{"PRAGMATIC":"test-provider-secret"}';

// Side-effect: installs the programmable fetch mock onto global.fetch.
import "./fakes/engine.fake";
