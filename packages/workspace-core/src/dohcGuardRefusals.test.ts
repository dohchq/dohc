import { describe, expect, it } from "vitest";
import {
  DOHC_COLLECTIONS_GUARD,
  DOHC_ENGINE_GUARD,
  DOHC_DATABASES_GUARD,
  DOHC_METADATA_GUARD,
  DOHC_SYNC_HISTORY_GUARD,
  DOHC_TRASH_GUARD,
  notAFileRefusal,
  notARealFolderRefusal,
  notOnlyYoursRefusal,
  outsideWorkspaceRefusal,
  hardLinkedFileRefusal,
  fileChangedWhileOpeningRefusal,
  folderChangedBeforeWritingRefusal,
} from "./dohcGuardRefusals";

const asFile = { isSymbolicLink: () => false, isFile: () => true };
const asLink = { isSymbolicLink: () => true, isFile: () => false };
const asOther = { isSymbolicLink: () => false, isFile: () => false };

// These four strings are the whole point of the module: the desktop and the
// MCP server both refuse with them, so a noun that drifts here drifts on both
// surfaces at once. Pinned by exact match, byte for byte — swapping "folder"
// back to "directory" fails these first.
describe("dohc guard refusals", () => {
  it("names a file's other link and a change during opening with recovery steps", () => {
    const guard = { ...DOHC_DATABASES_GUARD, path: ".dohc/databases/data/operations.jsonl" };
    expect(hardLinkedFileRefusal(guard)).toBe(
      "dohc could not save this database edit. The file at .dohc/databases/data/operations.jsonl has another link, so changes here would change that file too. Remove or rename this file. Then retry.",
    );
    expect(fileChangedWhileOpeningRefusal(guard)).toBe(
      "dohc could not save this database edit. The file at .dohc/databases/data/operations.jsonl changed while dohc opened it. Stop other programs from changing this file. Then retry.",
    );
    expect(folderChangedBeforeWritingRefusal({ ...DOHC_DATABASES_GUARD, path: ".dohc/databases/data" })).toBe(
      "dohc could not save this database edit. The folder at .dohc/databases/data changed before dohc could save the edit. Stop other programs from changing this folder. Then retry.",
    );
  });
  it("names the squatter, the constraint, and the way out — one noun for both paths", () => {
    expect(notARealFolderRefusal(DOHC_TRASH_GUARD, asFile)).toBe(
      "dohc could not move this to the workspace trash. A file is at .dohc/local/trash, which must be a real folder. Remove or rename that file. Then retry.",
    );
    expect(notARealFolderRefusal(DOHC_TRASH_GUARD, asLink)).toBe(
      "dohc could not move this to the workspace trash. A link is at .dohc/local/trash, which must be a real folder. Remove or rename that link. Then retry.",
    );
    expect(notARealFolderRefusal(DOHC_METADATA_GUARD, asFile)).toBe(
      "dohc could not open this workspace's .dohc folder. A file is at .dohc, which must be a real folder. Remove or rename that file. Then retry.",
    );
    expect(notARealFolderRefusal(DOHC_METADATA_GUARD, asLink)).toBe(
      "dohc could not open this workspace's .dohc folder. A link is at .dohc, which must be a real folder. Remove or rename that link. Then retry.",
    );
    expect(notARealFolderRefusal(DOHC_ENGINE_GUARD, asFile)).toBe(
      "dohc could not start the engine for this workspace. A file is at .dohc/engine, which must be a real folder. Remove or rename that file. Then retry.",
    );
    expect(notAFileRefusal({ ...DOHC_SYNC_HISTORY_GUARD, path: ".dohc/sync-history/synced" }, asLink)).toBe(
      "dohc could not record this workspace's sync history. A link is at .dohc/sync-history/synced, which must be a file. Remove or rename that link. Then retry.",
    );
    expect(notAFileRefusal(DOHC_COLLECTIONS_GUARD, asLink)).toBe(
      "dohc could not read which computer keeps this workspace's Collections. A link is at .dohc/collections.json, which must be a file. Remove or rename that link. Then retry.",
    );
    expect(notARealFolderRefusal(DOHC_SYNC_HISTORY_GUARD, asLink)).toBe(
      "dohc could not record this workspace's sync history. A link is at .dohc/sync-history, which must be a real folder. Remove or rename that link. Then retry.",
    );
  });

  // A socket or a device node is neither a file nor a link. The article has to
  // follow the noun, or the sentence reads as a typo at the worst moment.
  it("agrees the article with the fallback noun", () => {
    expect(notARealFolderRefusal(DOHC_TRASH_GUARD, asOther)).toBe(
      "dohc could not move this to the workspace trash. An item is at .dohc/local/trash, which must be a real folder. Remove or rename that item. Then retry.",
    );
  });

  it("names a folder another user can change, and the way out", () => {
    expect(notOnlyYoursRefusal(DOHC_TRASH_GUARD)).toBe(
      "dohc could not move this to the workspace trash. Another user can change .dohc/local/trash. Make it a folder only you can change. Then retry.",
    );
  });

  it("states the containment constraint in the same shape", () => {
    expect(outsideWorkspaceRefusal(DOHC_TRASH_GUARD)).toBe(
      "dohc could not move this to the workspace trash. The .dohc/local/trash folder points outside this workspace, and it must stay inside. Remove or rename it. Then retry.",
    );
    expect(outsideWorkspaceRefusal(DOHC_METADATA_GUARD)).toBe(
      "dohc could not open this workspace's .dohc folder. The .dohc folder points outside this workspace, and it must stay inside. Remove or rename it. Then retry.",
    );
    expect(outsideWorkspaceRefusal(DOHC_ENGINE_GUARD)).toBe(
      "dohc could not start the engine for this workspace. The .dohc/engine folder points outside this workspace, and it must stay inside. Remove or rename it. Then retry.",
    );
  });

  // The register test: no refusal may carry developer vocabulary, and none may
  // stop before telling the user what to do.
  it("keeps every refusal in the user register with a next step", () => {
    const all = [
      notARealFolderRefusal(DOHC_TRASH_GUARD, asFile),
      notARealFolderRefusal(DOHC_METADATA_GUARD, asLink),
      outsideWorkspaceRefusal(DOHC_TRASH_GUARD),
      outsideWorkspaceRefusal(DOHC_METADATA_GUARD),
      notARealFolderRefusal(DOHC_ENGINE_GUARD, asFile),
      outsideWorkspaceRefusal(DOHC_ENGINE_GUARD),
      notOnlyYoursRefusal(DOHC_TRASH_GUARD),
    ];
    for (const message of all) {
      expect(message).toMatch(/ Then retry\.$/);
      expect(message).not.toMatch(/directory|symlink|errno|EEXIST|ENOENT/);
    }
  });
});
