import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { isComposingKey } from "../ui/keys";
import { RECORD_PANEL_DEFAULT_WIDTH } from "../workbench/workbenchState";
import { isRecordBodyTextKey } from "./RecordPanel";

// What both kinds of Collection page do with the record panel: which record
// is open, where focus goes, what the page's host keeps with its tab, and
// which side panel has the place at the right of the view. Each page gives
// the panel its record's fields and body.

/** What a Collection page's host keeps for the record panel, with the page's tab. */
export interface RecordPanelHost {
  /**
   * The record its host keeps with the page's tab, by its key. The page shows it open when it starts. After
   * that the page only learns from it that another copy of the tab emptied it.
   */
  initialOpenRecord?: string | null;
  /** The page opened a record in its panel, by the record's key, or closed the panel, for null. */
  onOpenRecordChange?(record: string | null): void;
  /** The record panel's width when the page starts. */
  initialRecordPanelWidth?: number;
  /** A resize of the record panel ended. */
  onRecordPanelWidthChange?(width: number): void;
}

export interface RecordPanelOptions extends RecordPanelHost {
  /**
   * The ⚡ panel, which has the same place. `close` asks it to close, then runs `then`. A person who keeps a
   * draft there keeps the panel, and `then` never runs.
   */
  automations?: { open: boolean; close(then: () => void): void };
  /**
   * Runs `then` once what the open record holds unsaved is saved, as before the record leaves the panel. A
   * save that fails keeps the record, and `then` never runs. Absent, the record holds nothing of its own.
   */
  settle?(then: () => void): void;
  /** The panel closes, before focus leaves it. */
  onClose?(): void;
}

export function useRecordPanel(options: RecordPanelOptions) {
  // The record the panel shows, by its key. The host keeps it with the page's tab, so the panel opens again with the tab.
  const [openKey, setOpenKey] = useState<string | null>(options.initialOpenRecord ?? null);
  const openKeyRef = useRef(openKey);
  openKeyRef.current = openKey;
  const [width, setWidthState] = useState(options.initialRecordPanelWidth ?? RECORD_PANEL_DEFAULT_WIDTH);
  const element = useRef<HTMLElement | null>(null);
  // What opened the panel, which takes focus back when it closes, and whether the panel takes focus at the next commit.
  const opener = useRef<HTMLElement | null>(null), focusPanel = useRef(false);
  const latest = useRef(options);
  latest.current = options;
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const settle = (then: () => void) => (latest.current.settle ? latest.current.settle(then) : then());
  /**
   * Runs `then` once what the open record holds unsaved is saved, as before something else takes the record's
   * place. With no record open it runs at once. It never runs once the page has closed.
   */
  function afterSettled(then: () => void): void {
    const run = () => { if (alive.current) then(); };
    if (openKeyRef.current !== null) settle(run);
    else run();
  }

  /**
   * Opens a record in the panel, in place of the record it shows. Focus moves
   * to the panel, and comes back to what opened it when the panel closes.
   * `shown` runs as the record takes the panel, with whether the panel
   * showed another record or none until then.
   */
  function open(key: string, shown?: (changed: boolean) => void): void {
    const focused = document.activeElement;
    const from = focused instanceof HTMLElement && focused !== document.body ? focused : null;
    const show = () => {
      if (!alive.current) return;
      opener.current = from;
      const changed = openKeyRef.current !== key;
      shown?.(changed);
      if (!changed) { element.current?.focus({ preventScroll: true }); return; }
      focusPanel.current = true;
      setOpenKey(key);
      latest.current.onOpenRecordChange?.(key);
    };
    // One side panel shows at a time. Automations closes first, and keeps its place if the person keeps a draft there.
    const take = () => { if (latest.current.automations?.open) latest.current.automations.close(show); else show(); };
    // The record this one replaces keeps the panel until what it holds is saved.
    if (openKeyRef.current !== null && openKeyRef.current !== key) settle(take);
    else take();
  }

  /**
   * Closes the panel. Focus the panel held goes back to what opened it, or
   * to the table. `fromPage`: Escape on the page closed it, so focus goes
   * back from wherever on the page it is.
   */
  function close(focus: "opener" | "table" | "none", fromPage = false): void {
    if (openKeyRef.current === null) return;
    settle(() => closeNow(focus, fromPage));
  }
  function closeNow(focus: "opener" | "table" | "none", fromPage = false): void {
    if (!alive.current || openKeyRef.current === null) return;
    latest.current.onClose?.();
    const active = document.activeElement, from = opener.current;
    opener.current = null;
    // Otherwise, focus the person has moved to the page stays where they put it.
    if (focus !== "none" && (fromPage || active === null || active === document.body || element.current?.contains(active))) {
      const target = focus === "opener" && from?.isConnected ? from : element.current?.parentElement?.querySelector<HTMLElement>('[role="grid"]');
      target?.focus({ preventScroll: true });
    }
    setOpenKey(null);
    latest.current.onOpenRecordChange?.(null);
  }

  useLayoutEffect(() => {
    if (!focusPanel.current) return;
    focusPanel.current = false;
    element.current?.focus({ preventScroll: true });
  }, [openKey]);
  // Two editor groups can show this tab, and its one saved entry holds the record a person last opened or closed
  // in either. When a close in the other copy empties the entry while this copy still shows a record, this copy
  // saves its record again, so the entry is never empty beside a panel that shows one. Neither copy follows the other's record.
  const keptRecord = options.initialOpenRecord ?? null;
  useEffect(() => {
    if (keptRecord === null && openKeyRef.current !== null) latest.current.onOpenRecordChange?.(openKeyRef.current);
  }, [keptRecord]);
  // The ⚡ panel takes the side panel's place when it opens. The record has left the page by then, so nothing of it waits to be saved.
  const automationsOpen = options.automations?.open ?? false;
  useLayoutEffect(() => { if (automationsOpen) closeNow("none"); }, [automationsOpen]);

  /**
   * The page's own Escape. An editor, a picker, a menu and a popover each take
   * theirs, which never reaches here. The next one closes the open record from
   * anywhere on the page, before the table clears its selection.
   */
  function onPageKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Escape" || event.defaultPrevented || isComposingKey(event) || element.current === null) return;
    // A dialog a control of the page opens is the page's child in React, not on the page.
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (isRecordBodyTextKey(event)) return;
    event.preventDefault();
    close("opener", true);
  }

  return {
    openKey,
    openKeyRef,
    /** The panel's own element, which takes focus when a record opens. */
    element,
    width,
    setWidth(next: number): void {
      setWidthState(next);
      latest.current.onRecordPanelWidthChange?.(next);
    },
    open,
    close,
    afterSettled,
    automationsOpen,
    onPageKeyDown,
  };
}
