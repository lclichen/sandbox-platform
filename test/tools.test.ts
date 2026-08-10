/**
 * Milestone 5: container tools endpoints E2E.
 *
 * Verifies the relay path that the pi extension will use: write a file via
 * /tools/write, read it back via /tools/read, run bash, ls, grep, find, edit,
 * access, stat. Backed by MockExecutor so win32 can run it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { setupTestApp, teardownTestApp, adminToken, createUserAndLogin, type TestContext } from "./helper.ts";

let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) {
    await teardownTestApp(ctx);
    ctx = undefined;
  }
});

async function newContainer(ctx: TestContext, userToken: string, name: string): Promise<number> {
  const admin = await adminToken(ctx);
  const images = await ctx.request().get("/api/v1/admin/images").set("Authorization", `Bearer ${admin}`);
  const imageId = images.body.images[0].id;
  const res = await ctx
    .request()
    .post("/api/v1/containers")
    .set("Authorization", `Bearer ${userToken}`)
    .send({ imageId, name });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

describe("container tools", () => {
  it("write -> read round-trips file content", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "tooluser1");
    const cid = await newContainer(ctx, token, "tools-box");

    const write = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/write`)
      .set("Authorization", `Bearer ${token}`)
      .send({ path: "notes.txt", content: b64("hello tools") });
    expect(write.status).toBe(200);

    const read = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/read`)
      .set("Authorization", `Bearer ${token}`)
      .send({ path: "notes.txt" });
    expect(read.status).toBe(200);
    expect(Buffer.from(read.body.contentBase64, "base64").toString("utf8")).toBe("hello tools");
    expect(read.body.size).toBe(11);
  });

  it("bash executes and returns stdout", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "tooluser2");
    const cid = await newContainer(ctx, token, "bash-box");
    const res = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/bash`)
      .set("Authorization", `Bearer ${token}`)
      .send({ command: "echo hello-from-bash" });
    expect(res.status).toBe(200);
    expect(res.body.exitCode).toBe(0);
    expect(res.body.stdout.trim()).toBe("hello-from-bash");
  });

  it("bash respects cwd", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "tooluser3");
    const cid = await newContainer(ctx, token, "cwd-box");
    // Create a subdir and pwd into it.
    await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/bash`)
      .set("Authorization", `Bearer ${token}`)
      .send({ command: "mkdir sub && echo x > sub/f.txt" });
    const res = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/bash`)
      .set("Authorization", `Bearer ${token}`)
      .send({ command: process.platform === "win32" ? "cd sub && dir /b" : "ls sub", cwd: "." });
    expect(res.status).toBe(200);
    // Listing the created file via cwd-relative path works.
    expect(res.body.stdout).toContain("f.txt");
  });

  it("ls lists entries; access/stat report existence", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "tooluser4");
    const cid = await newContainer(ctx, token, "ls-box");
    await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/write`)
      .set("Authorization", `Bearer ${token}`)
      .send({ path: "a.txt", content: b64("a") });

    const ls = await ctx
      .request()
      .get(`/api/v1/containers/${cid}/tools/ls?path=.`)
      .set("Authorization", `Bearer ${token}`);
    expect(ls.status).toBe(200);
    expect(ls.body.entries.map((e: { name: string }) => e.name)).toContain("a.txt");

    const access = await ctx
      .request()
      .get(`/api/v1/containers/${cid}/tools/access?path=a.txt`)
      .set("Authorization", `Bearer ${token}`);
    expect(access.body.exists).toBe(true);

    const stat = await ctx
      .request()
      .get(`/api/v1/containers/${cid}/tools/stat?path=a.txt`)
      .set("Authorization", `Bearer ${token}`);
    expect(stat.body.isFile).toBe(true);
    expect(stat.body.size).toBe(1);
  });

  it("edit applies an exact text replacement", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "tooluser5");
    const cid = await newContainer(ctx, token, "edit-box");
    await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/write`)
      .set("Authorization", `Bearer ${token}`)
      .send({ path: "e.txt", content: b64("foo bar baz") });

    const edit = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/edit`)
      .set("Authorization", `Bearer ${token}`)
      .send({ path: "e.txt", oldText: "bar", newText: "QUX" });
    expect(edit.status).toBe(200);
    expect(edit.body.applied).toBe(true);

    const read = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/read`)
      .set("Authorization", `Bearer ${token}`)
      .send({ path: "e.txt" });
    expect(Buffer.from(read.body.contentBase64, "base64").toString("utf8")).toBe("foo QUX baz");
  });

  it("grep and find locate content/files", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "tooluser6");
    const cid = await newContainer(ctx, token, "grep-box");
    await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/write`)
      .set("Authorization", `Bearer ${token}`)
      .send({ path: "g.txt", content: b64("needle line one\nother line\nneedle again") });

    const grep = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/grep`)
      .set("Authorization", `Bearer ${token}`)
      .send({ pattern: "needle", path: "." });
    expect(grep.status).toBe(200);
    expect(grep.body.output).toContain("needle");

    const find = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/find`)
      .set("Authorization", `Bearer ${token}`)
      .send({ pattern: "g.txt", path: "." });
    expect(find.status).toBe(200);
    expect(find.body.results.join("\n")).toContain("g.txt");
  });

  it("bash/stream runs via POST and streams an end event", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "tooluser7");
    const cid = await newContainer(ctx, token, "stream-box");
    const res = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/bash/stream`)
      .set("Authorization", `Bearer ${token}`)
      .send({ command: "echo streamed-output" });
    expect(res.status).toBe(200);
    const text = res.text;
    expect(text).toContain("event: data");
    expect(text).toContain("event: end");
    expect(Buffer.from(text.match(/chunk":"([^"]+)/)?.[1] ?? "", "base64").toString("utf8")).toContain("streamed-output");
  });

  it("bash with container-style cwd (/workspace) runs inside the sandbox", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "tooluser9");
    const cid = await newContainer(ctx, token, "workspace-cwd-box");
    // The extension's bash tool always sends cwd=/workspace (GUEST_WORKSPACE).
    const write = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/write`)
      .set("Authorization", `Bearer ${token}`)
      .send({ path: "/workspace/from-ws.txt", content: b64("ws-content") });
    expect(write.status).toBe(200);

    const res = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/bash`)
      .set("Authorization", `Bearer ${token}`)
      .send({ command: process.platform === "win32" ? "dir /b" : "ls", cwd: "/workspace" });
    expect(res.status).toBe(200);
    expect(res.body.exitCode).toBe(0);
    expect(res.body.stdout).toContain("from-ws.txt");

    // Reading back through the container-style path works too.
    const read = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/read`)
      .set("Authorization", `Bearer ${token}`)
      .send({ path: "/workspace/from-ws.txt" });
    expect(Buffer.from(read.body.contentBase64, "base64").toString("utf8")).toBe("ws-content");
  });

  it("bash with a missing container cwd reports a cd failure, not a 500", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "tooluser10");
    const cid = await newContainer(ctx, token, "missing-cwd-box");
    const res = await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/bash`)
      .set("Authorization", `Bearer ${token}`)
      .send({ command: "echo nope", cwd: "/no/such/dir" });
    expect(res.status).toBe(200);
    expect(res.body.exitCode).toBe(1);
    expect(res.body.stderr).toContain("No such file or directory");
  });

  it("audits tool commands with the command text in detail", async () => {
    ctx = await setupTestApp();
    const token = await createUserAndLogin(ctx, "tooluser8");
    const cid = await newContainer(ctx, token, "audit-box");
    await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/bash`)
      .set("Authorization", `Bearer ${token}`)
      .send({ command: "echo audit-me" });
    await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/bash/stream`)
      .set("Authorization", `Bearer ${token}`)
      .send({ command: "echo stream-me" });
    await ctx
      .request()
      .post(`/api/v1/containers/${cid}/tools/write`)
      .set("Authorization", `Bearer ${token}`)
      .send({ path: "audit.txt", content: b64("x") });

    const admin = await adminToken(ctx);
    const logs = await ctx
      .request()
      .get("/api/v1/admin/logs?resourceType=container")
      .set("Authorization", `Bearer ${admin}`);
    expect(logs.status).toBe(200);
    const actions = logs.body.logs.map((l: { action: string }) => l.action);
    // bash/stream is its own action, distinct from plain bash.
    expect(actions).toContain("container.tool.bash.stream");
    expect(actions).toContain("container.tool.bash");
    expect(actions).toContain("container.tool.write");

    const bashLog = logs.body.logs.find((l: { action: string }) => l.action === "container.tool.bash");
    expect(bashLog.detail.command).toBe("echo audit-me");
    const streamLog = logs.body.logs.find((l: { action: string }) => l.action === "container.tool.bash.stream");
    expect(streamLog.detail.command).toBe("echo stream-me");
    const writeLog = logs.body.logs.find((l: { action: string }) => l.action === "container.tool.write");
    expect(writeLog.detail.toolPath).toBe("audit.txt");
  });
});
