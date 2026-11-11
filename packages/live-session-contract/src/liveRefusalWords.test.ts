import {LINK_REFUSALS} from "@dohc/security-contract/link-refusal";
import {expect, it} from "vitest";
import {DOCUMENT_TOO_DENSE_CAUSE} from "./liveRefusalWords";

// A link holder reads the same cause as the owner.
it("explains a too-dense note to link holders in the owner's words", () => {
  expect(LINK_REFUSALS.link_live_too_dense.error.startsWith(`${DOCUMENT_TOO_DENSE_CAUSE} `)).toBe(true);
});
