import { Zap } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { bridge } from "../bridge";

// The ⚡ marks on fields that switched-on automations set. Main reads every
// automations.yaml, so the renderer asks it for one Collection's marks: once
// when a table or a record opens, and again only when main says the
// automations it read changed. Nothing here runs per cell.

/** Rises each time main says the automations it read changed. */
const AutomationsRevision = createContext(0);

export const CollectionAutomationsRevisionProvider = AutomationsRevision.Provider;

/** The revision the shell provides: one subscription for the whole window. */
export function useCollectionAutomationsRevision(workspaceId: string, workspaceIsReady: boolean): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!workspaceIsReady) return;
    return bridge().onCollectionAutomationsChanged((event) => {
      if (event.workspaceId === workspaceId) setRevision((current) => current + 1);
    });
  }, [workspaceId, workspaceIsReady]);
  return revision;
}

const NO_MARKS: ReadonlyMap<string, readonly string[]> = new Map();

/**
 * Each marked field in one Collection, with the names of the automations
 * that set it. Null asks for nothing. A read that fails keeps the marks
 * already shown: they only describe the automations, and the next change
 * reads again.
 */
export function useCollectionFieldMarks(
  workspaceId: string,
  collectionPath: string | null,
): ReadonlyMap<string, readonly string[]> {
  const revision = useContext(AutomationsRevision);
  const [read, setRead] = useState<{ key: string; marks: ReadonlyMap<string, readonly string[]> } | null>(null);
  const key = JSON.stringify([workspaceId, collectionPath]);
  useEffect(() => {
    if (collectionPath === null) return;
    let current = true;
    void (async () => {
      try {
        const result = await bridge().listCollectionFieldMarks({ workspaceId, collectionPath });
        if (current) setRead({ key, marks: new Map(result.marks.map((mark) => [mark.field, mark.automations])) });
      } catch {
        // The marks already shown stay until the next change reads again.
      }
    })();
    return () => {
      current = false;
    };
  }, [workspaceId, collectionPath, key, revision]);
  // A read for another Collection or workspace never marks this one.
  return read?.key === key ? read.marks : NO_MARKS;
}

/** What a field's ⚡ says: the automations that set it. */
export function automationFieldMarkLabel(automations: readonly string[]): string {
  const names = new Intl.ListFormat("en", { type: "conjunction" }).format(automations.map((name) => `"${name}"`));
  return automations.length === 1 ? `Set by the automation ${names}` : `Set by the automations ${names}`;
}

/** The bare ⚡: muted, no border or fill. Whoever places it gives it its words. */
export function AutomationFieldIcon() {
  return <Zap size={12} strokeWidth={1.9} aria-hidden className="shrink-0 text-muted" />;
}

/**
 * The ⚡ beside a field outside a button, such as a record's property. It
 * takes focus, so keyboard and screen reader users reach its words too.
 */
export function AutomationFieldMark(props: { automations: readonly string[] }) {
  const label = automationFieldMarkLabel(props.automations);
  return (
    <span
      role="img"
      tabIndex={0}
      aria-label={label}
      data-testid="automation-field-mark"
      className="group/mark relative inline-flex shrink-0 items-center rounded"
    >
      <AutomationFieldIcon />
      <span
        aria-hidden
        className="dohc-popover pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-max max-w-64 rounded-lg border border-line bg-panel px-2 py-1 text-[12px] font-normal text-ink group-hover/mark:block group-focus-visible/mark:block"
      >
        {label}
      </span>
    </span>
  );
}

/** The marks as a table header shows them, built once per change of marks. */
export function useTableFieldMarks(marks: ReadonlyMap<string, readonly string[]>) {
  return useMemo(
    () => new Map([...marks].map(([field, automations]) => [
      field,
      { icon: <AutomationFieldIcon />, label: automationFieldMarkLabel(automations) },
    ])),
    [marks],
  );
}
