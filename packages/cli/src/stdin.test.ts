import { describe, expect, it } from "vitest";
import { CHAT_MESSAGE_TOO_LONG, MAX_CHAT_MESSAGE_BODY_BYTES } from "@dohc/workspace-contracts/chat-message-body";
import { readStdinText } from "./stdin";

const LIMIT = { bytes: MAX_CHAT_MESSAGE_BODY_BYTES, message: CHAT_MESSAGE_TOO_LONG };

async function* chunks(values: Array<string | Uint8Array>) {
  yield* values;
}

describe("stdin text", () => {
  it("preserves UTF-8 characters split across chunks at the byte limit", async () => {
    const body = "界".repeat(21_845) + "a";
    const bytes = Buffer.from(body);
    expect(await readStdinText(chunks([bytes.subarray(0, 1), bytes.subarray(1)]), LIMIT)).toBe(body);
  });

  it("counts string chunks as UTF-8 bytes", async () => {
    await expect(readStdinText(chunks(["界".repeat(21_846)]), LIMIT))
      .rejects.toThrow(CHAT_MESSAGE_TOO_LONG);
  });

  it("keeps existing unbounded callers and empty stdin working", async () => {
    const body = "a".repeat(MAX_CHAT_MESSAGE_BODY_BYTES + 1);
    expect(await readStdinText(chunks([body]))).toBe(body);
    expect(await readStdinText(chunks([]), LIMIT)).toBe("");
  });
});
