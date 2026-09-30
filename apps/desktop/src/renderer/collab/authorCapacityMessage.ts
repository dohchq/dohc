export function authorCapacityMessage(path: string): string {
  return `dohc could not save ${path} because too many authors have unsaved edits.`;
}
