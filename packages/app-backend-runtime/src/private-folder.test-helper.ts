import { mkdir } from "node:fs/promises";

export const privateFolder = (path: string) => async () => {
  await mkdir(path, { recursive: true });
  return path;
};
