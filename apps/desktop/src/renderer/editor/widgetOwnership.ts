import type { Node } from "@tiptap/pm/model";
import type { Mappable, MapResult } from "@tiptap/pm/transform";
import type { Decoration } from "@tiptap/pm/view";

export function mapWidgetOwners(
  decorations: readonly Decoration[],
  mapping: Mappable,
): Map<number, string> {
  const owners = new Map<number, string>();
  for (const decoration of decorations) {
    const ownerKey = decoration.spec.ownerKey;
    if (typeof ownerKey !== "string") continue;
    // Attach to the following block when content is inserted at its boundary.
    const mapped = mapping.mapResult(decoration.from, 1);
    if (!mapped.deleted) owners.set(mapped.pos, ownerKey);
  }
  return owners;
}

/** Moves a position through an edit's own steps, or through its changed range
 *  when the steps replaced it. A remote update replaces the whole document, so
 *  only the changed range can place it. */
export function throughEdit(steps: Mappable, range: Mappable): Mappable {
  const mapResult = (pos: number, assoc = 1): MapResult => {
    const result = steps.mapResult(pos, assoc);
    return result.deleted ? range.mapResult(pos, assoc) : result;
  };
  return { mapResult, map: (pos, assoc) => mapResult(pos, assoc).pos };
}

export type OwnedBlock = { at: number; node: Node };

// Equal blocks have the same attributes, size and text, so only blocks that
// share this key are compared.
const sameKey = (node: Node) => `${JSON.stringify(node.attrs)}:${node.nodeSize}:${node.textContent}`;

/** The owners of the widgets an edit draws again, by their new position. A
 *  widget keeps its owner where `mapping` moves it. A remote update replaces
 *  the whole document, so its steps place nothing: there a block keeps the
 *  owner of an unplaced block that was equal to it. A block that changed or
 *  is new gets no owner. `blocksBefore` lists the range's blocks in the old
 *  document; it is read only when a widget is left unplaced. */
export function ownersInRange(
  previous: readonly Decoration[],
  blocks: readonly OwnedBlock[],
  mapping: Mappable,
  blocksBefore: () => readonly OwnedBlock[],
): Map<number, string> {
  const wanted = new Set(blocks.map(({ at }) => at));
  const owners = new Map<number, string>();
  const unplaced = new Map<number, string>();
  for (const decoration of previous) {
    const ownerKey = decoration.spec.ownerKey;
    if (typeof ownerKey !== "string") continue;
    const mapped = mapping.mapResult(decoration.from, 1);
    if (!mapped.deleted && wanted.has(mapped.pos) && !owners.has(mapped.pos)) {
      owners.set(mapped.pos, ownerKey);
    } else {
      unplaced.set(decoration.from, ownerKey);
    }
  }
  if (unplaced.size === 0) return owners;
  const candidates = new Map<string, OwnedBlock[]>();
  for (const block of blocksBefore()) {
    if (!unplaced.has(block.at)) continue;
    const key = sameKey(block.node);
    const list = candidates.get(key);
    if (list) list.push(block);
    else candidates.set(key, [block]);
  }
  for (const { at, node } of blocks) {
    if (owners.has(at)) continue;
    const list = candidates.get(sameKey(node));
    const index = list ? list.findIndex((old) => old.node.eq(node)) : -1;
    if (index < 0) continue;
    const [old] = list!.splice(index, 1);
    owners.set(at, unplaced.get(old!.at)!);
  }
  return owners;
}
