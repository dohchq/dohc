import type { CollectionRecord } from "@dohc/workspace-contracts";

/**
 * The text that names a record where no resolved label exists: the record's
 * `title` then `name` field when it holds a non-empty string (an exact key
 * first, then the alphabetically first case-insensitive match), else the
 * filename without its `.md` suffix. Mirrors the engine's
 * `relation_target_label`, so a picker row and a resolved relation cell name
 * the same record the same way.
 */
export function recordLabel(record: CollectionRecord): string {
  for (const preferred of ["title", "name"]) {
    const matches = record.values.filter(
      (entry) => entry.field.toLowerCase() === preferred,
    );
    const entry =
      matches.find((candidate) => candidate.field === preferred) ??
      matches.sort((a, b) => (a.field < b.field ? -1 : 1))[0];
    if (entry && typeof entry.value === "string") {
      const label = entry.value.trim();
      if (label.length > 0) return label;
    }
  }
  const basename = record.path.split("/").at(-1) ?? record.path;
  return basename.toLowerCase().endsWith(".md")
    ? basename.slice(0, -3)
    : basename;
}
