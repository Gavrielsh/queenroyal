# ──────────────────────────────────────────────────────────────────────────────
# financial-gateway — production image (multi-stage). Supporting artifact for
# infra/docker-compose.staging.yml. The build context is this app directory (it is
# self-contained: its own package-lock.json + Prisma schema).
# ──────────────────────────────────────────────────────────────────────────────

FROM node:20-alpine AS builder
WORKDIR /app
# Install the FULL dependency tree (incl. the Prisma CLI + tsc) for generate + build.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Generate the Prisma client, then compile strict TypeScript → dist/.
RUN npx prisma generate && npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Carry over the resolved deps (with the generated Prisma client + the CLI used for
# `prisma db push`/`migrate deploy`), the compiled output, and the schema.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
# Drop root.
USER node
EXPOSE 8080
# server.ts traps SIGTERM/SIGINT for the graceful drain. The compose service sets `init: true`
# so those signals are actually delivered to node rather than swallowed by PID 1.
CMD ["node", "dist/server.js"]
