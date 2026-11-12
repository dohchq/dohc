import { describe, expect, it } from "vitest";
import type { WorkReferenceResolution } from "@dohc/workspace-engine-client/daemon";
import { workReferenceView } from "./workReferenceViews";

const REF = "A".repeat(43);
const found = (target: Extract<WorkReferenceResolution, { status: "found" }>["target"], extra: { path?: string; title?: string; state?: "live" | "deleted" } = {}) => ({
  status: "found" as const, reference: REF, target, state: extra.state ?? "live" as const, createdAtMs: 1, registration: "registered" as const,
  ...(extra.path ? { path: extra.path } : {}), ...(extra.title !== undefined ? { title: extra.title } : {}),
});
const versioned = { versionId: "v", objectId: "o" };

describe("what a work link shows and opens", () => {
  it("opens a chat by its channel, named by its title", () => {
    expect(workReferenceView(REF, found({ kind: "chat", channelId: "c-1" }, { title: "Trip" }))).toEqual({
      reference: REF, kind: "chat", label: "Trip", open: { to: "chat-channel", channel: "c-1" },
    });
  });

  it("opens a thread and a message in their chat, and a file's conversation without one", () => {
    expect(workReferenceView(REF, found({ kind: "thread", threadId: "t-1", channelId: "c-1" }, { title: "Flights" }))).toEqual({
      reference: REF, kind: "thread", label: "Flights", open: { to: "chat", thread: "t-1", channel: "c-1" },
    });
    expect(workReferenceView(REF, found({ kind: "message", messageId: "m-1", threadId: "t-1" }))).toEqual({
      reference: REF, kind: "message", label: "", open: { to: "chat", thread: "t-1", message: "m-1" },
    });
  });

  it("opens files, apps and records by path, and a Collection as a Collection", () => {
    expect(workReferenceView(REF, found({ kind: "file", ...versioned }, { path: "Trip/plan.md" })).open).toEqual({ to: "file", path: "Trip/plan.md" });
    expect(workReferenceView(REF, found({ kind: "app", ...versioned }, { path: "apps/signup" })).kind).toBe("app");
    expect(workReferenceView(REF, found({ kind: "documentRecord", versionId: "v", recordId: "r" }, { path: "Guests/sam.md" })))
      .toEqual({ reference: REF, kind: "record", label: "Guests/sam.md", open: { to: "file", path: "Guests/sam.md" } });
    expect(workReferenceView(REF, found({ kind: "documentCollection", ...versioned }, { path: "Guests" })))
      .toEqual({ reference: REF, kind: "collection", label: "Guests", open: { to: "collection", path: "Guests" } });
  });

  it("shows a table but opens nothing", () => {
    expect(workReferenceView(REF, found({ kind: "transactionalCollection", datasetId: "d", tableId: "t" })))
      .toEqual({ reference: REF, kind: "data", label: "", open: null });
  });

  it("reads unknown, deleted and pathless work as unavailable", () => {
    const unavailable = { reference: REF, kind: null, label: "", open: null };
    expect(workReferenceView(REF, null)).toEqual(unavailable);
    expect(workReferenceView(REF, { status: "unknown" })).toEqual(unavailable);
    expect(workReferenceView(REF, found({ kind: "chat", channelId: "c" }, { state: "deleted" }))).toEqual(unavailable);
    expect(workReferenceView(REF, found({ kind: "file", ...versioned }))).toEqual(unavailable);
  });
});
