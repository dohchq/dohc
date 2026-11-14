import { APP_PUBLICATION_MAX_BLOB_BYTES } from "@dohc/security-contract/app-publication";
import { expect, it } from "vitest";
import { MAX_BLOB_BYTES } from "./wireLimits";

it("carries a blob as large as the contract's blob ceiling", () => {
  expect(MAX_BLOB_BYTES).toBeGreaterThanOrEqual(APP_PUBLICATION_MAX_BLOB_BYTES);
});
