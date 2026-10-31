import type { AccessShareRow } from "@dohc/workspace-contracts/access";
import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import { File, Layers, MessageSquare, Share2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../bridge";
import { KindGlyph } from "../ui/KindGlyph";
import { SectionLabel } from "../ui/controls";
import { useRequestSequence } from "../useRequestSequence";
import { shareSubject } from "../workbench/shareSubject";
import type { SharingFocus, SharingLane } from "../workbench/SharingView";

// Share lists live in the Sharing view. Settings search still finds them: a
// lane by its old section name, a share by what it covers or who it names.
// Each result opens the Sharing view on that lane or row.

const LANES: ReadonlyArray<{ lane: SharingLane; label: string }> = [
  { lane: "granted", label: "Shared by me" },
  { lane: "received", label: "Shared with me" },
];
const MAX_SHARES = 6;

type Found = { lane: SharingLane; row: AccessShareRow };
export type SharingResult = SharingFocus & { label: string; row: AccessShareRow | null };

// A lane's every page, or null when its first read failed. A later page main
// refuses, because the listing changed, keeps what was read.
async function readLane(workspaceId: string, lane: SharingLane, current: () => boolean): Promise<Found[] | null> {
  const found: Found[] = [];
  let cursor: string | null = null;
  do {
    let answer;
    try {
      answer = await bridge().listSharingAccess({ workspaceId, lane, ...(cursor ? { cursor } : {}) });
    } catch {
      return cursor === null ? null : found;
    }
    if (cursor !== null && answer.coverage.kind === "unavailable") break;
    for (const row of answer.rows) if (row.kind === "share") found.push({ lane, row });
    cursor = answer.nextCursor;
  } while (cursor !== null && current());
  return found;
}

// Both lists, read once per workspace on the first search.
export function useSharingSearch(workspaceId: string, sharedView: boolean, query: string): SharingResult[] {
  const [found, setFound] = useState<{ workspaceId: string; rows: Found[] } | null>(null);
  const asked = useRef<string | null>(null);
  const request = useRequestSequence([workspaceId]);
  const q = query.trim().toLowerCase();
  useEffect(() => {
    if (!q || asked.current === workspaceId) return;
    asked.current = workspaceId;
    const token = request.next();
    // Someone else's shared workspace grants nothing from here.
    const lanes: SharingLane[] = sharedView ? ["received"] : ["granted", "received"];
    void (async () => {
      await bridge().requestAccessRefresh({ workspaceId, reason: "sharing-open" }).catch(() => undefined);
      const answers = await Promise.all(lanes.map((lane) => readLane(workspaceId, lane, () => request.isCurrent(token))));
      if (!request.isCurrent(token)) return;
      // Every read failed: the next query change asks again.
      if (answers.every((answer) => answer === null)) asked.current = null;
      setFound({ workspaceId, rows: answers.flatMap((answer) => answer ?? []) });
    })();
  }, [q, request, sharedView, workspaceId]);

  return useMemo(() => {
    if (!q) return [];
    const lanes = LANES.filter(({ lane, label }) => (lane === "received" || !sharedView) && `${label} sharing`.toLowerCase().includes(q))
      .map(({ lane, label }) => ({ lane, shareId: null, label, row: null }));
    const seen = new Set<string>();
    const shares: SharingResult[] = [];
    for (const { lane, row } of found?.workspaceId === workspaceId ? found.rows : []) {
      const key = `${lane}\0${row.shareId}`;
      if (seen.has(key) || shares.length === MAX_SHARES) continue;
      const subject = shareSubject(row);
      const text = [subject.name, subject.title, row.recipientEmail, row.granterEmail, row.sharerName].join(" ").toLowerCase();
      if (!text.includes(q)) continue;
      seen.add(key);
      shares.push({ lane, shareId: row.shareId, label: subject.name, row });
    }
    return [...lanes, ...shares];
  }, [found, q, sharedView, workspaceId]);
}

function ResultGlyph(props: { row: AccessShareRow | null }) {
  if (!props.row) return <Share2 size={15} aria-hidden className="shrink-0 text-subtle" />;
  const subject = shareSubject(props.row);
  if (subject.path) return <KindGlyph kind={fileKindForPath(subject.path)} size={15} className="text-subtle" />;
  const Icon = subject.kind === "chat" ? MessageSquare : subject.kind === "version" ? Layers : subject.kind === "damaged" ? TriangleAlert : File;
  return <Icon size={15} aria-hidden className={`shrink-0 ${subject.kind === "damaged" ? "text-danger" : "text-subtle"}`} />;
}

export function SharingSearchResults(props: { results: readonly SharingResult[]; onOpen: (target: SharingFocus) => void }) {
  if (props.results.length === 0) return null;
  return (
    <div data-testid="settings-sharing-results" className="mb-5">
      <SectionLabel as="h3" className="m-0 mb-1.5">Sharing</SectionLabel>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {props.results.map((result) => (
          <li key={`${result.lane}\0${result.shareId ?? ""}`}>
            <button
              type="button"
              data-testid="settings-sharing-result"
              data-lane={result.lane}
              data-share-id={result.shareId ?? undefined}
              onClick={() => props.onOpen({ lane: result.lane, shareId: result.shareId })}
              className="dohc-focus-row flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted transition-colors duration-75 hover:bg-hover hover:text-ink"
            >
              <ResultGlyph row={result.row} />
              <span className="min-w-0 flex-1 truncate text-ink">{result.label}</span>
              {result.row ? (
                <span className="shrink-0 text-[12px] text-subtle">{LANES.find((lane) => lane.lane === result.lane)!.label}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
