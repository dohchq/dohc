import {
  APP_PUBLICATION_MAX_BUNDLE_BYTES,
  APP_PUBLICATION_MAX_FILES,
  APP_PUBLICATION_MAX_METADATA_BYTES,
  type AppPublicationLimits,
} from "@dohc/security-contract/app-publication";

/** Deployment opt-in for immutable publication routes, independent of public Edit. */
export function readAppPublicationConfig(value: string | undefined): AppPublicationLimits | undefined {
  if (value === undefined || value === "0") return undefined;
  if (value !== "1") throw new Error("DOHC_RELAY_APP_PUBLICATIONS must be 0 or 1.");
  return {
    maxFiles: APP_PUBLICATION_MAX_FILES,
    maxMetadataBytes: APP_PUBLICATION_MAX_METADATA_BYTES,
    maxBundleBytes: APP_PUBLICATION_MAX_BUNDLE_BYTES,
  };
}
