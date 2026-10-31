import { useCallback, useState } from "react";
import { momentDiffTabPath, siteTabPath } from "../workbench/workbenchState";

const EMPTY_TAB_LABELS: ReadonlyMap<string, string> = new Map();
const NO_ANSWERED_TABS: ReadonlySet<string> = new Set();

type KnownTabTitles = {
  workspaceId: string;
  titles: ReadonlyMap<string, string>;
  // Tabs whose own page has answered. Its title, or its lack of one, is the
  // page's from then on: a path an opener remembered may be one History's
  // rules now hide.
  answered: ReadonlySet<string>;
};

export function useTabTitles(workspaceId: string) {
  // Display labels that do not belong in tab identity: moment pages report
  // the durable path returned with their record.
  const [knownTabTitles, setKnownTabTitles] = useState<KnownTabTitles>({
    workspaceId: "",
    titles: EMPTY_TAB_LABELS,
    answered: NO_ANSWERED_TABS,
  });
  // A null title forgets the one learned, such as a path History now hides.
  const setTabTitle = useCallback(
    (tabPath: string, title: string | null, fromPage: boolean) => {
      setKnownTabTitles((previous) => {
        // A title learned for another workspace never labels this one's tabs.
        const known = previous.workspaceId === workspaceId
          ? previous
          : { workspaceId, titles: EMPTY_TAB_LABELS, answered: NO_ANSWERED_TABS };
        if (!fromPage && known.answered.has(tabPath)) return previous;
        const answered = fromPage && !known.answered.has(tabPath)
          ? new Set(known.answered).add(tabPath)
          : known.answered;
        if ((known.titles.get(tabPath) ?? null) === title && answered === known.answered) {
          return known === previous ? previous : known;
        }
        const titles = new Map(known.titles);
        if (title === null) titles.delete(tabPath);
        else titles.set(tabPath, title);
        return { workspaceId, titles, answered };
      });
    },
    [workspaceId],
  );
  // What whoever opens a change's tab knows of its path, until its page answers.
  const rememberMomentDiffPath = useCallback(
    (momentId: string, filePath: string) => setTabTitle(momentDiffTabPath(momentId), filePath, false),
    [setTabTitle],
  );
  // The change's page answered: its path, or null when History's rules hide it.
  const resolveMomentDiffPath = useCallback(
    (momentId: string, filePath: string | null) => setTabTitle(momentDiffTabPath(momentId), filePath, true),
    [setTabTitle],
  );
  // An app's page answered with the app's title.
  const resolveAppTitle = useCallback(
    (siteRoot: string, title: string) => setTabTitle(siteTabPath(siteRoot), title, true),
    [setTabTitle],
  );
  const tabLabels =
    knownTabTitles.workspaceId === workspaceId
      ? knownTabTitles.titles
      : EMPTY_TAB_LABELS;

  return {
    tabLabels,
    rememberMomentDiffPath,
    resolveMomentDiffPath,
    resolveAppTitle,
  };
}
