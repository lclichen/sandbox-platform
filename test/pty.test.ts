/**
 * R2 PTY WebSocket integration tests.
 *
 * Spins a real HTTP server (supertest cannot upgrade WebSockets), attaches the
 * PTY bridge, and drives it with a `ws` client against the MockExecutor's echo
 * terminal. Covers the frame protocol, owner isolation, per-container limits,
 * and session accounting.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { setupTestApp, teardownTestApp, adminToken, createUserAndLogin, type TestContext } from "./helper.ts";
import { attachPtyServer } from "../src/routes/pty.ts";
import { getExecutor } from "../src/executors/factory.ts";

let ctx: TestContext;
let server: Server;
let baseUrl: string;

interface Frame {
  type: string;
  data?: string;
  code?: number | null;
}

function connect(token: string | undefined, containerId: number): Promise<{ ws: WebSocket; frames: Frame[] }> {
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/containers/${containerId}/pty${
    token ? `?token=${encodeURIComponent(token)}` : ""
  }`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames: Frame[] = [];
    ws.on("message", (raw: Buffer) => frames.push(JSON.parse(raw.toString("utf8")) as Frame));
    ws.on("open", () => resolve({ ws, frames }));
    ws.on("error", (err: Error) => reject(err));
    ws.on("unexpected-response", (_req, res) => {
      reject(
        Object.assign(new Error(`unexpected response ${res.statusCode}`), {
          statusCode: res.statusCode,
        }),
      );
    });
  });
}

/** Wait for the frame at index `from` to arrive (frames arrive in order). */
function frameAt(frames: Frame[], from = 0, timeoutMs = 3000): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const began = Date.now();
    const poll = setInterval(() => {
      if (frames.length > from) {
        clearInterval(poll);
        resolve(frames[from]);
      } else if (Date.now() - began > timeoutMs) {
        clearInterval(poll);
        reject(new Error("timed out waiting for frame"));
      }
    }, 25);
  });
}

/** Wait for the first frame of `type` (e.g. the exit frame after echo chatter). */
function frameOfType(frames: Frame[], type: string, timeoutMs = 3000): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const began = Date.now();
    const poll = setInterval(() => {
      const hit = frames.find((f) => f.type === type);
      if (hit) {
        clearInterval(poll);
        resolve(hit);
      } else if (Date.now() - began > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`timed out waiting for ${type} frame`));
      }
    }, 25);
  });
}

async function createRunningContainer(token: string): Promise<number> {
  const images = await ctx.request().get("/api/v1/images").set("Authorization", `Bearer ${token}`);
  const imageId = images.body.images[0].id as number;
  const res = await ctx
    .request()
    .post("/api/v1/containers")
    .set("Authorization", `Bearer ${token}`)
    .send({ imageId, name: `pty-c-${Date.now()}` });
  if (res.status !== 201) throw new Error(`container create failed: ${JSON.stringify(res.body)}`);
  return res.body.id as number;
}

describe("R2 PTY WebSocket", () => {
  beforeEach(async () => {
    ctx = await setupTestApp();
    server = createServer(ctx.app);
    attachPtyServer(server, { db: ctx.db, executor: await getExecutor() });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    // Force-terminate any lingering sockets (a failed assertion can leave a
    // live WebSocket that would otherwise hold server.close() open forever).
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await teardownTestApp(ctx);
  });

  it("completes the ready → echo → exit frame protocol", async () => {
    const token = await createUserAndLogin(ctx, "ptyuser");
    const containerId = await createRunningContainer(token);
    const { ws, frames } = await connect(token, containerId);

    const ready = await frameAt(frames, 0);
    expect(ready.type).toBe("ready");

    ws.send(JSON.stringify({ type: "input", data: "echo hi\n" }));
    const output = await frameAt(frames, 1);
    expect(output.type).toBe("output");
    expect(output.data).toContain("echo hi");

    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    ws.send(JSON.stringify({ type: "input", data: "exit\n" }));
    const exit = await frameOfType(frames, "exit");
    expect(exit.code).toBe(0);

    await new Promise<void>((resolve) => ws.on("close", () => resolve()));
  });

  it("rejects upgrades without a token (401)", async () => {
    const token = await createUserAndLogin(ctx, "ptyanon");
    const containerId = await createRunningContainer(token);
    await expect(connect(undefined, containerId)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("hides other users' containers (404)", async () => {
    const owner = await createUserAndLogin(ctx, "ptyowner");
    const containerId = await createRunningContainer(owner);
    const stranger = await createUserAndLogin(ctx, "ptystranger");
    await expect(connect(stranger, containerId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses terminals on non-running containers (409)", async () => {
    const token = await createUserAndLogin(ctx, "ptystop");
    const containerId = await createRunningContainer(token);
    await ctx.request().post(`/api/v1/containers/${containerId}/stop`).set("Authorization", `Bearer ${token}`);
    await expect(connect(token, containerId)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("enforces the per-container concurrent limit (429)", async () => {
    process.env.PTY_MAX_PER_CONTAINER = "2";
    const { resetConfigForTesting } = await import("../src/config.ts");
    resetConfigForTesting();
    const token = await createUserAndLogin(ctx, "ptylimit");
    const containerId = await createRunningContainer(token);

    const a = await connect(token, containerId);
    await frameAt(a.frames, 0);
    const b = await connect(token, containerId);
    await frameAt(b.frames, 0);
    await expect(connect(token, containerId)).rejects.toMatchObject({ statusCode: 429 });

    a.ws.close();
    b.ws.close();
    delete process.env.PTY_MAX_PER_CONTAINER;
    resetConfigForTesting();
    // Give the server a moment to settle the two session rows.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  it("records the session in the sessions audit table with byte counts", async () => {
    const token = await createUserAndLogin(ctx, "ptyaudit");
    const containerId = await createRunningContainer(token);
    const { ws, frames } = await connect(token, containerId);
    await frameAt(frames, 0); // ready
    ws.send(JSON.stringify({ type: "input", data: "hello\n" }));
    await frameAt(frames, 1); // echo output
    ws.send(JSON.stringify({ type: "input", data: "exit\n" }));
    await frameOfType(frames, "exit");
    await new Promise<void>((resolve) => ws.on("close", () => resolve()));
    // closeSession is fire-and-forget; allow it to land.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const row = await ctx.db.get<{ container_id: number; bytes_in: number; bytes_out: number; ended_at: string | null }>(
      "SELECT container_id, bytes_in, bytes_out, ended_at FROM sessions ORDER BY id DESC LIMIT 1",
    );
    expect(row?.container_id).toBe(containerId);
    expect(Number(row?.bytes_in)).toBeGreaterThan(0);
    expect(Number(row?.bytes_out)).toBeGreaterThan(0);
    expect(row?.ended_at).toBeTruthy();
  });

  it("admin can open a terminal on a user's container", async () => {
    const user = await createUserAndLogin(ctx, "ptynormal");
    const containerId = await createRunningContainer(user);
    const admin = await adminToken(ctx);
    const { ws, frames } = await connect(admin, containerId);
    const ready = await frameAt(frames, 0);
    expect(ready.type).toBe("ready");
    ws.close();
  });
});
