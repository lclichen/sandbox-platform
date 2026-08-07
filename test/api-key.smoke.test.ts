/**
 * Extension <-> platform smoke test for API-key auth + auto container creation.
 *
 * Drives the real HTTP server (MockExecutor) with the extension's PlatformClient
 * to prove: (1) an API key authenticates every call, (2) listImages/createContainer
 * work end-to-end so the CLI auto-provision flow is wired correctly.
 */
import { describe, it, expect, afterEach } from "vitest";
import { setupTestApp, teardownTestApp, adminToken, type TestContext } from "./helper.ts";
import { PlatformClient } from "../../pi-sandbox-extension/lib/client.ts";
import { loadConfig, saveConfig, resetConfigCache } from "../../pi-sandbox-extension/lib/config.ts";
import { createApp } from "../src/app.ts";
import http from "node:http";

let ctx: TestContext | undefined;
let server: http.Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  if (ctx) await teardownTestApp(ctx);
  ctx = undefined;
  resetConfigCache();
});

async function startServer(ctx: TestContext): Promise<string> {
  const { app } = await createApp({ db: ctx.db, executor: ctx.app.locals.executor });
  server = http.createServer(app);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

describe("extension API-key + auto-create", () => {
  it("creates a key via the client and uses it for all calls", async () => {
    ctx = await setupTestApp();
    const url = await startServer(ctx);
    // Log in once as admin to obtain a key (admin can also create containers).
    saveConfig({ url });
    const config = loadConfig(process.cwd());
    const client = new PlatformClient(config);
    await client.login("admin", "changeme123");
    const created = await client.createApiKey("ci");
    expect(created.key).toMatch(/^sk_[0-9a-f]{32}$/);

    // Switch the client to API-key-only auth (drop JWT).
    client.config.token = undefined;
    client.config.refreshToken = undefined;
    client.config.apiKey = created.key;

    const me = await client.me();
    expect(me.username).toBe("admin");

    // listImages (public endpoint) works under the API key.
    const images = await client.listImages();
    expect(images.length).toBeGreaterThan(0);

    // createContainer works under the API key (owner = admin).
    const box = await client.createContainer({
      imageId: images[0].id,
      name: "apikey-box",
      cpu: images[0].default_resources?.cpu,
      memoryMb: images[0].default_resources?.memoryMb,
      diskGb: images[0].default_resources?.diskGb,
    });
    expect(box.id).toBeTypeOf("number");

    // Tool round-trip under the API key.
    await client.toolWrite(box.id, "k.txt", Buffer.from("ok", "utf8"));
    const data = await client.toolRead(box.id, "k.txt");
    expect(data.toString("utf8")).toBe("ok");
  });

  it("revoking the key invalidates further client calls", async () => {
    ctx = await setupTestApp();
    const url = await startServer(ctx);
    saveConfig({ url });
    const client = new PlatformClient(loadConfig(process.cwd()));
    await client.login("admin", "changeme123");
    const created = await client.createApiKey("temp");
    client.config.token = undefined;
    client.config.refreshToken = undefined;
    client.config.apiKey = created.key;

    // Works before revocation.
    expect((await client.me()).username).toBe("admin");

    await client.revokeApiKey(created.id);

    // After revocation, /me must fail (no refresh path since apiKey set).
    await expect(client.me()).rejects.toThrow();
  });
});

// keep helper imports referenced
void adminToken;
