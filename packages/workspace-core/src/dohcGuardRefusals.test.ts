import { describe, expect, it } from "vitest";
import {
  DOHC_METADATA_GUARD,
  DOHC_TRASH_GUARD,
  notARealFolderRefusal,
  outsideWorkspaceRefusal,
} from "./dohcGuardRefusals";

const asFile = { isSymbolicLink: () => false, isFile: () => true };
const asLink = { isSymbolicLink: () => true, isFile: () => false };
const asOther = { isSymbolicLink: () => false, isFile: () => false };

// These four strings are the whole point of the module: the desktop and the
// MCP server both refuse with them, so a noun that drifts here drifts on both
// surfaces at once. Pinned by exact match, byte for byte — swapping "folder"
// back to "directory" fails these first.
describe("dohc guard refusals", () => {
  it("names the squatter, the constraint, and the way out — one noun for both paths", () => {
    expect(notARealFolderRefusal(DOHC_TRASH_GUARD, asFile)).toBe(
      "dohc could not move this to the workspace trash. A file is at .dohc/trash, which must be a real folder. Remove or rename that file. Then retry.",
    );
    expect(notARealFolderRefusal(DOHC_TRASH_GUARD, asLink)).toBe(
      "dohc could not move this to the workspace trash. A link is at .dohc/trash, which must be a real folder. Remove or rename that link. Then retry.",
    );
    expect(notARealFolderRefusal(DOHC_METADATA_GUARD, asFile)).toBe(
      "dohc could not open this workspace's .dohc folder. A file is at .dohc, which must be a real folder. Remove or rename that file. Then retry.",
    );
    expect(notARealFolderRefusal(DOHC_METADATA_GUARD, asLink)).toBe(
      "dohc could not open this workspace's .dohc folder. A link is at .dohc, which must be a real folder. Remove or rename that link. Then retry.",
    );
  });

  // A socket or a device node is neither a file nor a link. The article has to
  // follow the noun, or the sentence reads as a typo at the worst moment.
  it("agrees the article with the fallback noun", () => {
    expect(notARealFolderRefusal(DOHC_TRASH_GUARD, asOther)).toBe(
      "dohc could not move this to the workspace trash. An item is at .dohc/trash, which must be a real folder. Remove or rename that item. Then retry.",
    );
  });

  it("states the containment constraint in the same shape", () => {
    expect(outsideWorkspaceRefusal(DOHC_TRASH_GUARD)).toBe(
      "dohc could not move this to the workspace trash. The .dohc/trash folder points outside this workspace, and it must stay inside. Remove or rename it. Then retry.",
    );
    expect(outsideWorkspaceRefusal(DOHC_METADATA_GUARD)).toBe(
      "dohc could not open this workspace's .dohc folder. The .dohc folder points outside this workspace, and it must stay inside. Remove or rename it. Then retry.",
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
    ];
    for (const message of all) {
      expect(message).toMatch(/ Then retry\.$/);
      expect(message).not.toMatch(/directory|symlink|errno|EEXIST|ENOENT/);
    }
  });
});
