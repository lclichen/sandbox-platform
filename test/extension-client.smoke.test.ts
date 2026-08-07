/**
 * Milestone 8 integration smoke test.
 *
 * Drives the real sandbox-platform HTTP server (MockExecutor-backed) using the
 * pi-sandbox-extension's PlatformClient to validate the extension <-> platform
 * contract end-to-end: login, list containers, create+connect one, then run a
 * tool write -> read -> bash round-trip exactly as the extension would.
 *
 * This does not load pi itself (that requires the pi toolchain); it verifies
 * the REST client the extension relies on. The operation-interface adapters
 * in the extension are thin pass-throughs to this client.
 */
import { describe, it, expect, afterEach } from "vitest";
import { setupTestApp, teardownTestApp, adminToken, type TestContext } from "./helper.ts";
import { PlatformClient } from "../../pi-sandbox-extension/lib/client.ts";
import { loadConfig, saveConfig, resetConfigCache } from "../../pi-sandbox-extension/lib/config.ts";

let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) {
    await teardownTestApp(ctx);
    ctx = undefined;
  }
  resetConfigCache();
});

describe("pi-sandbox-extension client <-> platform", () => {
  it("logs in, creates + connects a container, and routes tool ops", async () => {
    ctx = await setupTestApp();
    const base = `http://127.0.0.1:${0}`; // placeholder; we drive via the app's port below

    // The extension talks to a real URL. Point its config at the live server by
    // reading the port the supertest app actually listens on. supertest does not
    // bind eagerly, so we exercise the client against the Express app via a
    // fetch shim is not trivial. Instead, start the real HTTP server on an
    // ephemeral port and drive the extension client against it.
    void base;

    const { createApp } = await import("../src/app.ts");
    const http = (await import("node:http")).default;
    const server = http.createServer((await createApp({ db: ctx.db, executor: ctx.app.locals.executor })).app);
    await new Promise<void>((resolveFn) => server.listen(0, "127.0.0.1", resolveFn));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const url = `http://127.0.0.1:${port}`;

    try {
      // Use a temp config so we don't touch the user's real global config.
      saveConfig({ url, token: undefined, refreshToken: undefined, username: undefined });
      const config = loadConfig(process.cwd());
      const client = new PlatformClient(config);

      // Login as admin (seeded).
      await client.login("admin", "changeme123");
      const me = await client.me();
      expect(me.username).toBe("admin");

      // Create a container via the extension client's helper.
      const images = await client.request<{ images: Array<{ id: number; name: string }> }>("/api/v1/admin/images");
      const imageId = images.images[0].id;
      const created = await client.createContainer({ imageId, name: "ext-box" });
      expect(created.id).toBeTypeOf("number");

      const info = await client.connectContainer(created.id);
      expect(info.sessionId).toBeTypeOf("number");
      expect(info.instanceName).toBeTypeOf("string");

      // Tool round-trip: write then read.
      await client.toolWrite(created.id, "greeting.txt", Buffer.from("hi from extension", "utf8"));
      const data = await client.toolRead(created.id, "greeting.txt");
      expect(data.toString("utf8")).toBe("hi from extension");

      // Tool bash.
      const bash = await client.toolBash(created.id, "echo via-platform");
      expect(bash.exitCode).toBe(0);
      expect(bash.stdout.trim()).toBe("via-platform");

      // Tool ls + grep + find.
      const ls = await client.toolLs(created.id, ".");
      expect(ls.map((e) => e.name)).toContain("greeting.txt");
      const grep = await client.toolGrep(created.id, { pattern: "hi from", path: "." });
      expect(grep).toContain("hi from extension");
      const find = await client.toolFind(created.id, { pattern: "greeting.txt", path: "." });
      expect(find.join("\n")).toContain("greeting.txt");
    } finally {
      await new Promise<void>((resolveFn) => server.close(() => resolveFn()));
    }
  });

  it("refreshes the token automatically on 401", async () => {
    ctx = await setupTestApp();
    const { createApp } = await import("../src/app.ts");
    const http = (await import("node:http")).default;
    const server = http.createServer((await createApp({ db: ctx.db, executor: ctx.app.locals.executor })).app);
    await new Promise<void>((resolveFn) => server.listen(0, "127.0.0.1", resolveFn));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const url = `http://127.0.0.1:${port}`;

    try {
      saveConfig({ url });
      const config = loadConfig(process.cwd());
      const client = new PlatformClient(config);
      await client.login("admin", "changeme123");

      // Corrupt the access token to force a 401; the refresh path should kick in.
      config.token = "invalid.token.value";
      const me = await client.me(); // should auto-refresh and succeed
      expect(me.username).toBe("admin");
    } finally {
      await new Promise<void>((resolveFn) => server.close(() => resolveFn()));
    }
  });
});

// Reference adminToken to keep the import meaningful for future assertions.
void adminToken;
