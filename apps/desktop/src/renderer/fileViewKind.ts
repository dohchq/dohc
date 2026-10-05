import { fileKindForPath, type FileDisplayKind } from "@dohc/workspace-contracts/kinds";

export function classifyForView(path: string): FileDisplayKind {
  return fileKindForPath(path).displayKind;
}
