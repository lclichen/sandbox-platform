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
    pool: "forks",
    singleFork: true, // node:sqlite + WAL plays safest single-process
  },
});
