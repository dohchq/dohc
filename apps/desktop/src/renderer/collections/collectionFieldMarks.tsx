import { Zap } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ListCollectionFieldMarksPayload } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { Tooltip, useTooltip } from "@dohc/collection-views/tooltip";

// The ⚡ marks on fields that switched-on automations set. Main reads every
// automations.yaml, so the renderer asks it for one Collection's marks. The
// window keeps one store per workspace: every table and record that shows a
// Collection shares one read, and a Collection is read again only after
// main says the automations it read changed. Nothing here runs per cell.

export type FieldMarks = ReadonlyMap<string, readonly string[]>;
/** A document Collection by its folder, or one table of a dataset Collection. */
type MarksTarget = { collectionPath: string } | { datasetId: string; table: string };

const NO_MARKS: FieldMarks = new Map();
const AND = new Intl.ListFormat("en", { type: "conjunction" });

interface Entry {
  target: MarksTarget;
  marks: FieldMarks;
  /** The store revision the marks were read at, or -1 before the first read. */
  revision: number;
  reading: boolean;
  listeners: Set<() => void>;
}

function sameMarks(left: FieldMarks, right: FieldMarks): boolean {
  if (left.size !== right.size) return false;
  for (const [field, names] of left) {
    const other = right.get(field);
    if (!other || other.length !== names.length || other.some((name, index) => name !== names[index])) return false;
  }
  return true;
}

function createFieldMarksStore(workspaceId: string) {
  let revision = 0;
  const entries = new Map<string, Entry>();

  async function read(target: MarksTarget, entry: Entry): Promise<void> {
    if (entry.reading || entry.revision === revision) return;
    entry.reading = true;
    const asked = revision;
    try {
      const payload: ListCollectionFieldMarksPayload = { workspaceId, ...target };
      const result = await bridge().listCollectionFieldMarks(payload);
      const marks: FieldMarks = new Map(result.marks.map((mark) => [mark.field, mark.automations]));
      // Unchanged marks keep their identity, so the table does not render again.
      if (!sameMarks(entry.marks, marks)) {
        entry.marks = marks;
        for (const listener of entry.listeners) listener();
      }
    } catch {
      // The marks already shown stay until the next change reads again.
    } finally {
      entry.revision = asked;
      entry.reading = false;
    }
    // A change arrived during the read: read once more for those still showing it.
    if (entry.revision !== revision && entry.listeners.size > 0) void read(target, entry);
  }

  return {
    marks(key: string): FieldMarks {
      return entries.get(key)?.marks ?? NO_MARKS;
    },
    subscribe(key: string, target: MarksTarget, listener: () => void): () => void {
      const entry: Entry = entries.get(key) ?? { target, marks: NO_MARKS, revision: -1, reading: false, listeners: new Set() };
      entries.set(key, entry);
      entry.listeners.add(listener);
      void read(target, entry);
      return () => entry.listeners.delete(listener);
    },
    /** Main's automations changed: Collections on screen read again, the rest when they next show. */
    invalidate(): void {
      revision += 1;
      for (const entry of entries.values()) {
        if (entry.listeners.size > 0) void read(entry.target, entry);
      }
    },
  };
}

const FieldMarksStore = createContext<ReturnType<typeof createFieldMarksStore> | null>(null);

/** The window's field marks for one workspace. A store for another workspace never paints this one. */
export function CollectionFieldMarksProvider(props: { workspaceId: string; children: ReactNode }) {
  const { workspaceId } = props;
  const store = useMemo(() => createFieldMarksStore(workspaceId), [workspaceId]);
  // A layout effect, so it listens before any view's first read starts.
  useLayoutEffect(() => bridge().onCollectionAutomationsChanged((event) => {
    if (event.workspaceId === workspaceId) store.invalidate();
  }), [store, workspaceId]);
  return <FieldMarksStore.Provider value={store}>{props.children}</FieldMarksStore.Provider>;
}

function useFieldMarks(target: MarksTarget | null): FieldMarks {
  const store = useContext(FieldMarksStore);
  // The key names the target, so a new object for the same one subscribes nothing new.
  const key = target === null ? null : JSON.stringify(target);
  const subscribe = useCallback(
    (listener: () => void) => (store && key !== null && target !== null ? store.subscribe(key, target, listener) : () => undefined),
    [store, key],
  );
  return useSyncExternalStore(subscribe, () => (store && key !== null ? store.marks(key) : NO_MARKS));
}

/**
 * Each marked field in one Collection, with the names of the automations
 * that set it. Null asks for nothing.
 */
export function useCollectionFieldMarks(collectionPath: string | null): FieldMarks {
  return useFieldMarks(collectionPath === null ? null : { collectionPath });
}

/** Each marked field in one table of a dataset Collection. Null asks for nothing. */
export function useDatasetFieldMarks(datasetId: string, table: string | null): FieldMarks {
  return useFieldMarks(table === null ? null : { datasetId, table });
}

/** What a field's ⚡ says: the automations that set it. */
export function automationFieldMarkLabel(automations: readonly string[]): string {
  const names = AND.format(automations.map((name) => `"${name}"`));
  return automations.length === 1 ? `${names} sets this field` : `${names} set this field`;
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
  const tooltip = useTooltip();
  return (
    <span {...tooltip.hoverProps} className="relative inline-flex shrink-0">
      <span
        {...tooltip.focusProps}
        role="img"
        tabIndex={0}
        aria-label="Automation"
        data-testid="automation-field-mark"
        className="inline-flex items-center rounded"
      >
        <AutomationFieldIcon />
      </span>
      <Tooltip {...tooltip.tooltipProps}>{label}</Tooltip>
    </span>
  );
}

/** The marks as a table header shows them, built once per change of marks. */
export function useTableFieldMarks(marks: FieldMarks) {
  return useMemo(
    () => new Map([...marks].map(([field, automations]) => [
      field,
      { icon: <AutomationFieldIcon />, label: automationFieldMarkLabel(automations) },
    ])),
    [marks],
  );
}
