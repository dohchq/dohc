import { Check, Layers, RotateCw } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ListVersionLastChangesResult, WorkspaceVersionRecord } from "../../ipc/bridgeContract";
import {
  MAX_ENGINE_CAPTURE_BINARY_BYTES,
  MAX_ENGINE_CAPTURE_TEXT_BYTES,
} from "../../workspaces/workspaceEngineCaptureLimits";
import { bridge } from "../bridge";
import { relativeTime } from "../relativeTime";
import { EmptyState, IconButton, RetryRow, SecondaryButton } from "../ui/controls";
import { SkeletonRows } from "../ui/SkeletonRows";
import { useRequestSequence } from "../useRequestSequence";
import { versionDotClass } from "./versionHue";
import { NewVersionHint, type VersionNameField, type WorkspaceVersions } from "./WorkspaceVersions";

type LastChange = ListVersionLastChangesResult["versions"][number]["lastChange"];
type Count = number | "failed";
interface Clashes { count: number; more: boolean }

// Clash counts read the open conflicts a page at a time. Past this many pages
// a count shows as a lower bound.
const CLASH_PAGES_MAX = 5;
const megabytes = (bytes: number) => `${bytes / (1024 * 1024)} MB`;
// What a version leaves alone. The sizes are the engine's capture caps:
// larger files stay as they are on disk.
const SAME_IN_EVERY_VERSION =
  `Chats, text files over ${megabytes(MAX_ENGINE_CAPTURE_TEXT_BYTES)}, other files over ${megabytes(MAX_ENGINE_CAPTURE_BINARY_BYTES)} and files History doesn't track stay the same in every version.`;

