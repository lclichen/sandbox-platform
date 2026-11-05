/**
 * Guards the env-configurable limit defaults documented in docs/LIMITS.md.
 * A change here is a contract change for operators — update the doc with it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, resetConfigForTesting } from "../src/config.ts";

const KEYS = [
  "WORKSPACE_UPLOAD_MAX_BYTES",
  "WORKSPACE_UPLOAD_PART_MAX_BYTES",
  "TOOLS_WALK_TIMEOUT_MS",
  "TOOLS_BASH_OUTPUT_MAX_BYTES",
  "RATE_LIMIT_OIDC_PER_MINUTE",
  "RATE_LIMIT_CHANGE_PASSWORD_PER_MINUTE",
  "PTY_MAX_FRAME_BYTES",
  "CONTAINER_MAX_INPUT_MOUNTS",
] as const;

beforeAll(() => {
  for (const key of KEYS) delete process.env[key];
  resetConfigForTesting();
});

afterAll(() => {
  for (const key of KEYS) delete process.env[key];
  resetConfigForTesting();
});

describe("configurable limits", () => {
  it("uses the documented defaults", () => {
    const cfg = loadConfig();
    expect(cfg.workspace.uploadMaxBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(cfg.workspace.uploadPartMaxBytes).toBe(8 * 1024 * 1024);
    expect(cfg.tools.walkTimeoutMs).toBe(60_000);
    expect(cfg.tools.bashOutputMaxBytes).toBe(8 * 1024 * 1024);
    expect(cfg.rateLimit.oidcPerMinute).toBe(300);
    expect(cfg.rateLimit.changePasswordPerMinute).toBe(5);
    expect(cfg.pty.maxFrameBytes).toBe(1024 * 1024);
    expect(cfg.mounts.maxInputs).toBe(32);
  });

  it("reads overrides from the environment", () => {
    process.env.WORKSPACE_UPLOAD_MAX_BYTES = String(3 * 1024 * 1024 * 1024);
    process.env.WORKSPACE_UPLOAD_PART_MAX_BYTES = String(16 * 1024 * 1024);
    process.env.TOOLS_WALK_TIMEOUT_MS = "120000";
    process.env.TOOLS_BASH_OUTPUT_MAX_BYTES = String(16 * 1024 * 1024);
    process.env.RATE_LIMIT_OIDC_PER_MINUTE = "500";
    process.env.RATE_LIMIT_CHANGE_PASSWORD_PER_MINUTE = "9";
    process.env.PTY_MAX_FRAME_BYTES = String(2 * 1024 * 1024);
    process.env.CONTAINER_MAX_INPUT_MOUNTS = "12";
    resetConfigForTesting();

    const cfg = loadConfig();
    expect(cfg.workspace.uploadMaxBytes).toBe(3 * 1024 * 1024 * 1024);
    expect(cfg.workspace.uploadPartMaxBytes).toBe(16 * 1024 * 1024);
    expect(cfg.tools.walkTimeoutMs).toBe(120_000);
    expect(cfg.tools.bashOutputMaxBytes).toBe(16 * 1024 * 1024);
    expect(cfg.rateLimit.oidcPerMinute).toBe(500);
    expect(cfg.rateLimit.changePasswordPerMinute).toBe(9);
    expect(cfg.pty.maxFrameBytes).toBe(2 * 1024 * 1024);
    expect(cfg.mounts.maxInputs).toBe(12);

    for (const key of KEYS) delete process.env[key];
    resetConfigForTesting();
  });
});
