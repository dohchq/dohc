import { accountWords } from "@dohc/interface-words/account";
import type { AccountWorkspace } from "../server/api";

/** The name a workspace shows under: its own, or the fallback before its computer sent one. */
export function workspaceName(workspace: Pick<AccountWorkspace, "name">): string {
  return workspace.name ?? accountWords.unnamedWorkspace;
}
