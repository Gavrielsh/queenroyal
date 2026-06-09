-- ──────────────────────────────────────────────────────────────────────────────
-- Pin the staging role to the EXACT SCRAM-SHA-256 verifier that PgBouncer's
-- infra/bouncer/userlist.txt also stores. The verifier on BOTH sides must be
-- byte-identical so PgBouncer can authenticate to Postgres via SCRAM pass-through —
-- with NO plaintext and NO md5 secret stored anywhere.
--
-- The postgres entrypoint first creates this role from POSTGRES_PASSWORD (which yields
-- a verifier with a RANDOM salt); this init script then overwrites it with our known,
-- fixed-salt verifier so it matches the pooler. Runs only on first volume init.
--
-- Represents password "queenroyal_dev_pw" — a DUMMY staging credential. Never reuse it.
-- ──────────────────────────────────────────────────────────────────────────────
ALTER ROLE queenroyal
  PASSWORD 'SCRAM-SHA-256$4096:obLD1OX2BxgpOktcbX6PkA==$dvDoAt/iK6Rnz07GHW2Kj3w67liRrLADaImA9sqhqGM=:QU90yaUjBz6wk91Yo7KSaeBJ3t1lAlHXZAmJHT4mpZo=';
