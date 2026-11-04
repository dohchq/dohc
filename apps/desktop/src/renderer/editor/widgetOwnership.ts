import type { Mappable, MapResult, Mapping } from "@tiptap/pm/transform";
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

export type ChangedRange = { from: number; to: number; toBefore: number };

/** `range` widened to every position the edit's steps changed. Comparing the
 *  documents places a block inserted beside an identical one after it, where
 *  the steps put it before, and the widget between must follow the steps. A
 *  remote update replaces the whole document, so its steps add nothing. */
export function withSteps(range: ChangedRange, steps: Mapping, size: number, sizeBefore: number): ChangedRange {
  let start = Infinity;
  let end = -Infinity;
  for (const map of steps.maps) {
    if (start <= end) {
      start = map.map(start, -1);
      end = map.map(end, 1);
    }
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      start = Math.min(start, newStart);
      end = Math.max(end, newEnd);
    });
  }
  if (start > end || (start <= 0 && end >= size)) return range;
  const to = Math.max(range.to, end);
  // Everything after the changes is the same in both documents.
  return { from: Math.min(range.from, start), to, toBefore: to - size + sizeBefore };
}

/** The owners of the widgets an edit draws again, by their new position. A
 *  widget sits `inside` positions after its block's start, and keeps its owner
 *  where `steps` move that start. A widget the steps cannot place, as under a
 *  remote update or when the edit replaced its block's opening, keeps its owner
 *  if the block at its place among the range's widgets has none, as when every
 *  widget was keyed by its place among the blocks. */
export function ownersInRange(
  previous: readonly Decoration[],
  positions: readonly number[],
  steps: Mappable,
  inside = 0,
): Map<number, string> {
  const wanted = new Set(positions);
  const owners = new Map<number, string>();
  const unplaced: Array<{ index: number; ownerKey: string }> = [];
  previous
    .filter((decoration) => typeof decoration.spec.ownerKey === "string")
    .sort((a, b) => a.from - b.from)
    .forEach((decoration, index) => {
      const ownerKey = decoration.spec.ownerKey as string;
      // The block's start, not the widget's place inside it, so content added
      // at the start of the block's body does not move it.
      const mapped = steps.mapResult(decoration.from - inside, 1);
      const pos = mapped.pos + inside;
      if (!mapped.deleted && wanted.has(pos) && !owners.has(pos)) owners.set(pos, ownerKey);
      else unplaced.push({ index, ownerKey });
    });
  for (const { index, ownerKey } of unplaced) {
    const pos = positions[index];
    if (pos !== undefined && !owners.has(pos)) owners.set(pos, ownerKey);
  }
  return owners;
}
