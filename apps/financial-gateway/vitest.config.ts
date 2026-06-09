import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    // Liveness/health tests must never depend on a real socket, DB, or Redis.
    clearMocks: true,
  },
});
