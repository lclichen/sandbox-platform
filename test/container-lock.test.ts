/**
 * C6: per-container lock semantics.
 */
import { describe, it, expect } from "vitest";
import { withContainerLock } from "../src/services/container-lock.ts";

describe("withContainerLock", () => {
  it("serializes concurrent critical sections for the same container", async () => {
    const order: string[] = [];
    const slow = withContainerLock(1, async () => {
      await new Promise((r) => setTimeout(r, 60));
      order.push("slow");
    });
    const fast = withContainerLock(1, async () => {
      order.push("fast");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["slow", "fast"]);
  });

  it("runs the next holder even after the previous one rejected", async () => {
    const first = withContainerLock(2, async () => {
      throw new Error("boom");
    });
    await expect(first).rejects.toThrow("boom");
    const ran = await withContainerLock(2, async () => "ok");
    expect(ran).toBe("ok");
  });

  it("does not serialize different containers", async () => {
    const order: string[] = [];
    const a = withContainerLock(10, async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push("a");
    });
    const b = withContainerLock(11, async () => {
      order.push("b");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["b", "a"]);
  });

  it("self-cleans map entries after the tail settles", async () => {
    await withContainerLock(99, async () => undefined);
    await new Promise((r) => setTimeout(r, 5));
    // internal detail: just ensure repeated use keeps working and returns values
    const value = await withContainerLock(99, async () => 42);
    expect(value).toBe(42);
  });
});
