import { ReplaceStep, type Mappable, type MapResult, type Transform } from "@tiptap/pm/transform";
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

/** Whether a step replaced the whole document, as a remote update or an undo
 *  through y-tiptap does. Its steps then place nothing. */
export function replacesDocument(tr: Transform): boolean {
  return tr.steps.some(
    (step, index) => step instanceof ReplaceStep && step.from === 0 && step.to === tr.docs[index]!.content.size,
  );
}

export type ChangedRange = { from: number; to: number; toBefore: number };

/** `range` widened to every position the edit's steps changed. Comparing the
 *  documents places a block inserted beside an identical one after it, where
 *  the steps put it before, and the widget between must follow the steps. */
export function withSteps(range: ChangedRange, tr: Transform): ChangedRange {
  let start = Infinity;
  let end = -Infinity;
  for (const map of tr.mapping.maps) {
    if (start <= end) {
      start = map.map(start, -1);
      end = map.map(end, 1);
    }
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      start = Math.min(start, newStart);
      end = Math.max(end, newEnd);
    });
  }
  if (start > end) return range;
  const to = Math.max(range.to, end);
  // Everything after the changes is the same in both documents.
  return { from: Math.min(range.from, start), to, toBefore: to - tr.doc.content.size + tr.before.content.size };
}

/** Gives each widget the owner of the widget that had its place among the
 *  range's widgets, as when every widget was keyed by its place among the
 *  blocks. The blocks before the range are the same, so their count is too. */
export function ownersByPlace(previous: readonly Decoration[], positions: readonly number[]): Map<number, string> {
  const owners = new Map<number, string>();
  previous
    .filter((decoration) => typeof decoration.spec.ownerKey === "string")
    .sort((a, b) => a.from - b.from)
    .slice(0, positions.length)
    .forEach((decoration, index) => owners.set(positions[index]!, decoration.spec.ownerKey as string));
  return owners;
}
