/**
 * AES-256-GCM encrypt/decrypt round-trip and failure modes.
 */
import { describe, it, expect } from "vitest";
import { encrypt, decrypt, isValidKeyHex, generateKeyHex } from "../src/utils/crypto.ts";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("crypto helpers", () => {
  it("generateKeyHex produces 64 lowercase hex chars", () => {
    const k = generateKeyHex();
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(isValidKeyHex(k)).toBe(true);
  });

  it("isValidKeyHex rejects wrong length and non-hex", () => {
    expect(isValidKeyHex("nope")).toBe(false);
    expect(isValidKeyHex(KEY.slice(0, 62))).toBe(false);
    expect(isValidKeyHex(KEY.toUpperCase())).toBe(true); // uppercase hex accepted
  });

  it("round-trips a plaintext", () => {
    const plain = "sk-litellm-abcdef123456";
    const payload = encrypt(plain, KEY);
    // Format: iv:ct:tag, three base64 segments.
    expect(payload.split(":")).toHaveLength(3);
    expect(payload).not.toContain(plain);
    expect(decrypt(payload, KEY)).toBe(plain);
  });

  it("produces a different ciphertext for the same plaintext (random IV)", () => {
    const a = encrypt("same-secret", KEY);
    const b = encrypt("same-secret", KEY);
    expect(a).not.toBe(b);
    expect(decrypt(a, KEY)).toBe("same-secret");
    expect(decrypt(b, KEY)).toBe("same-secret");
  });

  it("decrypt fails with a wrong key (auth tag mismatch)", () => {
    const payload = encrypt("hello", KEY);
    const otherKey = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    expect(() => decrypt(payload, otherKey)).toThrow(/Authentication failed/);
  });

  it("decrypt rejects a tampered ciphertext", () => {
    const payload = encrypt("hello", KEY);
    const [iv, ct, tag] = payload.split(":");
    // Flip a char in the ciphertext segment.
    const tampered = `${iv}:${ct.slice(0, -2) + "ZZ"}:${tag}`;
    expect(() => decrypt(tampered, KEY)).toThrow(/Authentication failed|Malformed|base64|length/);
  });

  it("decrypt rejects a malformed payload (wrong segment count)", () => {
    expect(() => decrypt("only-one-segment", KEY)).toThrow(/Malformed/);
  });

  it("encrypt refuses an invalid key", () => {
    expect(() => encrypt("x", "too-short")).toThrow(/LLM_ENCRYPTION_KEY/);
  });
});
