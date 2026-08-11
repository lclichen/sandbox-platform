/**
 * Reversible symmetric encryption for secrets that must be returned to the
 * caller later (e.g. LiteLLM virtual-key plaintext, which is needed to drive
 * LLM traffic from containers). This complements the one-way hashing used for
 * platform API keys (see apikey.service.ts) — anything we must hand back in
 * the clear cannot be hashed.
 *
 * Algorithm: AES-256-GCM (authenticated). The 32-byte key is supplied as 64
 * hex chars. Each ciphertext carries its own random 12-byte IV and 16-byte
 * auth tag, so the same plaintext encrypts to a different payload every time
 * and tampering is rejected on decrypt.
 *
 * Wire format: three base64 segments joined by ":" —  "<iv>:<ciphertext>:<tag>".
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { HttpError } from "./errors.ts";

const IV_BYTES = 12;
const KEY_BYTES = 32;
const KEY_HEX_LEN = KEY_BYTES * 2; // 64

/** A hex-encoded 32-byte key (64 hex chars). */
export type EncryptionKey = string;

/** True when `v` looks like a 32-byte key in hex. */
export function isValidKeyHex(v: unknown): v is EncryptionKey {
  return typeof v === "string" && v.length === KEY_HEX_LEN && /^[0-9a-fA-F]+$/.test(v);
}

/**
 * Encrypt a UTF-8 string under `keyHex`. Returns "<iv>:<ct>:<tag>" with each
 * segment base64-encoded. Safe to store in a single TEXT column.
 */
export function encrypt(plaintext: string, keyHex: EncryptionKey): string {
  if (!isValidKeyHex(keyHex)) {
    throw new HttpError(500, "llm_not_configured", "LLM_ENCRYPTION_KEY must be 64 hex chars (32 bytes).");
  }
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), ct.toString("base64"), tag.toString("base64")].join(":");
}

/**
 * Decrypt a payload produced by {@link encrypt}. Throws on a malformed payload,
 * a wrong key (auth-tag mismatch), or corrupted ciphertext.
 */
export function decrypt(payload: string, keyHex: EncryptionKey): string {
  if (!isValidKeyHex(keyHex)) {
    throw new HttpError(500, "llm_not_configured", "LLM_ENCRYPTION_KEY must be 64 hex chars (32 bytes).");
  }
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new HttpError(500, "decrypt_failed", "Malformed ciphertext payload.");
  }
  const [ivB64, ctB64, tagB64] = parts;
  let iv: Buffer;
  let ct: Buffer;
  let tag: Buffer;
  try {
    iv = Buffer.from(ivB64, "base64");
    ct = Buffer.from(ctB64, "base64");
    tag = Buffer.from(tagB64, "base64");
  } catch {
    throw new HttpError(500, "decrypt_failed", "Ciphertext segments are not valid base64.");
  }
  if (iv.length !== IV_BYTES || tag.length !== 16) {
    throw new HttpError(500, "decrypt_failed", "IV or auth tag has unexpected length.");
  }
  const key = Buffer.from(keyHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new HttpError(500, "decrypt_failed", "Authentication failed: wrong key or tampered ciphertext.");
  }
  return plain.toString("utf8");
}

/** Generate a fresh 32-byte key as 64 lowercase hex chars. */
export function generateKeyHex(): EncryptionKey {
  return randomBytes(KEY_BYTES).toString("hex");
}
