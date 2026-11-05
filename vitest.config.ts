import { defineConfig } from "vitest/config";

/**
 * NOTE: `vite` is declared directly in devDependencies on purpose. Vitest
 * needs a Vite engine, and installing Vite 8 pulls in `lightningcss` (MPL-2.0).
 * Pinning the direct dev dependency to Vite 7 keeps the test engine on the
 * MIT-licensed Vite/rollup/esbuild stack while the platform itself has no
 * frontend at all.
 */
export default defineConfig({
  // Ensure Node built-in modules (including the experimental `node:sqlite`)
  // are externalized rather than transformed by Vite's dep optimizer.
  server: { deps: { external: [/^node:/] } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    server: { deps: { external: [/^node:/] } },
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
