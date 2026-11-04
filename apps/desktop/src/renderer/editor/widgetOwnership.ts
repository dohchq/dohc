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

/** The owners of the widgets an edit draws again, by their new position. When
 *  the edit's range holds as many as before, each keeps its owner in order, so
 *  a widget between two of the edit's changes, or under a remote update, keeps
 *  its DOM. Otherwise each keeps its owner where `mapping` moves it. */
export function ownersInRange(
  previous: readonly Decoration[],
  positions: readonly number[],
  mapping: Mappable,
): Map<number, string> {
  const owned = previous
    .filter((decoration) => typeof decoration.spec.ownerKey === "string")
    .sort((a, b) => a.from - b.from);
  if (owned.length !== positions.length) return mapWidgetOwners(owned, mapping);
  return new Map(positions.map((pos, index) => [pos, owned[index]!.spec.ownerKey as string]));
}