// The Versions tab: every version in the workspace, the one you're in, how
// each differs from Main, and the actions the titlebar menu offers for the
// version you're in, here for any version.
export function VersionsPage(props: {
  workspaceId: string;
  versions: WorkspaceVersions;
  // The workspace is not ready for a version change.
  disabled?: boolean;
  // Bumped when history grows, so the last changes and the counts re-read.
  historyKey: number;
  // Bumped when version state changed, so everything re-reads.
  versionKey: number;
  onOpenCompare: (versionId: string) => void;
  onReviewConflicts: () => void;
  onError: (fallback: string, error: unknown) => void;
}) {
  const { workspaceId, versions } = props;
  const { snapshot } = versions;
  const [lastChanges, setLastChanges] = useState<Map<string, LastChange> | null>(null);
  const [counts, setCounts] = useState<ReadonlyMap<string, Count>>(new Map());
  const [clashes, setClashes] = useState<ReadonlyMap<string, Clashes>>(new Map());
  const [countRetry, setCountRetry] = useState(0);
  // Relative times stay true while the tab is open.
  const [, setNow] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const versionIds = snapshot?.versions.map((version) => version.id).join("\n") ?? null;

  const lastChangeReads = useRequestSequence([workspaceId]);
  useEffect(() => {
    if (versionIds === null) return;
    const token = lastChangeReads.next();
    bridge().listVersionLastChanges({ workspaceId }).then(
      (result) => {
        if (!lastChangeReads.isCurrent(token)) return;
        setLastChanges(new Map(result.versions.map((entry) => [entry.versionId, entry.lastChange])));
      },
      (error: unknown) => {
        if (!lastChangeReads.isCurrent(token)) return;
        // The rows still show, sorted by when each version was made.
        setLastChanges((current) => current ?? new Map());
        props.onError("dohc could not read when each version last changed.", error);
      },
    );
  }, [workspaceId, versionIds, props.historyKey, props.versionKey]);

  // Versions whose count is out of date. A newer run takes over the ones an
  // older run did not reach.
  const staleCounts = useRef(new Set<string>());
  const countedVersionKey = useRef<string | null>(null);
  const countReads = useRequestSequence([workspaceId]);
  const ordered = useMemo(() => orderVersions(snapshot?.versions ?? [], lastChanges), [snapshot, lastChanges]);
  const activeVersionId = snapshot?.activeVersionId ?? null;
  // Counting waits for the first listing, so it runs in the order the rows show.
  const listed = lastChanges !== null;
  useEffect(() => {
    if (versionIds === null || !listed) return;
    const named = ordered.filter((version) => version.kind !== "main");
    // A change in Main changes every count. A change in a version changes its own.
    const versionKey = `${props.versionKey}\n${versionIds}`;
    const activeIsMain = named.every((version) => version.id !== activeVersionId);
    if (countedVersionKey.current !== versionKey || activeIsMain) {
      for (const version of named) staleCounts.current.add(version.id);
    } else if (activeVersionId !== null) {
      staleCounts.current.add(activeVersionId);
    }
    countedVersionKey.current = versionKey;
    const token = countReads.next();
    void (async () => {
      // One at a time: each count waits its turn behind the workspace's captures.
      for (const version of named) {
        if (!staleCounts.current.has(version.id)) continue;
        let count: Count;
        try {
          count = (await bridge().countWorkspaceVersionChanges({ workspaceId, versionId: version.id })).count;
        } catch {
          count = "failed";
        }
        if (!countReads.isCurrent(token)) return;
        staleCounts.current.delete(version.id);
        setCounts((current) => new Map(current).set(version.id, count));
      }
    })();
  }, [workspaceId, versionIds, listed, props.historyKey, props.versionKey, countRetry]);
  const retryCount = (versionId: string) => {
    staleCounts.current.add(versionId);
    setCounts((current) => {
      const next = new Map(current);
      next.delete(versionId);
      return next;
    });
    setCountRetry((attempt) => attempt + 1);
  };

  const clashReads = useRequestSequence([workspaceId]);
  useEffect(() => {
    if (versionIds === null) return;
    const token = clashReads.next();
    void (async () => {
      const found = new Map<string, Clashes>();
      let after: string | null = null;
      try {
        for (let page = 0; page < CLASH_PAGES_MAX; page += 1) {
          const result = await bridge().listWorkspaceVersionConflicts({
            workspaceId,
            ...(after === null ? {} : { afterConflictId: after }),
          });
          if (!clashReads.isCurrent(token)) return;
          for (const conflict of result.conflicts) {
            if (conflict.origin !== "merge") continue;
            const entry = found.get(conflict.sourceVersionId) ?? { count: 0, more: false };
            found.set(conflict.sourceVersionId, { ...entry, count: entry.count + 1 });
          }
          after = result.nextAfterConflictId;
          if (after === null) break;
        }
      } catch (error) {
        if (!clashReads.isCurrent(token)) return;
        props.onError("dohc could not read which merges have files to decide.", error);
        return;
      }
      // The pages ran out before the list did, so every count is a lower bound.
      if (after !== null) for (const [id, entry] of found) found.set(id, { ...entry, more: true });
      setClashes(found);
    })();
  }, [workspaceId, versionIds, props.versionKey]);

  const [newName, setNewName] = useState<string | null>(null);
  const [nameError, setNameError] = useState<ReactNode>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const restoreButton = useRef(false);
  const hintId = useId();
  useEffect(() => {
    if (newName !== null || !restoreButton.current) return;
    restoreButton.current = false;
    newButton.current?.focus();
  }, [newName]);
  const closeField = () => {
    restoreButton.current = true;
    setNewName(null);
    setNameError(null);
  };
  const field = useMemo<VersionNameField>(() => ({
    refuse: setNameError,
    created: closeField,
    reopen: (name) => {
      setNewName(name);
      setNameError(null);
    },
  }), []);
  const creating = versions.busy === "create";
  const locked = versions.busy !== null || props.disabled === true;

  // New version, or the name field in its place. One shows at a time: in the
  // header once a version exists, and in the empty state while only Main does.
  const newVersion = newName === null ? (
    <SecondaryButton
      ref={newButton}
      data-testid="versions-page-new"
      disabled={locked}
      onClick={() => {
        setNameError(null);
        setNewName("");
      }}
    >
      New version
    </SecondaryButton>
  ) : (
    <div className="w-64 min-w-0 text-left">
      <input
        autoFocus
        aria-label="New version name"
        aria-invalid={nameError !== null || undefined}
        aria-describedby={hintId}
        data-testid="versions-page-new-input"
        value={newName}
        maxLength={80}
        readOnly={creating}
        onChange={(event) => {
          setNewName(event.target.value);
          setNameError(null);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" && !creating) {
            event.preventDefault();
            setNameError(null);
            versions.create(newName, field);
          } else if (event.key === "Escape" && !creating) {
            event.preventDefault();
            event.stopPropagation();
            closeField();
          }
        }}
        onBlur={() => {
          // Leaving a field with a name in it keeps the name.
          if (newName.trim() === "" && !creating) closeField();
        }}
        className="h-8 w-full rounded-md border border-line bg-bg px-2.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink"
      />
      {nameError !== null ? (
        <p id={hintId} data-testid="versions-page-new-error" role="alert" className="m-0 mt-1 text-[12px] leading-4 text-danger">
          {nameError}
        </p>
      ) : (
        <p id={hintId} className="m-0 mt-1 text-[12px] leading-4 text-subtle">
          {creating ? "Creating…" : <NewVersionHint versions={versions} />}
        </p>
      )}
    </div>
  );

  const ready = snapshot !== null && lastChanges !== null;
  const onlyMain = ready && ordered.length <= 1;
  let body: ReactNode;
  if (!ready) {
    body = versions.loadFailed
      ? <RetryRow testId="versions-page-retry" onRetry={versions.reload} />
      : <SkeletonRows layout="list" label="Loading versions..." />;
  } else if (onlyMain) {
    body = (
      <EmptyState icon={Layers} data-testid="versions-page-empty" title="Make a version to try changes without touching Main.">
        {newVersion}
        <p data-testid="versions-page-same" className="m-0 max-w-sm text-[12px] text-muted">{SAME_IN_EVERY_VERSION}</p>
      </EmptyState>
    );
  } else {
    const names = new Map(snapshot.versions.map((version) => [version.id, version.name]));
    body = (
      // Row fills hang outside the column's edge, so the text starts on it.
      <ul aria-label="Versions" data-testid="versions-page-list" className="-mx-2 m-0 list-none p-0">
        {ordered.map((version) => (
          <VersionRow
            key={version.id}
            version={version}
            active={version.id === snapshot.activeVersionId}
            madeFrom={version.madeFromVersionId === undefined ? undefined : names.get(version.madeFromVersionId)}
            lastChange={lastChanges.get(version.id) ?? null}
            count={counts.get(version.id)}
            clashes={clashes.get(version.id)}
            locked={locked}
            onSwitch={() => versions.requestSwitch(version.id)}
            onCompare={() => props.onOpenCompare(version.id)}
            onMerge={() => versions.openMerge(version)}
            onRetryCount={() => retryCount(version.id)}
            onReviewConflicts={props.onReviewConflicts}
          />
        ))}
      </ul>
    );
  }

  return (
    <div data-testid="versions-page" className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg [scrollbar-gutter:stable]">
      {/* The document column, so the page lines up with the editor's text. */}
      <div className="mx-auto flex w-full max-w-[832px] flex-1 flex-col px-14 pb-6">
        <header className="flex shrink-0 items-start justify-between gap-4 pb-4 pt-10">
          <h2 className="m-0 flex h-8 items-center text-base font-semibold text-ink">Versions</h2>
          {ready && !onlyMain ? newVersion : null}
        </header>
        {body}
      </div>
    </div>
  );
}

