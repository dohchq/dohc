import { describe, expect, it } from "vitest";
import {
  readableShareLevel,
  shareViewGranterEmail,
  shareViewIsPresent,
} from "./shareViewMarker";

// `shareViewIsPresent` is what main's `sharedViewOf` asks before refusing a
// write. It decides whether someone else's files can be edited, so it is
// tested as the security predicate it is, not as a formatting helper.

describe("share-view marker presence", () => {
  it("treats only an ABSENT field as an ordinary workspace", () => {
    expect(shareViewIsPresent(undefined)).toBe(false);
  });

  // The hole this closes: `entry?.shareView ?? null` read a stored `null` as
  // "no share view", so main allowed writes into a shared view whose marker
  // had lost its value.
  it("treats a present-but-unreadable marker as a share view", () => {
    for (const raw of [null, "", 0, false, "nonsense", 7, [], {}]) {
      expect(
        shareViewIsPresent(raw),
        `MUTATION: shareView ${JSON.stringify(raw)} must stay refused for writes`,
      ).toBe(true);
    }
  });

  // Bounded to the wire schema's own limits: a damaged marker carrying a
  // 1-character email would fail the summary parse and throw out of the whole
  // projection — the zero-workspaces defect reached through the field added
  // to describe the damage.
  it("shows a granter email only when the wire schema will carry it", () => {
    expect(shareViewGranterEmail({ granterEmail: "sam@dohc.test" })).toBe(
      "sam@dohc.test",
    );
    for (const raw of [null, 7, undefined, {}, "", "ab", "x".repeat(321)]) {
      expect(
        shareViewGranterEmail({ granterEmail: raw }),
        String(raw).slice(0, 20),
      ).toBeNull();
    }
    expect(shareViewGranterEmail(null)).toBeNull();
  });
});

describe("share-view pinned level", () => {
  it("accepts a grant right at the count cap", () => {
    expect(
      readableShareLevel({
        paths: Array.from({ length: 100 }, (_, i) => `docs/f${i}.md`),
        versionId: null,
        access: "view",
      }),
    ).toBe("view");
  });

  it("reads the level from a complete grant", () => {
    expect(
      readableShareLevel({ paths: ["docs"], versionId: null, access: "comment" }),
    ).toBe("comment");
  });

  // Same verdict as the refresh path, from the same function. A selector the
  // pull refuses must not read as a healthy grant here.
  it("refuses every grant the pull refuses", () => {
    for (const selector of [
      null,
      undefined,
      "docs",
      { paths: ["docs"], versionId: null },
      { paths: ["docs"], versionId: null, access: "View" },
      { paths: [], versionId: null, access: "view" },
      { paths: ["docs"], versionId: "", access: "view" },
      { paths: ["docs"], versionId: " v1 ", access: "view" },
      { paths: "docs", versionId: null, access: "view" },
      // Paths the relay could never have issued. `""` is the path-shaped
      // version of the empty version id that got through a reader once.
      { paths: [""], versionId: null, access: "view" },
      { paths: ["../escape.md"], versionId: null, access: "view" },
      { paths: [".env"], versionId: null, access: "view" },
      { paths: ["docs/"], versionId: null, access: "view" },
      { paths: ["docs//notes.md"], versionId: null, access: "view" },
      // The cap is one number in one place, so the minting side and every
      // reading side agree instead of drifting apart.
      { paths: ["d".repeat(1025)], versionId: null, access: "view" },
      // The COUNT cap is the same class of gap as the length cap: a 101-path
      // grant is one the relay would never have issued.
      {
        paths: Array.from({ length: 101 }, (_, i) => `docs/f${i}.md`),
        versionId: null,
        access: "view",
      },
    ]) {
      expect(readableShareLevel(selector), JSON.stringify(selector)).toBeNull();
    }
  });
});
