import { expect, it } from "vitest";
import { APP_PUBLICATION_MAX_BUNDLE_BYTES, APP_PUBLICATION_MAX_FILES, APP_PUBLICATION_MAX_METADATA_BYTES } from "@dohc/security-contract/app-publication";
import { readAppPublicationConfig } from "./appPublicationConfig";

it("enables immutable publications only through explicit deployment opt-in", () => {
  expect(readAppPublicationConfig(undefined)).toBeUndefined();
  expect(readAppPublicationConfig("0")).toBeUndefined();
  expect(readAppPublicationConfig("1")).toEqual({maxFiles: APP_PUBLICATION_MAX_FILES,
    maxMetadataBytes: APP_PUBLICATION_MAX_METADATA_BYTES, maxBundleBytes: APP_PUBLICATION_MAX_BUNDLE_BYTES});
  for (const value of ["", "true", "false", " 1", "1 ", "2"]) expect(() => readAppPublicationConfig(value)).toThrow("must be 0 or 1");
});
