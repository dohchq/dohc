import {
  highestListedLevel,
  levelAtPath,
  listedFolderLevel,
  listedGroupLevel,
  parseListedReach,
  type ListedReach,
} from "@dohc/security-contract/listed-reach";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import { isRecord } from "@dohc/workspace-core/records";
import { shareViewIdentityIsIntact } from "./shareViewMarker";
import { recordedShareSelector } from "./shareViewRecords";

/**
 * A share view's levels, as one answer every local gate asks: main's write
 * gate, record creation, chat writes, the CLI and MCP. A person and an agent
 * therefore get the same level at the same path.
 *
 * A joined workspace takes each path's level from the reach the relay last
 * listed (`ListedReach`), stored with the share view. Until that reach is
 * stored, and for a path share, every path takes the pinned grant's level.
 * The relay still decides every write, and a write it refuses follows the
 * refused-write path.
 */
export interface ShareViewLevels {
  /** The pinned grant's level. For a joined workspace this is the member level. */
  readonly member: ShareAccess | null;
  /**
   * Whether some Group takes the member's posts: the level a Group the reach
   * doesn't name takes, or any listed Group's, is Comment or Edit.
   */
  readonly postsInSomeGroup: boolean;
  /** The highest level anywhere, which decides whether a write offer shows at all. */
  readonly highest: ShareAccess | null;
  /** The level at a file path: an existing file's current path, or a new file's. */
  at(path: string): ShareAccess | null;
  /** The level inside a folder, "" for the root: where a new file in it lands. */
  in(folder: string): ShareAccess | null;
  /** The level in a Group, by its channel wire id. */
  group(channelWireId: string): ShareAccess | null;
}

const NO_LEVELS: ShareViewLevels = {
  member: null,
  postsInSomeGroup: false,
  highest: null,
  at: () => null,
  in: () => null,
  group: () => null,
};

const takesPosts = (level: ShareAccess | null) => level === "comment" || level === "edit";

/** The reach stored with a joined workspace's share view, or null when it has none or it is unreadable. */
export function storedShareViewReach(shareView: unknown): ListedReach | null {
  if (!isRecord(shareView)) return null;
  if (recordedShareSelector(shareView.grantedSelector)?.wholeWorkspace !== true) return null;
  return shareView.reach === undefined ? null : parseListedReach(shareView.reach);
}

/**
 * The levels a share view's marker gives. A damaged marker gives none, so
 * it offers and admits no write.
 */
export function shareViewLevels(shareView: unknown): ShareViewLevels {
  if (!isRecord(shareView) || !shareViewIdentityIsIntact(shareView)) return NO_LEVELS;
  const selector = recordedShareSelector(shareView.grantedSelector);
  return selector === null ? NO_LEVELS : grantLevels(selector, shareView.reach);
}

/** The levels a readable pinned grant gives with the reach stored beside it, if any. */
export function grantLevels(
  selector: NonNullable<ReturnType<typeof recordedShareSelector>>,
  storedReach: unknown,
): ShareViewLevels {
  const member = selector.access;
  const reach =
    selector.wholeWorkspace === true && storedReach !== undefined
      ? parseListedReach(storedReach)
      : undefined;
  // A stored reach that can't be read gives no level, rather than the
  // member level it may have narrowed.
  if (reach === null) return { ...NO_LEVELS, member };
  if (reach === undefined) {
    return {
      member,
      postsInSomeGroup: takesPosts(member),
      highest: member,
      at: () => member,
      in: () => member,
      group: () => member,
    };
  }
  return {
    member,
    postsInSomeGroup:
      takesPosts(reach.groupDefault) || reach.groups.some((group) => takesPosts(group.level)),
    highest: highestListedLevel(reach),
    at: (path) => levelAtPath(reach, path),
    in: (folder) => listedFolderLevel(reach, folder),
    group: (channelWireId) => listedGroupLevel(reach, channelWireId),
  };
}
