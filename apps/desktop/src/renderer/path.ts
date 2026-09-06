export function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function dirnameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}
