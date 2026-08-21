// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

/** Boots just enough of the page for ../ui/chat.js's own top-level guard to
 * pass, then imports it for its two exported pure helpers. A cache-busting
 * query string forces a fresh module instance per call, so one test's DOM
 * setup never leaks into another's -- not that these two functions read the
 * DOM at all, but the module's own top-level code does run again either
 * way. */
async function loadChatModule(): Promise<typeof import("../ui/chat.js")> {
  document.body.innerHTML = `
    <main id="transcript" class="transcript">
      <div id="empty-state" class="empty-state"><p>Empty</p></div>
    </main>
    <div id="status"></div>
    <span id="session-state"></span>
    <button id="stop" type="button"></button>
    <form id="composer">
      <textarea id="message"></textarea>
      <button id="send" type="submit"></button>
    </form>
    <meta name="chat-token" content="test-token">
  `;
  // jsdom does not implement EventSource; chat.js only constructs one and
  // leaves it alone for these tests, which exercise pure helpers, not the
  // live connection.
  class FakeEventSource {
    constructor(public url: string) {}
    addEventListener(): void {}
  }
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  return import(/* @vite-ignore */ `../ui/chat.js?t=${Date.now()}-${Math.random()}`);
}

describe("mergedActivity", () => {
  it("keeps the existing title and detail when a completion event arrives sparse", async () => {
    const { mergedActivity } = await loadChatModule();
    const existing = { title: "Read src/foo.ts", detail: "src/foo.ts" };
    const sparse = { title: "Tool finished", status: "completed" as const };
    expect(mergedActivity(existing, sparse)).toEqual({
      title: "Read src/foo.ts",
      detail: "src/foo.ts",
    });
  });

  it("uses the incoming title and detail when the completion actually carries them", async () => {
    const { mergedActivity } = await loadChatModule();
    const existing = { title: "Read src/foo.ts", detail: "src/foo.ts" };
    const rich = {
      title: "Read",
      detail: "3 matches",
      locations: ["src/bar.ts"],
      status: "completed" as const,
    };
    expect(mergedActivity(existing, rich)).toEqual({
      title: "Read",
      detail: "3 matches\nsrc/bar.ts",
    });
  });

  it("always uses the item's own title and detail for a brand new card", async () => {
    const { mergedActivity } = await loadChatModule();
    const started = { title: "Bash", status: "in_progress" as const };
    expect(mergedActivity(null, started)).toEqual({ title: "Bash", detail: "" });
  });

  it("keeps status-only changes from wiping a rich title even with no existing detail", async () => {
    const { mergedActivity } = await loadChatModule();
    const existing = { title: "Edit src/foo.ts", detail: "" };
    const sparse = { title: "Tool failed", status: "failed" as const };
    expect(mergedActivity(existing, sparse)).toEqual({ title: "Edit src/foo.ts", detail: "" });
  });
});

describe("permissionLocations", () => {
  it("lists a permission request's affected locations", async () => {
    const { permissionLocations } = await loadChatModule();
    expect(
      permissionLocations({
        kind: "permission-request",
        requestId: "r1",
        requestType: "file-change",
        title: "Edit files",
        locations: ["src/a.ts", "src/b.ts"],
        options: [],
      }),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("is empty when the request carries no locations", async () => {
    const { permissionLocations } = await loadChatModule();
    expect(
      permissionLocations({
        kind: "permission-request",
        requestId: "r1",
        requestType: "command",
        title: "Run tests",
        options: [],
      }),
    ).toEqual([]);
  });
});
