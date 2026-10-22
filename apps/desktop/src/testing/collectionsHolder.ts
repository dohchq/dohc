import type { CollectionsHolderCheck } from "../workspaces/collectionsHolder";

/**
 * Opens a Collections store with no holder record, as a workspace that
 * syncs through a server does, for tests of everything but the holder.
 */
export const unguardedCollections: CollectionsHolderCheck = {
  here: () => ({ installId: "install-test", label: "Test computer" }),
  required: () => false,
};
