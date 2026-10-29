import { mkdir } from "node:fs/promises";

/** A host's private folder for a test, made when first asked for, as a host would have made it. */
export const privateFolder = (path: string) => async () => {
  await mkdir(path, { recursive: true });
  return path;
};
