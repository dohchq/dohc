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
 *  widget sits `inside` positions after its block's start, and keeps its owner
 *  where `mapping` moves that start. The steps place nothing under a remote
 *  update, which replaces the whole document, nor a block whose opening an
 *  edit replaced or that it moved. The widgets left keep their owners in
 *  order, as when every widget was keyed by its place among the blocks. */
export function ownersInRange(
  previous: readonly Decoration[],
  positions: readonly number[],
  mapping: Mappable,
  inside = 0,
): Map<number, string> {
  const wanted = new Set(positions);
  const owners = new Map<number, string>();
  const unplaced: string[] = [];
  const owned = previous
    .filter((decoration) => typeof decoration.spec.ownerKey === "string")
    .sort((a, b) => a.from - b.from);
  for (const decoration of owned) {
    const ownerKey = decoration.spec.ownerKey as string;
    // The block's start, not the widget's place inside it, so content added
    // at the start of the block's body does not move it.
    const mapped = mapping.mapResult(decoration.from - inside, 1);
    const pos = mapped.pos + inside;
    if (!mapped.deleted && wanted.has(pos) && !owners.has(pos)) {
      owners.set(pos, ownerKey);
    } else {
      unplaced.push(ownerKey);
    }
  }
  const open = positions.filter((pos) => !owners.has(pos));
  open.slice(0, unplaced.length).forEach((pos, index) => owners.set(pos, unplaced[index]!));
  return owners;
}
