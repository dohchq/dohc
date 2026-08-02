// The conflict surface gates "Combine by hand" on the engine's in-band text
// cap, so a copy the engine would refuse is never offered as an edit (#536).
// That gate is only honest while the renderer's number and the engine's agree.
//
// #524 declined a renderer-side check for exactly this reason: a hand-copied
// constant with nothing holding it to the engine's is the drift that produced
// the false "versions cover files <=128KiB" comment that PR deleted. This test
// is what makes the copy safe — it reads the two other places the number
// lives and fails when any of the three moves without the others.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONFLICT_COMBINED_MAX_BYTES } from "./conflictPane";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

function readRepoFile(relativePath: string): string {
  return readFileSync(repoRoot + relativePath, "utf8");
}

// `128 * 1024` and `131072` are both spelled in the sources below, so the
// guard evaluates the expression rather than matching one spelling.
function constantValue(source: string, pattern: RegExp): number {
  const match = source.match(pattern);
  if (!match) throw new Error(`no match for ${pattern}`);
  const [left, right] = match[1].split("*").map((part) => Number(part.trim()));
  return right === undefined ? left : left * right;
}

describe("the in-band text cap the combine affordance is gated on", () => {
  it("matches the daemon's MAX_DESKTOP_CAPTURE_TEXT_BYTES", () => {
    const rust = constantValue(
      readRepoFile("crates/dohc-workspace-engine/src/lib.rs"),
      /const MAX_DESKTOP_CAPTURE_TEXT_BYTES: usize = ([^;]+);/,
    );
    expect(CONFLICT_COMBINED_MAX_BYTES).toBe(rust);
  });

  it("matches the loopback engine's copy of it", () => {
    const loopback = constantValue(
      readRepoFile(
        "packages/workspace-engine-client/src/versioned/versionedLoopbackEngine.ts",
      ),
      /const MAX_DESKTOP_CAPTURE_TEXT_BYTES = ([^;]+);/,
    );
    expect(CONFLICT_COMBINED_MAX_BYTES).toBe(loopback);
  });

  it("still guards the apply-merged arm the affordance posts to", () => {
    // A gate on a check that moved is a gate on nothing. Pin that the daemon
    // still measures apply-merged against this constant.
    const rust = readRepoFile("crates/dohc-workspace-engine/src/lib.rs");
    const applyMerged = rust.slice(rust.indexOf('"apply-merged" => {'));
    expect(applyMerged.slice(0, 600)).toContain(
      "text.len() > MAX_DESKTOP_CAPTURE_TEXT_BYTES",
    );
  });

  it("is still the only route a combined resolution can take", () => {
    // The two assertions above catch the number MOVING. They cannot catch it
    // ceasing to APPLY, which is exactly what #528 will do: it adds a blob
    // route for an over-cap combined resolution, and on that day the daemon
    // accepts a copy this surface still refuses — with both drift assertions
    // green.
    //
    // The obvious fix is not a bigger constant here. It is for the conflict
    // listing to REPORT the limit that applies to a combined resolution, the
    // way `versionedText.read` already reports `inbandLimitBytes` beside an
    // over-cap body (`lib.rs:3324`), and for this surface to gate on the
    // reported number. Then #528 lifts the UI with no renderer change. That is
    // a daemon wire change in the handler #528's lane is rewriting, so it is
    // filed as #566 rather than taken here.
    //
    // Until then this tripwire fails the moment a second route appears, so
    // #528 cannot land while this surface still refuses what the engine takes.
    const rust = readRepoFile("crates/dohc-workspace-engine/src/lib.rs");
    const resolveDto = rust.slice(
      rust.indexOf("struct LocalResolveDto {"),
      rust.indexOf("struct SearchParams {"),
    );
    expect(resolveDto).toContain("merged_text: Option<String>");
    expect(resolveDto.toLowerCase()).not.toContain("blob");
  });
});
