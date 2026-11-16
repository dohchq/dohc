import {
  highestListedLevel,
  levelAtPath,
  listedFolderLevel,
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
  /**
   * The pinned grant's level. For a joined workspace this is the member
   * level, which a Group takes until Group rules exist.
   */
  readonly member: ShareAccess | null;
  /** The highest level anywhere, which decides whether a write offer shows at all. */
  readonly highest: ShareAccess | null;
  /** The level at a file path: an existing file's current path, or a new file's. */
  at(path: string): ShareAccess | null;
  /** The level inside a folder, "" for the root: where a new file in it lands. */
  in(folder: string): ShareAccess | null;
}

const NO_LEVELS: ShareViewLevels = { member: null, highest: null, at: () => null, in: () => null };

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
  if (selector === null) return NO_LEVELS;
  const member = selector.access;
  const reach =
    selector.wholeWorkspace === true && shareView.reach !== undefined
      ? parseListedReach(shareView.reach)
      : undefined;
  // A stored reach that can't be read gives no level, rather than the
  // member level it may have narrowed.
  if (reach === null) return { ...NO_LEVELS, member };
  if (reach === undefined) return { member, highest: member, at: () => member, in: () => member };
  return {
    member,
    highest: highestListedLevel(reach),
    at: (path) => levelAtPath(reach, path),
    in: (folder) => listedFolderLevel(reach, folder),
  };
}
