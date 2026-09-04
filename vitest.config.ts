import { defineConfig } from "vitest/config";

export default defineConfig({
  // Ensure Node built-in modules (including the experimental `node:sqlite`)
  // are externalized rather than transformed by Vite's dep optimizer.
  server: { deps: { external: [/^node:/] } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    server: { deps: { external: [/^node:/, /^better-sqlite3$/] } },
    hookTimeout: 30000,
    testTimeout: 30000,
    // Lifecycle tests use the mock executor against the SEEDED demo images —
    // the squashed baseline does not seed them for real deployments; keep
    // them for tests.
    env: { SEED_DEMO_IMAGES: "on" },
    pool: "forks",
    singleFork: true, // node:sqlite + WAL plays safest single-process
  },
});
