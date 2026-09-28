import { foldPathSegment } from "@dohc/workspace-contracts/path-floor";

// The key two paths share when a computer's disk may hold them as one file:
// each component in NFKC form, case-folded, and without the trailing dots
// and spaces Windows drops. It folds more than any common file system does.
// A false match only refuses a write; a missed one would put two files in
// one place.
export function pathCollisionKey(path: string): string {
  return path.split("/").map(componentKey).join("/");
}

// Lower, upper, then lower again, so every spelling of a letter lands on one
// form: "ẞ", "ß" and "ss" all become "ss", and "ς" and "σ" become one sigma.
function componentKey(name: string): string {
  const compatible = name.normalize("NFKC").toLowerCase().toUpperCase().toLowerCase();
  return foldPathSegment(compatible).replace(/[. ]+$/u, "");
}
