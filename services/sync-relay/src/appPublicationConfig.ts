import {
  APP_PUBLICATION_MAX_BUNDLE_BYTES,
  APP_PUBLICATION_MAX_FILES,
  APP_PUBLICATION_MAX_METADATA_BYTES,
  type AppPublicationLimits,
} from "@dohc/security-contract/app-publication";
import type { AppCollectionPolicy } from "./appCollectionRoutes";

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

/** Collection creates stay disabled unless a deployment sets a positive quota. */
export function readAppCollectionPolicy(value: string | undefined): AppCollectionPolicy | undefined {
  if (value === undefined || value === "0") return undefined;
  if (!/^\d+$/u.test(value)) throw new Error("DOHC_RELAY_APP_COLLECTION_MAX_CREATES_PER_GRANT must be 0 or a positive safe integer.");
  const max = Number(value);
  if (!Number.isSafeInteger(max) || max < 1) throw new Error("DOHC_RELAY_APP_COLLECTION_MAX_CREATES_PER_GRANT must be 0 or a positive safe integer.");
  return { maxCreatesPerGrant: max };
}

export function readAppBackendParticipantLimit(value: string | undefined): number {
  if (value === undefined) return 1000;
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("DOHC_RELAY_APP_BACKEND_MAX_PARTICIPANTS_PER_GRANT must be a positive safe integer.");
  }
  return Number(value);
}
