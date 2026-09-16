import type { Mappable } from "@tiptap/pm/transform";
import type { DecorationSet } from "@tiptap/pm/view";

export function mapWidgetOwners(
  decorations: DecorationSet,
  mapping: Mappable,
): Map<number, string> {
  const owners = new Map<number, string>();
  for (const decoration of decorations.find()) {
    const ownerKey = decoration.spec.ownerKey;
    if (typeof ownerKey !== "string") continue;
    // Attach to the following block when content is inserted at its boundary.
    const mapped = mapping.mapResult(decoration.from, 1);
    if (!mapped.deleted) owners.set(mapped.pos, ownerKey);
  }
  return owners;
}
