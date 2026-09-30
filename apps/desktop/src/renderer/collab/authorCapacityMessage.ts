export function authorCapacityMessage(path: string): string {
  return `dohc could not save ${path} because this file has too many authors waiting to save.`;
}
