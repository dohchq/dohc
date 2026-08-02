// The conflict surface bounds what "Combine by hand" will edit (#536). That
// bound is only honest while it stays inside what `conflicts.resolve` accepts,
// and #569 changed what that is: there is no longer a cap on the merged body.
// A resolve succeeds when the whole JSON-ENCODED request fits one control
// frame, so what a body may weigh is whatever the rest of its request leaves.
//
// #566: the gate no longer restates the engine's number. It IMPORTS the
// contract from `@dohc/workspace-engine-client/limits` — a leaf module that
// imports nothing, so a renderer can take it without pulling `node:crypto`
// into the browser bundle — and proves the renderer's own editing bound fits
// inside it. The import IS the drift guard: when the frame budget moves, this
// arithmetic moves with it, and no hand-copied number can fall behind.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RESOLVE_REQUEST_FRAME_BYTES,
  jsonStringEncodedLength,
} from "@dohc/workspace-engine-client/limits";
import { describe, expect, it } from "vitest";
import { CONFLICT_COMBINED_EDIT_MAX_BYTES } from "./conflictPane";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

function readRepoFile(relativePath: string): string {
  return readFileSync(repoRoot + relativePath, "utf8");
}

/// What the rest of a `conflicts.resolve` request can spend, generously.
///
/// The body is not the only thing in the frame. `LocalResolveDto` also carries
/// two metadata fields of up to MAX_METADATA_FIELD_BYTES (16 KiB) each, whose
/// escaping can double them, plus a path, four identifiers, an idempotency key
/// and the envelope. 128 KiB is far more than that costs; the point is to
/// prove the editing bound fits with room to spare, not to predict the
/// envelope to the byte.
const RESOLVE_REQUEST_OVERHEAD_BUDGET = 128 * 1024;

/// The largest healthy document in the measured corpus
/// (conflictPane.measure.test.ts). AGENTS.md: a limit that rejects otherwise
/// valid work is set beyond the measured healthy range.
const LARGEST_HEALTHY_DOCUMENT_CHARS = 469_068;

describe("the bound on what a combined copy can be edited to", () => {
  it("leaves a whole worst-case body inside the resolve frame", () => {
    // The worst case is not the raw byte count. U+0001 is one UTF-8 byte and
    // SIX JSON-encoded ones, the highest ratio the encoder produces, so a body
    // full of them is the largest a body at this bound can become on the wire.
    const worstCase = String.fromCharCode(1).repeat(
      CONFLICT_COMBINED_EDIT_MAX_BYTES,
    );
    const encoded = jsonStringEncodedLength(worstCase);
    expect(encoded).toBe(CONFLICT_COMBINED_EDIT_MAX_BYTES * 6 + 2);
    expect(encoded + RESOLVE_REQUEST_OVERHEAD_BUDGET).toBeLessThan(
      RESOLVE_REQUEST_FRAME_BYTES,
    );
  });

  it("sits above the largest healthy document", () => {
    expect(CONFLICT_COMBINED_EDIT_MAX_BYTES).toBeGreaterThan(
      LARGEST_HEALTHY_DOCUMENT_CHARS,
    );
  });

  it("keeps the imported frame budget equal to the daemon's", () => {
    // The arithmetic above is only worth anything while this number is the
    // daemon's. The Rust constant reads the protocol crate's wire limits, so
    // read the same place.
    const wireLimits = readRepoFile("crates/dohc-engine-protocol/src/limits.rs");
    const declared = wireLimits.match(/max_frame_bytes:\s*([0-9*\s]+),/);
    expect(declared, "SPIKE_DEFAULTS no longer declares max_frame_bytes").not.toBeNull();
    const value = (declared?.[1] ?? "")
      .split("*")
      .map((part) => Number(part.trim()))
      .reduce((product, part) => product * part, 1);
    expect(RESOLVE_REQUEST_FRAME_BYTES).toBe(value);

    const engine = readRepoFile("crates/dohc-workspace-engine/src/lib.rs");
    expect(engine).toContain(
      "const RESOLVE_REQUEST_FRAME_BYTES: usize =\n    dohc_engine_protocol::limits::WireLimits::SPIKE_DEFAULTS.max_frame_bytes as usize;",
    );
  });
});

describe("the shape of the apply route the gate models", () => {
  // The gate reasons about ONE shape: the combined body travels as a JSON
  // string inside a single resolve request, and the frame is what bounds it.
  // These fail if that stops being true — a blob handle, a chunked upload, or
  // an arm that measures something other than the encoded request would each
  // make the arithmetic above describe a route that no longer exists.
  const engine = readRepoFile("crates/dohc-workspace-engine/src/lib.rs");

  it("still carries the merged body as one JSON string, with no blob route", () => {
    const dto = engine.slice(
      engine.indexOf("struct LocalResolveDto {"),
      engine.indexOf("struct SearchParams {"),
    );
    expect(dto).toContain("merged_text: Option<String>");
    expect(dto.toLowerCase()).not.toContain("blob");
    expect(dto.toLowerCase()).not.toContain("chunk");
  });

  it("still measures the encoded request against the frame", () => {
    const arm = engine.slice(engine.indexOf('"apply-merged" => {'));
    expect(arm.slice(0, 900)).toContain(
      "if encoded_request > RESOLVE_REQUEST_FRAME_BYTES",
    );
  });
});
