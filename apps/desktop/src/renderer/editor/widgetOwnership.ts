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

/** The owners of the widgets an edit draws again, by their new position. A
 *  widget keeps its owner where `mapping` moves it. A remote update replaces
 *  the whole document, so its steps place nothing: there a block keeps the
 *  owner of the next unplaced block that was equal to it, in order. A block
 *  that changed or is new gets no owner. */
export function ownersInRange(
  previous: readonly Decoration[],
  blocks: readonly { at: number; node: Node }[],
  mapping: Mappable,
  blockBefore: (from: number) => Node | null,
): Map<number, string> {
  const owned = previous
    .filter((decoration) => typeof decoration.spec.ownerKey === "string")
    .sort((a, b) => a.from - b.from);
  const wanted = new Set(blocks.map(({ at }) => at));
  const owners = new Map<number, string>();
  const unplaced: Decoration[] = [];
  for (const decoration of owned) {
    const mapped = mapping.mapResult(decoration.from, 1);
    if (!mapped.deleted && wanted.has(mapped.pos) && !owners.has(mapped.pos)) {
      owners.set(mapped.pos, decoration.spec.ownerKey as string);
    } else {
      unplaced.push(decoration);
    }
  }
  let next = 0;
  for (const { at, node } of blocks) {
    if (owners.has(at)) continue;
    for (let index = next; index < unplaced.length; index += 1) {
      if (!blockBefore(unplaced[index]!.from)?.eq(node)) continue;
      owners.set(at, unplaced[index]!.spec.ownerKey as string);
      next = index + 1;
      break;
    }
  }
  return owners;
}
