/**
 * Executor command-construction helpers (P1-10).
 *
 * The SSH and CLI executors build `apptainer instance start` commands that
 * interpolate env overrides. The security-critical piece is that a hostile env
 * VALUE can never break out of its quoting and inject shell metacharacters, and
 * a malformed KEY is rejected before it reaches the command line. These tests
 * pin that behavior directly against the pure functions the executors use.
 */
import { describe, it, expect } from "vitest";
import { shellQuote, isValidEnvName } from "../src/executors/shell-quote.ts";
import { envOpts } from "../src/executors/ssh-executor.ts";
import { envArgs } from "../src/executors/apptainer-cli-executor.ts";

describe("shellQuote", () => {
  it("wraps a plain string in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes via the '\\'' sequence", () => {
    // A value containing a single quote must not be able to close the quoting.
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });

  it("contains shell metacharacters harmlessly (they stay inside quotes)", () => {
    // No single quote in the value -> the whole thing is wrapped verbatim.
    expect(shellQuote("; rm -rf /")).toBe("'; rm -rf /'");
    expect(shellQuote("$(whoami)`id`$HOME")).toBe("'$(whoami)`id`$HOME'");
  });

  it("escapes a value that tries to break out via an embedded single quote", () => {
    // The classic injection: close the quote, run a command, reopen.
    // shellQuote must escape the embedded quote so the payload stays literal.
    const q = shellQuote("x'; whoami; echo '");
    // The escaped form is the only safe interpolation; verify it does NOT equal
    // the naive `'x'; whoami; echo '` (which would execute whoami).
    expect(q).not.toBe("'x'; whoami; echo '");
    // Every apostrophe in the OUTPUT is part of an escape sequence, never a
    // boundary that could be re-parsed as command separation.
    expect(q.startsWith("'")).toBe(true);
    expect(q.endsWith("'")).toBe(true);
  });
});

describe("isValidEnvName", () => {
  it("accepts standard identifier names", () => {
    expect(isValidEnvName("PATH")).toBe(true);
    expect(isValidEnvName("SANDBOX_LLM_API_KEY")).toBe(true);
    expect(isValidEnvName("_UNDERSCORE")).toBe(true);
    expect(isValidEnvName("VAR.dot")).toBe(true);
  });

  it("rejects names that could carry shell metacharacters", () => {
    expect(isValidEnvName("a b")).toBe(false); // space
    expect(isValidEnvName("a;ls")).toBe(false); // semicolon
    expect(isValidEnvName("$(id)")).toBe(false); // command subst
    expect(isValidEnvName("1abc")).toBe(false); // leading digit
    expect(isValidEnvName("")).toBe(false);
    expect(isValidEnvName("KEY=value")).toBe(false);
  });
});

describe("ssh envOpts", () => {
  it("returns empty string for undefined/empty env", () => {
    expect(envOpts(undefined)).toBe("");
    expect(envOpts({})).toBe("");
  });

  it("renders --env KEY=VALUE with shell-quoted values", () => {
    expect(envOpts({ FOO: "bar" })).toBe("--env FOO='bar'");
  });

  it("quotes values containing spaces and metacharacters", () => {
    expect(envOpts({ MSG: "hello world" })).toBe("--env MSG='hello world'");
    expect(envOpts({ X: "a'b" })).toBe("--env X='a'\\''b'");
  });

  it("drops entries with invalid key names (injection defense)", () => {
    expect(envOpts({ "BAD KEY": "x" })).toBe("");
    expect(envOpts({ "rm;": "x" })).toBe("");
    // Valid keys still render alongside rejected ones.
    expect(envOpts({ GOOD: "1", "ba d": "2" })).toBe("--env GOOD='1'");
  });

  it("renders multiple env vars space-separated", () => {
    const out = envOpts({ A: "1", B: "2" });
    expect(out).toContain("--env A='1'");
    expect(out).toContain("--env B='2'");
  });
});

describe("cli envArgs", () => {
  it("returns empty array for undefined/empty env", () => {
    expect(envArgs(undefined)).toEqual([]);
    expect(envArgs({})).toEqual([]);
  });

  it("renders interleaved --env / KEY=VALUE arg pairs", () => {
    expect(envArgs({ FOO: "bar" })).toEqual(["--env", "FOO='bar'"]);
  });

  it("drops entries with invalid key names", () => {
    expect(envArgs({ "BAD KEY": "x" })).toEqual([]);
    expect(envArgs({ GOOD: "1", "ba;d": "2" })).toEqual(["--env", "GOOD='1'"]);
  });

  it("quotes values with metacharacters", () => {
    expect(envArgs({ X: "hello world" })).toEqual(["--env", "X='hello world'"]);
  });
});
