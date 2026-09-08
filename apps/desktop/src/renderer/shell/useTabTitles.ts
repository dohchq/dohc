import { useCallback, useState } from "react";
import {
  momentDiffTabPath,
  pluginDetailsTabPath,
  pluginWebAppTabPath,
} from "../workbench/workbenchState";

const EMPTY_TAB_LABELS: ReadonlyMap<string, string> = new Map();

export function useTabTitles(workspaceId: string) {
  // Display labels that do not belong in tab identity. Plugin pages report
  // their manifest titles after mount; moment pages report the durable path
  // returned with their record. Reading plugin manifests from here instead
  // failed the desktop e2e in 4 of 6 runs because that request races startup.
  const [knownTabTitles, setKnownTabTitles] = useState<{
    workspaceId: string;
    titles: ReadonlyMap<string, string>;
  }>({ workspaceId: "", titles: EMPTY_TAB_LABELS });
  const rememberTabTitle = useCallback(
    (tabPath: string, title: string) => {
      setKnownTabTitles((previous) => {
        // A title learned for another workspace never labels this one's tabs.
        const known =
          previous.workspaceId === workspaceId ? previous.titles : EMPTY_TAB_LABELS;
        if (known.get(tabPath) === title) return previous;
        return { workspaceId, titles: new Map(known).set(tabPath, title) };
      });
    },
    [workspaceId],
  );
  const rememberWebAppTitle = useCallback(
    (
      pluginId: string,
      webAppId: string,
      instanceKey: string | null,
      title: string,
    ) =>
      rememberTabTitle(
        pluginWebAppTabPath(pluginId, webAppId, instanceKey),
        title,
      ),
    [rememberTabTitle],
  );
  const rememberPluginDetailsTitle = useCallback(
    (pluginId: string, directoryName: string, title: string) =>
      rememberTabTitle(pluginDetailsTabPath(pluginId, directoryName), title),
    [rememberTabTitle],
  );
  const rememberMomentDiffPath = useCallback(
    (momentId: string, filePath: string) =>
      rememberTabTitle(momentDiffTabPath(momentId), filePath),
    [rememberTabTitle],
  );
  const tabLabels =
    knownTabTitles.workspaceId === workspaceId
      ? knownTabTitles.titles
      : EMPTY_TAB_LABELS;

  return {
    tabLabels,
    rememberWebAppTitle,
    rememberPluginDetailsTitle,
    rememberMomentDiffPath,
  };
}
