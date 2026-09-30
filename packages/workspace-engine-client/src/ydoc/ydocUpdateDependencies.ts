import * as Y from "yjs";

// Later clocks from a refused client need its missing structs. References
// also catch edits from another client that used those structs as anchors.
export function ydocUpdateDependsOn(update: Uint8Array, refused: Uint8Array): boolean {
  const missing = Y.parseUpdateMeta(refused);
  const decoded = Y.decodeUpdate(update);
  const requires = (id: Y.ID | null): boolean => id !== null &&
    missing.from.has(id.client) && id.clock >= missing.from.get(id.client)!;
  for (const struct of decoded.structs) {
    if (requires(struct.id)) return true;
    if (struct instanceof Y.Item &&
        (requires(struct.origin) || requires(struct.rightOrigin) ||
          (struct.parent instanceof Y.ID && requires(struct.parent)))) return true;
  }
  // A deletion-only update has no new client clock, but can delete missing items.
  for (const [client, ranges] of decoded.ds.clients) {
    const start = missing.from.get(client);
    const end = missing.to.get(client);
    if (start !== undefined && end !== undefined &&
        ranges.some(range => range.clock < end && range.clock + range.len > start)) return true;
  }
  return false;
}
