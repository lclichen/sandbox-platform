/**
 * The production mock-executor guard (assertSecureProductionConfig) must keep
 * refusing NODE_ENV=production + EXECUTOR_KIND=mock by default, but allow the
 * explicit smoke-test escape hatch ALLOW_MOCK_EXECUTOR_IN_PRODUCTION=1 — the
 * tar/AppImage packaging smoke tests boot the platform exactly that way
 * (mock needs no apptainer and no compute node).
 */
import { describe, it, expect, afterEach } from "vitest";
import { loadConfig, resetConfigForTesting, assertSecureProductionConfig } from "../src/config.ts";

const SAVED_ENV = ["NODE_ENV", "EXECUTOR_KIND", "ALLOW_MOCK_EXECUTOR_IN_PRODUCTION", "JWT_SECRET", "SEED_ADMIN_PASSWORD", "SEED_ADMIN_USERNAME"];
const saved: Record<string, string | undefined> = {};
for (const key of SAVED_ENV) saved[key] = process.env[key];

function restoreEnv(): void {
  for (const key of SAVED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetConfigForTesting();
}

afterEach(restoreEnv);

function baseProductionEnv(): void {
  process.env.NODE_ENV = "production";
  process.env.EXECUTOR_KIND = "mock";
  process.env.JWT_SECRET = "a".repeat(64);
  process.env.SEED_ADMIN_USERNAME = "admin";
  process.env.SEED_ADMIN_PASSWORD = "Smoke-NotDefault-9x";
  delete process.env.ALLOW_MOCK_EXECUTOR_IN_PRODUCTION;
}

describe("production mock-executor guard", () => {
  it("refuses EXECUTOR_KIND=mock in production by default", () => {
    baseProductionEnv();
    const config = loadConfig();
    const problems = assertSecureProductionConfig(config);
    expect(problems.some((p) => p.includes("EXECUTOR_KIND=mock"))).toBe(true);
  });

  it("allows it with ALLOW_MOCK_EXECUTOR_IN_PRODUCTION=1 (packaging smoke)", () => {
    baseProductionEnv();
    process.env.ALLOW_MOCK_EXECUTOR_IN_PRODUCTION = "1";
    const config = loadConfig();
    const problems = assertSecureProductionConfig(config);
    expect(problems.some((p) => p.includes("EXECUTOR_KIND=mock"))).toBe(false);
  });

  it("never complains about mock outside production", () => {
    process.env.NODE_ENV = "development";
    process.env.EXECUTOR_KIND = "mock";
    const config = loadConfig();
    expect(assertSecureProductionConfig(config)).toEqual([]);
  });
});
