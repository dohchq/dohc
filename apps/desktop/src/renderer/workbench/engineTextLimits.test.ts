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

  it("gates on the constant the apply-merged arm ACTUALLY measures", () => {
    // Pinning the constant by NAME would be fooled by a rename, and pinning
    // only its value would be fooled by the arm being pointed at a different
    // constant. So read whichever identifier the arm compares against, then
    // resolve THAT one.
    //
    // This is the assertion PR #569 (issue #528) is expected to fail. It moves
    // the arm onto `MAX_MERGED_RESOLUTION_TEXT_BYTES` = 8,323,072 bytes — the
    // conflict listing's own frame budget — which makes every side this
    // surface can display a side the engine would accept back.
    //
    // WHEN IT FAILS, THE FIX IS NOT A BIGGER NUMBER HERE. At 8,323,072 the
    // engine's cap stops being the binding one, and what is left is a
    // renderer-owned bound: the largest body this surface will hold in a
    // CONTROLLED textarea that re-renders per keystroke. That bound has to be
    // measured and set above the largest healthy document (469,068
    // characters — conflictPane.measure.test.ts), which 131,072 bytes is not.
    // See #566 and the note on CONFLICT_COMBINED_MAX_BYTES.
    const rust = readRepoFile("crates/dohc-workspace-engine/src/lib.rs");
    const applyMerged = rust.slice(rust.indexOf('"apply-merged" => {'), 600 + rust.indexOf('"apply-merged" => {'));
    const measured = applyMerged.match(/text\.len\(\) > ([A-Z_]+)/);
    expect(measured, "the apply-merged arm no longer measures its text").not.toBeNull();
    const applied = constantValue(
      rust,
      new RegExp(`const ${measured?.[1]}: usize = ([^;]+);`),
    );
    expect(CONFLICT_COMBINED_MAX_BYTES).toBe(applied);
  });

  it("is still the only route a combined resolution can take", () => {
    // The assertions above catch the number MOVING. They cannot catch a SECOND
    // route appearing beside it — a blob handle for an over-cap combined
    // resolution — which would let the daemon accept a copy this surface still
    // refuses with every drift assertion green.
    //
    // PR #569 does NOT add one: it raises the in-band cap to the frame budget
    // and withholds the over-cap ANSWER instead, so the request still carries
    // its text as one wire string. This tripwire therefore stays true across
    // that change, and keeps failing if a blob route is ever added to the
    // request without this surface learning about it.
    const rust = readRepoFile("crates/dohc-workspace-engine/src/lib.rs");
    const resolveDto = rust.slice(
      rust.indexOf("struct LocalResolveDto {"),
      rust.indexOf("struct SearchParams {"),
    );
    expect(resolveDto).toContain("merged_text: Option<String>");
    expect(resolveDto.toLowerCase()).not.toContain("blob");
  });
});
