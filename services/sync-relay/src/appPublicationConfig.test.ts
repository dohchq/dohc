import { expect, it } from "vitest";
import { APP_PUBLICATION_MAX_BUNDLE_BYTES, APP_PUBLICATION_MAX_FILES, APP_PUBLICATION_MAX_METADATA_BYTES } from "@dohc/security-contract/app-publication";
import { readAppBackendParticipantLimit, readAppCollectionPolicy, readAppPublicationConfig } from "./appPublicationConfig";

it("enables immutable publications only through explicit deployment opt-in", () => {
  expect(readAppPublicationConfig(undefined)).toBeUndefined();
  expect(readAppPublicationConfig("0")).toBeUndefined();
  expect(readAppPublicationConfig("1")).toEqual({maxFiles: APP_PUBLICATION_MAX_FILES,
    maxMetadataBytes: APP_PUBLICATION_MAX_METADATA_BYTES, maxBundleBytes: APP_PUBLICATION_MAX_BUNDLE_BYTES});
  for (const value of ["", "true", "false", " 1", "1 ", "2"]) expect(() => readAppPublicationConfig(value)).toThrow("must be 0 or 1");
});

it("keeps app collection creates disabled by default and validates the quota", () => {
  expect(readAppCollectionPolicy(undefined)).toBeUndefined();
  expect(readAppCollectionPolicy("0")).toBeUndefined();
  expect(readAppCollectionPolicy("25")).toEqual({ maxCreatesPerGrant: 25 });
  for (const value of ["", "-1", "1.5", "1 ", "9007199254740992"]) {
    expect(() => readAppCollectionPolicy(value)).toThrow("DOHC_RELAY_APP_COLLECTION_MAX_CREATES_PER_GRANT");
  }
});

it("defaults app write participants to 1000 and rejects invalid limits", () => {
  expect(readAppBackendParticipantLimit(undefined)).toBe(1000);
  expect(readAppBackendParticipantLimit("1")).toBe(1);
  expect(readAppBackendParticipantLimit("2500")).toBe(2500);
  expect(readAppBackendParticipantLimit("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
  for (const value of ["", "0", "-1", "1.5", " 1", "1 ", "01", "1e3", "9007199254740992"]) {
    expect(() => readAppBackendParticipantLimit(value)).toThrow("DOHC_RELAY_APP_BACKEND_MAX_PARTICIPANTS_PER_GRANT");
  }
});
