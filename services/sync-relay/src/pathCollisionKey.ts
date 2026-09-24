// The key two paths share when a computer's disk may hold them as one file:
// each component in NFKC form, case-folded, and without the trailing dots
// and spaces Windows drops. It folds more than any common file system does.
// A false match only refuses a write; a missed one would put two files in
// one place.
export function pathCollisionKey(path: string): string {
  return path.split("/").map(componentKey).join("/");
}

function componentKey(name: string): string {
  return name.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFKC").replace(/[. ]+$/u, "");
}
