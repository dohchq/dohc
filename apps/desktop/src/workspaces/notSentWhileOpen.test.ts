import { describe, expect, it, vi } from "vitest";
import type {
  ListedGrant,
  ListedLink,
  RosterListing,
} from "@dohc/automation-executor/roster-listing";
import { createNotSentWhileOpen, sharedByListing } from "./notSentWhileOpen";

describe("notes not sent while open", () => {
  it("answers each workspace's last read, says when it changed, and keeps it through a failed read", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const notSent = createNotSentWhileOpen();
      expect(await notSent.read("a", async () => ["new.md"])).toBe(true);
      expect(await notSent.read("a", async () => ["new.md"])).toBe(false);
      expect(notSent.paths("a")).toEqual(["new.md"]);
      expect(notSent.paths("b")).toEqual([]);
      expect(await notSent.read("a", () => Promise.reject(new Error("engine closed")))).toBe(false);
      expect(notSent.paths("a")).toEqual(["new.md"]);
      expect(await notSent.read("a", async () => [])).toBe(true);
      expect(notSent.paths("a")).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("whether a listing shares a note", () => {
  const link = (
    selector: { paths: string[]; versionId: string | null },
    over: { status?: "active" | "revoked"; ended?: boolean } = {},
  ): ListedLink => ({
    grant: {
      granterUserId: "owner",
      granterEmail: null,
      subjectName: null,
      sharerName: null,
      shareId: "share",
      grantId: "grant",
      generation: 1,
      status: over.status ?? "active",
      recipientUserId: null,
      recipientEmail: null,
      selector,
      access: "view",
    },
    ended: over.ended ?? false,
    automationsGeneration: null,
  });
  const listing = (...links: ListedLink[]): RosterListing => ({
    grants: [],
    links,
    formerGrants: [],
    endedGrants: [],
  });
  const granted = (...grants: ListedGrant[]): RosterListing => ({
    grants,
    links: [],
    formerGrants: [],
    endedGrants: [],
  });
  const named = (
    selector: { paths: string[]; versionId: string | null },
    status: "active" | "revoked" = "active",
  ): RosterListing =>
    granted({ ...link(selector, { status }).grant, recipientEmail: "friend@example.com" });

  it("counts a live link to the note or a folder holding it", () => {
    expect(
      sharedByListing(listing(link({ paths: ["notes/a.md"], versionId: null })), "notes/a.md"),
    ).toBe(true);
    expect(
      sharedByListing(listing(link({ paths: ["notes"], versionId: null })), "notes/a.md"),
    ).toBe(true);
  });

  it("counts a person's share of the note or a folder holding it", () => {
    expect(sharedByListing(named({ paths: ["notes/a.md"], versionId: null }), "notes/a.md")).toBe(
      true,
    );
    expect(sharedByListing(named({ paths: ["notes"], versionId: null }), "notes/a.md")).toBe(true);
  });

  it("does not count a person's revoked share, their share of a version, or a Group's files", () => {
    expect(
      sharedByListing(named({ paths: ["notes"], versionId: null }, "revoked"), "notes/a.md"),
    ).toBe(false);
    expect(sharedByListing(named({ paths: ["notes"], versionId: "v1" }), "notes/a.md")).toBe(false);
    const { grant } = link({ paths: ["notes"], versionId: null });
    const group = granted({
      ...grant,
      recipientEmail: "friend@example.com",
      selector: { kind: "group", channelWireId: "channel", paths: ["notes"], versionId: null },
      access: "read-write",
      fileScope: "served",
    });
    expect(sharedByListing(group, "notes/a.md")).toBe(false);
  });

  it("does not count another path, an ended link, a version, or no listing", () => {
    expect(
      sharedByListing(listing(link({ paths: ["notes/a.md"], versionId: null })), "notes/b.md"),
    ).toBe(false);
    expect(sharedByListing(listing(link({ paths: ["note"], versionId: null })), "notes/a.md")).toBe(
      false,
    );
    expect(
      sharedByListing(
        listing(link({ paths: ["notes"], versionId: null }, { ended: true })),
        "notes/a.md",
      ),
    ).toBe(false);
    expect(
      sharedByListing(
        listing(link({ paths: ["notes"], versionId: null }, { status: "revoked" })),
        "notes/a.md",
      ),
    ).toBe(false);
    expect(
      sharedByListing(listing(link({ paths: ["notes"], versionId: "v1" })), "notes/a.md"),
    ).toBe(false);
    expect(sharedByListing(listing(), "notes/a.md")).toBe(false);
    expect(
      sharedByListing({ grants: null, problem: { kind: "unusable-listing" } }, "notes/a.md"),
    ).toBe(false);
    expect(sharedByListing(null, "notes/a.md")).toBe(false);
  });
});
