import { describe, expect, it } from "vitest";
import {
  KEY_ENVELOPE_METHOD,
  KeyEnvelopeProtocolShapeError,
  decodeKeyEnvelopeResult,
} from "./keyEnvelopeWireContract";

describe("key-envelope wire schemas", () => {
  it("accepts and strips extra result fields", () => {
    expect(
      decodeKeyEnvelopeResult(KEY_ENVELOPE_METHOD.upload, {
        etag: "etag-1",
        ignored: true,
      }),
    ).toEqual({ etag: "etag-1" });
    expect(
      decodeKeyEnvelopeResult(KEY_ENVELOPE_METHOD.download, {
        envelopeJson: "{}",
        etag: "etag-2",
        ignored: true,
      }),
    ).toEqual({ envelopeJson: "{}", etag: "etag-2" });
  });

  it("wraps malformed results in the public error", () => {
    expect(() =>
      decodeKeyEnvelopeResult(KEY_ENVELOPE_METHOD.upload, { etag: 1 }),
    ).toThrow(KeyEnvelopeProtocolShapeError);
  });
});
