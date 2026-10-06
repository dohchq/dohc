import { describe, expect, it } from "vitest";
import { MAX_COMMENT_BODY_BYTES } from "./protocol";
import { readStdinText } from "./stdin";

async function* chunks(values: Array<string | Uint8Array>) {
  yield* values;
}

describe("stdin text", () => {
  it("preserves UTF-8 characters split across chunks at the byte limit", async () => {
    const body = "界".repeat(21_845) + "a";
    const bytes = Buffer.from(body);
    expect(await readStdinText(chunks([bytes.subarray(0, 1), bytes.subarray(1)]), MAX_COMMENT_BODY_BYTES)).toBe(body);
  });

  it("counts string chunks as UTF-8 bytes", async () => {
    await expect(readStdinText(chunks(["界".repeat(21_846)]), MAX_COMMENT_BODY_BYTES))
      .rejects.toThrow("stdin body is at most 64 KiB as UTF-8");
  });

  it("keeps existing unbounded callers and empty stdin working", async () => {
    const body = "a".repeat(MAX_COMMENT_BODY_BYTES + 1);
    expect(await readStdinText(chunks([body]))).toBe(body);
    expect(await readStdinText(chunks([]), MAX_COMMENT_BODY_BYTES)).toBe("");
  });
});
