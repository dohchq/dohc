import { useEffect, useMemo, useState } from "react";
import { bridge } from "../bridge";
import { useRequestSequence } from "../useRequestSequence";

/** A pinned app as the sidebar shows it. */
export interface PinnedApp {
  root: string;
  // The app's own title, or its folder until dohc has read the app.
  label: string;
  // dohc no longer finds an app in this folder.
  missing: boolean;
}

function folderLabel(appRoot: string): string {
  const folder = appRoot.split("/").filter((part) => part !== "" && part !== ".").at(-1);
  return folder ?? "App";
}

/** The letter that tells pinned apps apart in the sidebar. */
export function pinnedAppInitial(label: string): string {
  return (Array.from(label.trim())[0] ?? "A").toLocaleUpperCase();
}

/**
 * Reads each pinned app once when the pins change, so the sidebar can use its
 * title. Until an answer arrives the folder stands in.
 */
export function usePinnedApps(
  workspaceId: string,
  roots: readonly string[],
): readonly PinnedApp[] {
  const [read, setRead] = useState<ReadonlyMap<string, { title: string; missing: boolean }>>(
    new Map(),
  );
  const requests = useRequestSequence([workspaceId]);
  const key = roots.join("\0");

  useEffect(() => {
    if (roots.length === 0) return;
    const request = requests.next();
    void Promise.all(
      roots.map(async (root) => {
        const site = await bridge()
          .getSitePackage({ workspaceId, path: root })
          .catch(() => undefined);
        // A failed read says nothing about the app, so the folder stays.
        if (site === undefined) return null;
        const found = site !== null && site.root === root;
        return [root, { title: found ? site.title : folderLabel(root), missing: !found }] as const;
      }),
    ).then((answers) => {
      if (!requests.isCurrent(request)) return;
      setRead(new Map(answers.filter((answer) => answer !== null)));
    });
    // The joined key stands for the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, requests, workspaceId]);

  // The same pins and titles answer the same list, so what reads it, such
  // as the command palette, does not rebuild on every render.
  return useMemo(
    () =>
      roots.map((root) => {
        const known = read.get(root);
        return {
          root,
          label: known?.title ?? folderLabel(root),
          missing: known?.missing ?? false,
        };
      }),
    // The joined key stands for the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, read],
  );
}
