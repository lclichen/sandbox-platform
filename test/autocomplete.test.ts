/**
 * Container @-autocomplete tests (extension lib/autocomplete.ts).
 *
 * The suggestion logic is pure (listDir injected), so it is unit-tested here
 * against fake directory listings. The provider wrapper's delegation behavior
 * is covered with a stub `current` provider and a stub client.
 *
 * Cross-repo import: this file is excluded from the platform typecheck
 * (tsconfig.json) like the other extension smoke tests; vitest compiles it.
 */
import { describe, it, expect } from "vitest";
import {
  extractAtPrefix,
  buildCompletionValue,
  suggestContainerFiles,
  createContainerAutocompleteProvider,
  type AutocompleteProvider,
} from "../../pi-sandbox-extension/lib/autocomplete.ts";
import type { PlatformClient } from "../../pi-sandbox-extension/lib/client.ts";

const fakeClient = (listing: Record<string, Array<{ name: string; isDirectory: boolean }>>): PlatformClient =>
  ({
    toolLs: async (_id: number, dir: string) => listing[dir] ?? [],
  }) as unknown as PlatformClient;

describe("extractAtPrefix", () => {
  it("detects @ mentions at token boundaries", () => {
    expect(extractAtPrefix("@")).toBe("@");
    expect(extractAtPrefix("@src/ut")).toBe("@src/ut");
    expect(extractAtPrefix("look at @foo/bar")).toBe("@foo/bar");
    expect(extractAtPrefix('check @"a b/c')).toBe('@"a b/c');
  });

  it("does not treat mid-word @ as a mention", () => {
    expect(extractAtPrefix("user@example.com")).toBeNull();
    expect(extractAtPrefix("x@y z")).toBeNull();
  });

  it("does not treat plain unclosed quotes as @-mentions (matches pi)", () => {
    expect(extractAtPrefix('"foo')).toBeNull();
    expect(extractAtPrefix('x="foo')).toBeNull();
    expect(extractAtPrefix('@"foo')).toBe('@"foo');
  });
});

describe("buildCompletionValue", () => {
  it("inserts the @ prefix and quotes paths with spaces", () => {
    expect(buildCompletionValue("src/util.ts", { isDirectory: false, isAtPrefix: true, isQuotedPrefix: false })).toBe("@src/util.ts");
    expect(buildCompletionValue("my file.txt", { isDirectory: false, isAtPrefix: true, isQuotedPrefix: false })).toBe('@"my file.txt"');
    expect(buildCompletionValue("src/utils/", { isDirectory: true, isAtPrefix: true, isQuotedPrefix: true })).toBe('@"src/utils/"');
  });
});

describe("suggestContainerFiles", () => {
  const workspaceListing = [
    { name: "util.ts", isDirectory: false },
    { name: "utils", isDirectory: true },
    { name: "README.md", isDirectory: false },
    { name: ".git", isDirectory: true },
    { name: "node_modules", isDirectory: true },
  ];

  it("completes workspace-relative paths from the workspace root", async () => {
    const items = await suggestContainerFiles(
      (dir) => Promise.resolve(dir === "/workspace" ? workspaceListing : []),
      "ut",
    );
    expect(items.map((i) => i.label)).toEqual(["util.ts", "utils/"]);
  });

  it("completes an empty prefix to everything except excluded dirs", async () => {
    const items = await suggestContainerFiles(
      (dir) => Promise.resolve(dir === "/workspace" ? workspaceListing : []),
      "",
    );
    const labels = items.map((i) => i.label);
    expect(labels).toContain("util.ts");
    expect(labels).toContain("utils/");
    expect(labels).not.toContain(".git/");
    expect(labels).not.toContain("node_modules/");
  });

  it("descends into the typed directory segment", async () => {
    const items = await suggestContainerFiles(
      (dir) =>
        Promise.resolve(
          dir === "/workspace/src"
            ? [
                { name: "util.ts", isDirectory: false },
                { name: "ui", isDirectory: true },
              ]
            : [],
        ),
      "src/ut",
    );
    expect(items.map((i) => i.label)).toEqual(["src/util.ts"]);
  });

  it("continues into a directory when the prefix ends with /", async () => {
    const items = await suggestContainerFiles(
      (dir) =>
        Promise.resolve(
          dir === "/workspace/src"
            ? [
                { name: "a.ts", isDirectory: false },
                { name: "components", isDirectory: true },
              ]
            : [],
        ),
      "src/",
    );
    expect(items.map((i) => i.label)).toEqual(["src/a.ts", "src/components/"]);
  });

  it("supports container-absolute prefixes (starting with /)", async () => {
    const items = await suggestContainerFiles(
      (dir) =>
        Promise.resolve(
          dir === "/etc"
            ? [
                { name: "hosts", isDirectory: false },
                { name: "hostname", isDirectory: false },
              ]
            : [],
        ),
      "/etc/hos",
    );
    expect(items.map((i) => i.label)).toEqual(["/etc/hosts", "/etc/hostname"]);
  });

  it("matches case-insensitively and returns [] for missing directories", async () => {
    const items = await suggestContainerFiles(
      (dir) => Promise.resolve(dir === "/workspace" ? workspaceListing : []),
      "UTIL.TS",
    );
    expect(items.map((i) => i.label)).toEqual(["util.ts"]);
    const missing = await suggestContainerFiles(
      (dir) => Promise.resolve(dir === "/workspace" ? workspaceListing : []),
      "no/such",
    );
    expect(missing).toEqual([]);
  });
});