// Main first, then the rest by their last change, newest first. A version
// with no change of its own sorts by when it was made.
export function orderVersions(
  versions: readonly WorkspaceVersionRecord[],
  lastChanges: ReadonlyMap<string, LastChange> | null,
): WorkspaceVersionRecord[] {
  const changedAt = (version: WorkspaceVersionRecord) =>
    lastChanges?.get(version.id)?.atMs ?? version.createdAtMs;
  return [...versions].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "main" ? -1 : 1;
    return changedAt(right) - changedAt(left);
  });
}

function filesDiffer(count: number): string {
  if (count === 0) return "Same as Main";
  return count === 1 ? "1 file differs from Main" : `${count} files differ from Main`;
}

function VersionRow(props: {
  version: WorkspaceVersionRecord;
  active: boolean;
  madeFrom: string | undefined;
  lastChange: LastChange;
  count: Count | undefined;
  clashes: Clashes | undefined;
  locked: boolean;
  onSwitch: () => void;
  onCompare: () => void;
  onMerge: () => void;
  onRetryCount: () => void;
  onReviewConflicts: () => void;
}) {
  const { version, lastChange } = props;
  const isMain = version.kind === "main";
  // Each action keeps its visible words as its name, and the row's name describes it.
  const nameId = useId();
  const rowAction = (onClick: () => void) => ({
    "aria-describedby": nameId,
    "aria-disabled": props.locked || undefined,
    onClick: props.locked ? undefined : onClick,
  });
  // Keyed by what each part is, so a part that arrives later, such as a
  // count, doesn't remount the parts after it and drop their focus.
  const parts: [key: string, part: ReactNode][] = [];
  if (!isMain) {
    const parent = props.madeFrom ?? "Main";
    // With no change of its own, when it was made is its only time.
    parts.push(["made", lastChange === null ? `Made from ${parent} ${relativeTime(version.createdAtMs)}` : `Made from ${parent}`]);
    if (props.count === "failed") {
      parts.push([
        "count-retry",
        <span className="inline-block align-top">
          <IconButton
            data-testid="versions-page-count-retry"
            aria-label="dohc could not count the differences. Try again."
            title="dohc could not count the differences. Try again."
            onClick={props.onRetryCount}
            className="size-4"
          >
            <RotateCw size={12} aria-hidden />
          </IconButton>
        </span>,
      ]);
    } else if (props.count !== undefined) {
      parts.push(["count", <span data-testid="versions-page-count">{filesDiffer(props.count)}</span>]);
    }
  }
  if (lastChange !== null) {
    parts.push([
      "changed",
      `Changed ${relativeTime(lastChange.atMs)}${lastChange.personName === undefined ? "" : ` by ${lastChange.personName}`}`,
    ]);
  }
  if (props.clashes !== undefined && props.clashes.count > 0) {
    parts.push([
      "clashes",
      <button
        type="button"
        data-testid="versions-page-clashes"
        // Named by its words, so voice control finds it by what it shows. The
        // review it opens lists every open conflict, not only this version's.
        onClick={props.onReviewConflicts}
        className="cursor-pointer text-warning hover:underline"
      >
        {props.clashes.count}{props.clashes.more ? "+" : ""} to decide
      </button>,
    ]);
  }

  return (
    <li
      data-testid="versions-page-row"
      data-version-id={version.id}
      aria-current={props.active || undefined}
      className="group flex items-center gap-2 rounded-md px-2 py-2 hover:bg-hover"
    >
      <span className="flex h-5 w-4 shrink-0 items-center justify-center self-start">
        {props.active ? <Check size={14} aria-hidden className="text-accent" /> : null}
      </span>
      <span className="flex h-5 w-1.5 shrink-0 items-center self-start">
        {isMain ? null : <span aria-hidden className={`size-1.5 rounded-full ${versionDotClass(version.id)}`} />}
      </span>
      <div className="min-w-0 flex-1">
        <div id={nameId} data-testid="versions-page-name" className="truncate text-[13px] font-medium leading-5 text-ink">{version.name}</div>
        {/* One line that cuts off before the row's actions on a narrow tab. */}
        <div data-testid="versions-page-details" className="min-h-4 truncate text-[12px] leading-4 text-muted">
          {parts.map(([key, part], index) => (
            <span key={key}>
              {index > 0 ? <span aria-hidden>{" · "}</span> : null}
              {part}
            </span>
          ))}
        </div>
      </div>
      {/* Shown on hover and while focus is in the row, and always on the
          version you're in. */}
      <div className={`flex shrink-0 items-center gap-2 ${props.active ? "" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}>
        {props.active ? null : (
          <SecondaryButton size="row" data-testid="versions-page-switch" {...rowAction(props.onSwitch)}>
            Switch
          </SecondaryButton>
        )}
        {isMain ? null : (
          <SecondaryButton size="row" data-testid="versions-page-compare" aria-describedby={nameId} onClick={props.onCompare}>
            Compare
          </SecondaryButton>
        )}
        {isMain || !version.canMergeIntoMain ? null : (
          <SecondaryButton size="row" data-testid="versions-page-merge" {...rowAction(props.onMerge)}>
            Merge into Main
          </SecondaryButton>
        )}
      </div>
    </li>
  );
}
