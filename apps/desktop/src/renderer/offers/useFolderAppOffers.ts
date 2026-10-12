import { useCallback, useEffect, useRef, useState } from "react";
import type { FolderAppAnswer } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { dirnameOf } from "../path";
import { isVirtualTabPath } from "../workbench/workbenchState";
import { observeFolderAppOffers, readFolderAppOffer, type OfferWorkspaceToken } from "./folderApp";

export type FolderApps = ReadonlyMap<string, FolderAppAnswer>;

const NO_APPS: FolderApps = new Map();
let generations = 0;

// The folders that are apps, as main recognizes them. It asks about a folder
// only when the person expands it or opens a file in it, never per tree row,
// and again when the window regains focus: main follows at most 128 folders
// and stops refreshing the oldest. The workspace root is never asked, since
// main would list the whole workspace for it.
export function useFolderAppOffers(input: {
  workspaceId: string;
  enabled: boolean;
  expandedFolders: readonly string[];
  activePath: string | null;
  onError(folder: string, error: unknown, retry: () => void): void;
}): FolderApps {
  const { workspaceId, enabled } = input;
  const [apps, setApps] = useState<FolderApps>(NO_APPS);
  const token = useRef<OfferWorkspaceToken>({ workspaceId, generation: 0 });
  const asked = useRef(new Set<string>());
  const expanded = useRef(new Set<string>());
  const onError = useRef(input.onError);
  onError.current = input.onError;
  const activeFolder = input.activePath && !isVirtualTabPath(input.activePath)
    ? dirnameOf(input.activePath) || null
    : null;
  const activeFolderRef = useRef(activeFolder);
  activeFolderRef.current = activeFolder;

  const apply = useCallback((answer: FolderAppAnswer) => {
    setApps((current) => {
      const held = current.get(answer.folder);
      if (answer.isApp ? held && JSON.stringify(held.run) === JSON.stringify(answer.run) : !held) return current;
      const next = new Map(current);
      if (answer.isApp) next.set(answer.folder, answer);
      else next.delete(answer.folder);
      return next;
    });
  }, []);

  const ask = useCallback((folder: string) => {
    asked.current.add(folder);
    readFolderAppOffer({
      token: token.current,
      currentToken: () => token.current,
      folder,
      read: (workspaceId, folder) => bridge().getFolderApp({ workspaceId, folder }),
    }).then(
      (answer) => { if (answer) apply(answer); },
      (error: unknown) => onError.current(folder, error, () => ask(folder)),
    );
  }, [apply]);

  // A new token on every workspace, so a late answer for A never lands after
  // A -> B -> A.
  useEffect(() => {
    token.current = { workspaceId, generation: ++generations };
    asked.current = new Set();
    expanded.current = new Set();
    setApps(NO_APPS);
    return () => {
      token.current = { workspaceId: "", generation: ++generations };
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!enabled) return;
    return observeFolderAppOffers({
      token: token.current,
      currentToken: () => token.current,
      wants: (folder) => asked.current.has(folder),
      subscribe: (listener) => bridge().onFolderAppChanged(listener),
      onChanged: apply,
    });
  }, [enabled, workspaceId, apply]);

  // Each expansion is a navigation: collapsing forgets the folder, so
  // expanding it again asks again.
  useEffect(() => {
    if (!enabled) return;
    const next = new Set(input.expandedFolders);
    for (const folder of next) if (!expanded.current.has(folder)) ask(folder);
    expanded.current = next;
  }, [enabled, workspaceId, input.expandedFolders, ask]);

  useEffect(() => {
    if (enabled && activeFolder) ask(activeFolder);
  }, [enabled, workspaceId, input.activePath, activeFolder, ask]);

  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => {
      const folders = new Set(expanded.current);
      if (activeFolderRef.current) folders.add(activeFolderRef.current);
      for (const folder of folders) ask(folder);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, ask]);

  return apps;
}