describe("createContainerAutocompleteProvider", () => {
  const stubCurrent: AutocompleteProvider = {
    getSuggestions: async () => ({ items: [{ value: "@local.txt", label: "local.txt" }], prefix: "@" }),
    applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
    shouldTriggerFileCompletion: () => true,
  };

  it("delegates to the built-in provider when no container is connected", async () => {
    const provider = createContainerAutocompleteProvider(stubCurrent, () => undefined);
    const res = await provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal });
    expect(res).toEqual({ items: [{ value: "@local.txt", label: "local.txt" }], prefix: "@" });
  });

  it("completes container files when a container is connected", async () => {
    const client = fakeClient({
      "/workspace": [{ name: "main.ts", isDirectory: false }],
    });
    const provider = createContainerAutocompleteProvider(stubCurrent, () => ({ client, containerId: 7 }));
    const res = await provider.getSuggestions(["look @main"], 0, 10, {
      signal: new AbortController().signal,
    });
    expect(res).toEqual({
      items: [{ value: "@main.ts", label: "main.ts" }],
      prefix: "@main",
    });
  });

  it("applies completions like the built-in (space after files, none after dirs)", () => {
    const provider = createContainerAutocompleteProvider(stubCurrent, () => undefined);
    // File: replaces the prefix and appends a space.
    const fileRes = provider.applyCompletion(["@main"], 0, 5, { value: "@main.ts", label: "main.ts" }, "@main");
    expect(fileRes.lines[0]).toBe("@main.ts ");
    // Directory: keeps trailing slash, no space, cursor stays after the slash.
    const dirRes = provider.applyCompletion(["@src"], 0, 4, { value: "@src/", label: "src/" }, "@src");
    expect(dirRes.lines[0]).toBe("@src/");
  });

  it("delegates applyCompletion for slash-command items (regression: no lost /)", () => {
    // Slash-command items from the built-in provider carry NO leading "/"
    // (e.g. value "sandbox-login"); the built-in's applyCompletion adds it.
    // Our wrapper must hand those to the wrapped provider, otherwise Enter on
    // "/sandbox-login" submits "sandbox-login" as plain text to the model.
    let delegated: { item: unknown; prefix: string } | null = null;
    const current: AutocompleteProvider = {
      ...stubCurrent,
      applyCompletion: (_l, _cl, _cc, item, prefix) => {
        delegated = { item, prefix };
        return { lines: ["/sandbox-login "], cursorLine: 0, cursorCol: 14 };
      },
    };
    const provider = createContainerAutocompleteProvider(current, () => ({
      client: fakeClient({}),
      containerId: 7,
    }));
    const res = provider.applyCompletion(["/sandbox-login"], 0, 14, { value: "sandbox-login", label: "sandbox-login" }, "/sandbox-login");
    expect(delegated).toEqual({ item: { value: "sandbox-login", label: "sandbox-login" }, prefix: "/sandbox-login" });
    expect(res.lines[0]).toBe("/sandbox-login "); // slash preserved by the delegate
  });

  it("respects the abort signal after the listing resolves", async () => {
    const client = fakeClient({ "/workspace": [{ name: "a.ts", isDirectory: false }] });
    const provider = createContainerAutocompleteProvider(stubCurrent, () => ({ client, containerId: 7 }));
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await provider.getSuggestions(["@a"], 0, 2, { signal: ctrl.signal });
    expect(res).toBeNull();
  });
});
