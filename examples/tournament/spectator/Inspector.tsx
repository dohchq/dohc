import { Fragment, useEffect, useRef, useState } from "react";
import { Check, Flag, Play, RefreshCw, Search, Undo2, X } from "./Icons";
import {
  HISTORY_LIMIT,
  eventScore,
  gameScores,
  isDecided,
  matchRound,
  timeOfDay,
  type Court,
  type Match,
  type Side,
  type Snapshot,
  type Standing,
  trapFocus,
} from "./model";
import type { ScoreActions } from "./Courts";

export interface TimelineEntry {
  seq: number;
  game: number;
  kind:
    | "bye"
    | "start"
    | "point"
    | "undo"
    | "game"
    | "complete"
    | "report"
    | "walkover"
    | "reopen"
    | "cancel";
  side: Side | null;
  playerA: string | null;
  playerB: string | null;
  scoreA: number;
  scoreB: number;
  at: number;
  actor?: string;
}

export interface Timeline {
  entries: TimelineEntry[];
  cut: boolean;
}

interface InspectorProps {
  match: Match;
  snapshot: Snapshot;
  people: Map<string, Standing>;
  now: number;
  loadTimeline(match: Match): Promise<Timeline>;
  describeActor?: (actor: string) => string;
  actions?: ScoreActions;
  onScore?: (match: Match) => void;
  onTrace(playerId: string): void;
  modal?: boolean;
  onClose(): void;
  onRecording?: (recording: boolean) => void;
  askReopen?: boolean;
}

const elapsed = (from: number, to: number) => {
  const minutes = Math.max(0, Math.floor((to - from) / 60_000));
  const seconds = Math.max(0, Math.floor((to - from) / 1000)) % 60;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
};

const listed = (parts: Array<string | null>) => {
  const kept = parts.filter((part): part is string => part !== null);
  if (kept.length < 2) return kept.join("");
  return `${kept.slice(0, -1).join(", ")}${kept.length > 2 ? "," : ""} and ${kept.at(-1)}`;
};

const initials = (name: string | undefined) =>
  (name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

export function Inspector({
  match,
  snapshot,
  people,
  now,
  loadTimeline,
  describeActor,
  actions,
  onScore,
  onTrace,
  modal = false,
  onClose,
  onRecording,
  askReopen = false,
}: InspectorProps) {
  const tournament = snapshot.tournament!;
  const series = tournament.bestOf > 1;
  const court = snapshot.courts.find((entry) => entry.id === match.courtId);
  const busyCourts = new Set(
    snapshot.matches.filter((entry) => entry.status === "live").map((entry) => entry.courtId),
  );
  const free = snapshot.courts.filter((entry) => !busyCourts.has(entry.id));
  const find = (id: string | null) =>
    id ? snapshot.matches.find((entry) => entry.id === id) : undefined;
  const next = find(match.nextMatchId);
  const drop = find(match.loserNextMatchId);
  const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null);
  const [cut, setCut] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [confirm, setConfirm] = useState<"reopen" | "walkover" | "result" | null>(null);
  const seenVersion = useRef(match.version);
  const scored = (entry: Match | undefined) =>
    entry !== undefined &&
    (entry.status === "done" ||
      (entry.status === "live" && entry.scoreA + entry.scoreB + entry.gamesA + entry.gamesB > 0));
  const reach = (entry: Match | undefined): Match[] =>
    entry?.status === "bye"
      ? [find(entry.nextMatchId), find(entry.loserNextMatchId)].flatMap(reach)
      : entry
        ? [entry]
        : [];
  const downstream = [next, drop].flatMap(reach);
  const locked = match.status === "done" ? downstream.find(scored) : undefined;
  const halted = downstream.filter((entry) => entry.status === "live" && !scored(entry));
  const correctable = match.status === "done" && !locked;
  const held = new Set(halted.map((entry) => entry.id));
  const playing = new Set(
    snapshot.matches
      .filter((entry) => entry.status === "live" && !held.has(entry.id))
      .map((entry) => entry.courtId),
  );
  const backOn =
    match.outcome === "reported" || (match.outcome === "walkover" && !match.startedAt)
      ? null
      : match.courtId && !playing.has(match.courtId)
        ? snapshot.courts.find((entry) => entry.id === match.courtId)
        : snapshot.courts.find((entry) => !playing.has(entry.id));
  const noCourt =
    match.outcome !== "reported" && !(match.outcome === "walkover" && !match.startedAt) && !backOn;
  const panel = useRef<HTMLElement | null>(null);
  const loader = useRef(loadTimeline);
  loader.current = loadTimeline;

  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      window.requestAnimationFrame(() => {
        if (document.querySelector(".co-inspector")) return;
        if (document.activeElement && document.activeElement !== document.body) return;
        if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      });
    };
  }, []);

  useEffect(() => {
    panel.current?.focus();
    setConfirm(askReopen ? "reopen" : null);
  }, [match.id, askReopen]);

  useEffect(() => {
    if (seenVersion.current === match.version) return;
    seenVersion.current = match.version;
    setConfirm((current) =>
      current === "result" &&
      (match.status === "ready" || match.status === "live") &&
      match.scoreA + match.scoreB + match.gamesA + match.gamesB === 0
        ? current
        : null,
    );
  }, [match.version]);

  useEffect(() => {
    let current = true;
    setFailed(null);
    loader.current(match).then(
      (loaded) => {
        if (!current) return;
        setTimeline(loaded.entries);
        setCut(loaded.cut);
      },
      (caught: unknown) => {
        if (current) setFailed(caught instanceof Error ? caught.message : String(caught));
      },
    );
    return () => {
      current = false;
    };
  }, [match.id, match.version, match.status, attempt]);

  const name = (id: string | null) => (id ? (people.get(id)?.name ?? "Unknown") : "TBD");
  const sideName = (side: Side | null) => name(side === "a" ? match.playerA : match.playerB);
  const walkover = match.outcome === "walkover";
  const queued = match.status === "waiting" || match.status === "ready";
  const history = (timeline ?? []).some((entry) => entry.kind !== "bye");
  const played = (timeline ?? []).some((entry) => entry.kind === "point" || entry.kind === "game");
  const scoreColumn = (timeline ?? []).some(
    (entry) => entry.kind !== "bye" && eventScore(tournament, entry) !== "",
  );
  const pending = match.status === "live" && isDecided(tournament, match.scoreA, match.scoreB);
  const status =
    match.status === "live"
      ? pending
        ? "Result pending"
        : "Live"
      : match.status === "done"
        ? walkover
          ? "Walkover"
          : "Finished"
        : match.status === "ready"
          ? "Ready"
          : match.status === "bye"
            ? "Bye"
            : match.status === "skipped"
              ? "Not needed"
              : "Waiting";
  const games = gameScores(match);
  const busy = Boolean(
    actions &&
    (actions.disabled ||
      actions.pending.has(match.id) ||
      (actions.taps.get(match.id)?.length ?? 0) > 0),
  );
  const [submitting, setSubmitting] = useState(false);
  const recording = confirm === "result" && submitting;
  useEffect(() => {
    onRecording?.(recording);
  }, [recording, onRecording]);
  useEffect(() => () => onRecording?.(false), [onRecording]);
  const winnerTo = () => {
    if (match.bracket === "final" && match.round === 1)
      return "Champion, or a reset if the losers side wins";
    return next ? `M${next.number} · ${matchRound(tournament, next)}` : "Champion";
  };

  const logText = (entry: TimelineEntry) => {
    const who = name(entry.side === "a" ? entry.playerA : entry.playerB);
    if (entry.kind === "point") return who;
    if (entry.kind === "undo")
      return entry.side ? `Point removed, ${who}` : `Game ${entry.game} reopened`;
    if (entry.kind === "game") return `${who} took game ${entry.game}`;
    if (entry.kind === "complete") return `${who} won the match`;
    if (entry.kind === "report") return `Score sheet entered, ${who} won`;
    if (entry.kind === "walkover") return `${who} won by walkover`;
    if (entry.kind === "reopen") return "Result reopened";
    if (entry.kind === "cancel") return "Start cancelled";
    return `Started, ${name(entry.playerA)} vs ${name(entry.playerB)}`;
  };

  return (
    <aside
      ref={panel}
      className="co-inspector"
      aria-label={`Match ${match.number}`}
      role={modal ? "dialog" : undefined}
      aria-modal={modal || undefined}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (modal) trapFocus(event);
        if (event.key === "Escape") {
          event.stopPropagation();
          if (recording) return;
          if (confirm) setConfirm(null);
          else onClose();
        }
      }}
    >
      <header className="co-inspector-head">
        <div>
          <span className="co-inspector-kicker">
            M{match.number} · {matchRound(tournament, match)}
          </span>
          <span className={`co-state is-${pending ? "pending" : match.status}`}>
            {match.status === "live" ? <span className="co-dot" aria-hidden="true" /> : null}
            {status}
            {court && match.status === "live" ? ` · ${court.name}` : ""}
            {series && match.status === "live" ? ` · Game ${match.gamesA + match.gamesB + 1}` : ""}
          </span>
        </div>
        <button
          type="button"
          className="co-icon-btn"
          onClick={onClose}
          disabled={recording}
          aria-label="Close match"
        >
          <X size={16} />
        </button>
      </header>

      <div className="co-inspector-score">
        {(["a", "b"] as const).map((side) => {
          const id = side === "a" ? match.playerA : match.playerB;
          const player = id ? people.get(id) : undefined;
          const won = id !== null && match.winnerId === id;
          const lost = match.winnerId !== null && id !== null && !won;
          const total = walkover
            ? won
              ? "W/O"
              : "–"
            : match.status === "done" && series
              ? side === "a"
                ? match.gamesA
                : match.gamesB
              : match.status === "live" || match.status === "done"
                ? side === "a"
                  ? match.scoreA
                  : match.scoreB
                : "–";
          const gamesWon = side === "a" ? match.gamesA : match.gamesB;
          return (
            <div
              key={side}
              className={`co-insp-row${won ? " is-won" : ""}${lost ? " is-lost" : ""}`}
            >
              <span className="co-seed-box">{player?.seed ?? ""}</span>
              <span className="co-insp-name">
                <span className="co-insp-who">
                  <strong>
                    {player?.name ?? (match.status === "bye" ? "Bye" : "TBD")}
                    {match.status === "live" && !pending && match.server === side ? (
                      <span className="co-serve" title="Serving">
                        <span className="co-sr">Serving</span>
                      </span>
                    ) : null}
                  </strong>
                  {id ? (
                    <button
                      type="button"
                      className="co-icon-btn co-insp-trace"
                      disabled={recording}
                      onClick={() => onTrace(id)}
                      aria-label={`Trace ${player?.name ?? "player"} in the bracket`}
                      title="Trace path"
                    >
                      <Search size={13} />
                    </button>
                  ) : null}
                </span>
                {player ? (
                  <small>
                    {player.club ?? "Independent"} · <span className="co-num">{player.rating}</span>
                  </small>
                ) : null}
              </span>
              <span
                className="co-insp-games co-num"
                aria-label={series ? "Game scores" : undefined}
              >
                {series
                  ? games.map((game, index) => {
                      const mine = side === "a" ? game[0] : game[1];
                      const theirs = side === "a" ? game[1] : game[0];
                      return (
                        <span key={index} className={mine > theirs ? "is-won" : ""}>
                          {side === "a" ? (
                            <span className="co-insp-cap" aria-hidden="true">
                              G{index + 1}
                            </span>
                          ) : null}
                          {mine}
                        </span>
                      );
                    })
                  : null}
                {series && match.status === "live" ? (
                  <b className="co-insp-won" aria-label={`${gamesWon} games won`}>
                    {gamesWon}
                  </b>
                ) : null}
              </span>
              <span className={`co-insp-score${walkover ? " is-walkover" : ""}`}>{total}</span>
            </div>
          );
        })}
      </div>

      <dl className="co-facts">
        <dt>Format</dt>
        <dd>
          {series ? `Best of ${tournament.bestOf} · ` : ""}to {tournament.pointsToWin}, win by{" "}
          {tournament.winBy}
        </dd>
        {match.startedAt ? (
          <>
            <dt>Started</dt>
            <dd className="co-num">{timeOfDay(match.startedAt)}</dd>
            <dt>{match.finishedAt ? "Duration" : "On court for"}</dt>
            <dd className="co-num">
              {!match.finishedAt && now - match.startedAt < 5_000
                ? "Just started"
                : elapsed(match.startedAt, match.finishedAt ?? now)}
            </dd>
          </>
        ) : null}
        {match.ratingChange !== null && !walkover ? (
          <>
            <dt>Elo</dt>
            <dd className="co-num">
              {name(match.winnerId)} +{match.ratingChange} ·{" "}
              {name(match.winnerId === match.playerA ? match.playerB : match.playerA)} −
              {match.ratingChange}
            </dd>
          </>
        ) : null}
        {walkover ? (
          <>
            <dt>Elo</dt>
            <dd>No change for a walkover</dd>
          </>
        ) : null}
        <dt>Winner to</dt>
        <dd>{winnerTo()}</dd>
        {drop ? (
          <>
            <dt>Loser to</dt>
            <dd>
              M{drop.number} · {matchRound(tournament, drop)}
            </dd>
          </>
        ) : match.bracket !== "final" || match.round !== 1 ? (
          <>
            <dt>Loser to</dt>
            <dd>Out</dd>
          </>
        ) : null}
      </dl>

      {actions && match.status === "ready" ? (
        <div className="co-inspector-actions">
          <span className="co-rail-title">Start on</span>
          {free.length === 0 ? (
            <p className="co-rail-empty">All courts busy</p>
          ) : (
            <div className="co-queue-courts">
              {free.map((entry: Court) => (
                <button
                  key={entry.id}
                  type="button"
                  className="co-chip"
                  disabled={busy}
                  onClick={() => actions.start(match, entry)}
                >
                  <Play size={11} />
                  {entry.name}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
      {onScore && match.status === "live" ? (
        <div className="co-inspector-actions">
          <button
            type="button"
            className="co-btn is-primary is-wide"
            disabled={recording}
            onClick={() => onScore(match)}
          >
            Score on {court?.name ?? "court"}
          </button>
          {actions && match.scoreA + match.scoreB + match.gamesA + match.gamesB === 0 ? (
            <button
              type="button"
              className="co-btn is-quiet is-wide"
              disabled={busy}
              onClick={() => actions.returnToQueue(match)}
            >
              <Undo2 size={13} />
              Return to the queue
            </button>
          ) : null}
        </div>
      ) : null}

      {actions && (match.status === "ready" || match.status === "live") ? (
        <div className="co-inspector-actions">
          {confirm === "result" ? (
            <ResultForm
              key={`${match.id}:${match.playerA}:${match.playerB}`}
              bestOf={tournament.bestOf}
              version={match.version}
              pointsToWin={tournament.pointsToWin}
              winBy={tournament.winBy}
              names={[sideName("a"), sideName("b")]}
              busy={submitting}
              blocked={busy}
              onCancel={() => setConfirm(null)}
              onSubmit={async (games) => {
                setSubmitting(true);
                try {
                  if (await actions.report(match, games)) setConfirm(null);
                } finally {
                  setSubmitting(false);
                }
              }}
            />
          ) : confirm === "walkover" ? (
            <div className="co-reopen" role="group" aria-label="Record a walkover">
              <p>
                Use this when a player cannot play. The other player goes through with no Elo
                change. You can reopen it later.
              </p>
              <div className="co-reopen-buttons is-stacked">
                {(["a", "b"] as const).map((side) => (
                  <button
                    key={side}
                    type="button"
                    className="co-btn is-wide"
                    disabled={busy}
                    onClick={() => {
                      setConfirm(null);
                      actions.walkover(match, side);
                    }}
                  >
                    {sideName(side)} goes through
                  </button>
                ))}
                <button
                  type="button"
                  className="co-btn is-quiet is-wide"
                  onClick={() => setConfirm(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {match.scoreA + match.scoreB + match.gamesA + match.gamesB === 0 ? (
                <button
                  type="button"
                  className="co-btn is-wide"
                  onClick={() => setConfirm("result")}
                >
                  <Check size={13} />
                  Enter the final score
                </button>
              ) : null}
              <button
                type="button"
                className="co-btn is-quiet is-wide"
                onClick={() => setConfirm("walkover")}
              >
                <Flag size={13} />
                Record a walkover
              </button>
            </>
          )}
        </div>
      ) : null}

      {actions && correctable ? (
        <div className="co-inspector-actions">
          {confirm === "reopen" ? (
            <div className="co-reopen" role="group" aria-label="Reopen match">
              <p>
                {listed([
                  match.outcome === "reported"
                    ? `Puts M${match.number} back in the queue with no score, so the sheet can be entered again`
                    : walkover && !match.startedAt
                      ? `Puts M${match.number} back in the queue`
                      : `Puts M${match.number} back on ${backOn?.name ?? "court"} with its score`,
                  walkover ? null : "reverses the Elo change",
                  next && next.status !== "skipped"
                    ? match.bracket === "final" && match.round === 1
                      ? `clears both players from the reset match M${next.number}`
                      : `takes ${name(match.winnerId)} out of M${next.number}`
                    : "removes the title",
                  drop
                    ? `takes ${name(match.winnerId === match.playerA ? match.playerB : match.playerA)} out of M${drop.number}`
                    : null,
                ])}
                {halted
                  .map(
                    (entry) => `. M${entry.number} has no points yet, so it goes back to waiting`,
                  )
                  .join("")}
                .
              </p>
              {noCourt ? (
                <p className="co-inline-error">Every court is playing. Complete one first.</p>
              ) : null}
              <div className="co-reopen-buttons">
                <button type="button" className="co-btn is-quiet" onClick={() => setConfirm(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="co-btn is-primary"
                  disabled={busy || noCourt}
                  onClick={() => {
                    setConfirm(null);
                    actions.reopen(match);
                  }}
                >
                  Reopen match
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="co-btn is-wide" onClick={() => setConfirm("reopen")}>
              <Undo2 size={13} />
              Reopen to correct the result
            </button>
          )}
        </div>
      ) : actions && locked ? (
        <p className="co-inspector-note">
          M{locked.number} already has points, so this result can no longer change.
        </p>
      ) : null}

      {match.status === "live" || match.status === "done" || (queued && history) ? (
        <section className="co-timeline" aria-label={played ? "Point by point" : "History"}>
          <h3 className="co-rail-title">{played ? "Point by point" : "History"}</h3>
          {failed ? (
            <div className="co-inline-error" role="alert">
              <span>Could not load the points. {failed}</span>
              <button
                type="button"
                className="co-btn"
                onClick={() => setAttempt((value) => value + 1)}
              >
                <RefreshCw size={13} />
                Try again
              </button>
            </div>
          ) : timeline === null ? (
            <div className="co-timeline-loading" aria-label="Loading points" />
          ) : (
            <>
              {timeline.some((entry) => entry.kind === "point") ? (
                <Momentum
                  timeline={timeline}
                  top={initials(people.get(match.playerA ?? "")?.name)}
                  bottom={initials(people.get(match.playerB ?? "")?.name)}
                />
              ) : null}
              {cut ? (
                <p className="co-inspector-note">
                  Showing the latest {HISTORY_LIMIT.toLocaleString()} events.
                </p>
              ) : null}
              <ol className={scoreColumn ? "co-log" : "co-log is-plain"}>
                {timeline
                  .filter((entry) => entry.kind !== "bye")
                  .flatMap((entry, index, shown) => [
                    ...(series && played && entry.game !== shown[index - 1]?.game
                      ? [
                          <li key={`game-${entry.seq}`} className="co-log-game" aria-hidden="true">
                            Game {entry.game}
                          </li>,
                        ]
                      : []),
                    <li key={entry.seq} className={`is-${entry.kind}`}>
                      {scoreColumn ? (
                        <span className="co-log-score co-num">{eventScore(tournament, entry)}</span>
                      ) : null}
                      <span className="co-log-text">
                        {logText(entry)}
                        {entry.actor && describeActor && entry.actor !== shown[index - 1]?.actor ? (
                          <small>{describeActor(entry.actor)}</small>
                        ) : null}
                      </span>
                      <time className="co-num" dateTime={new Date(entry.at).toISOString()}>
                        {timeOfDay(entry.at)}
                      </time>
                    </li>,
                  ])}
              </ol>
            </>
          )}
        </section>
      ) : null}
    </aside>
  );
}

function Momentum({
  timeline,
  top,
  bottom,
}: {
  timeline: TimelineEntry[];
  top: string;
  bottom: string;
}) {
  const points: Array<{ game: number; lead: number }> = [];
  const breaks: number[] = [];
  for (const entry of [...timeline].sort((left, right) => left.seq - right.seq)) {
    if (entry.kind === "point")
      points.push({ game: entry.game, lead: entry.scoreA - entry.scoreB });
    else if (entry.kind === "undo" && entry.side) points.pop();
    else if (entry.kind === "game") breaks.push(points.length);
    else if (entry.kind === "undo") breaks.pop();
  }
  if (points.length < 2) return null;
  const first = [...timeline]
    .sort((left, right) => left.seq - right.seq)
    .find((entry) => entry.kind === "point");
  const opening = first ? first.scoreA - first.scoreB - (first.side === "a" ? 1 : -1) : 0;
  const peak = Math.max(3, Math.abs(opening), ...points.map((point) => Math.abs(point.lead)));
  const width = 300;
  const height = 64;
  const slots = points.length + breaks.length;
  const x = (index: number) => 28 + (index / Math.max(1, slots)) * (width - 32);
  const y = (value: number) => height / 2 - (value / peak) * (height / 2 - 6);
  const segments: string[][] = [[`${x(0).toFixed(1)},${y(opening).toFixed(1)}`]];
  let offset = 0;
  points.forEach((point, index) => {
    if (breaks.includes(index)) {
      offset += 1;
      segments.push([`${x(index + offset).toFixed(1)},${y(0).toFixed(1)}`]);
    }
    segments.at(-1)!.push(`${x(index + offset + 1).toFixed(1)},${y(point.lead).toFixed(1)}`);
  });
  return (
    <svg
      className="co-momentum"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Point lead in each game. Above the line, ${top || "the first player"} leads.`}
    >
      <line x1="16" x2={width} y1={height / 2} y2={height / 2} className="co-momentum-axis" />
      <text x="4" y="15" className="co-momentum-label">
        {top}
      </text>
      <text x="4" y={height - 5} className="co-momentum-label">
        {bottom}
      </text>
      {breaks.map((at, index) => (
        <line
          key={at}
          x1={x(at + index + 0.5)}
          x2={x(at + index + 0.5)}
          y1="4"
          y2={height - 4}
          className="co-momentum-break"
        />
      ))}
      {segments.map((segment, index) => (
        <polyline key={index} points={segment.join(" ")} className="co-momentum-line" />
      ))}
    </svg>
  );
}

interface ResultFormProps {
  bestOf: number;
  version: number;
  pointsToWin: number;
  winBy: number;
  names: [string, string];
  busy: boolean;
  onCancel(): void;
  onSubmit(games: Array<[number, number]>): Promise<void>;
  blocked: boolean;
}

function sheetProblem(
  rows: string[][],
  bestOf: number,
  pointsToWin: number,
  winBy: number,
): { row: number; cell: number | null; message: string } | null {
  const need = Math.floor(bestOf / 2) + 1;
  const entered = rows.slice(0, rows.findLastIndex(([a, b]) => a !== "" || b !== "") + 1);
  const wins = [0, 0];
  for (const [index, [a, b]] of entered.entries()) {
    const game = index + 1;
    if (Math.max(...wins) >= need)
      return {
        row: index,
        cell: null,
        message: `The match was over after game ${index}. Clear game ${game}.`,
      };
    if (a === "" || b === "")
      return {
        row: index,
        cell: a === "" && b === "" ? null : index * 2 + (a === "" ? 0 : 1),
        message: `Enter both scores for game ${game}.`,
      };
    const [high, low] = [Math.max(Number(a), Number(b)), Math.min(Number(a), Number(b))];
    if (high !== Math.max(pointsToWin, low + winBy) || (winBy === 1 && low >= pointsToWin))
      return {
        row: index,
        cell: null,
        message: `Game ${game} at ${a}–${b} is not a finished game. Games go to ${pointsToWin}, win by ${winBy}.`,
      };
    wins[Number(a) > Number(b) ? 0 : 1]! += 1;
  }
  if (Math.max(...wins) < need)
    return {
      row: Math.min(entered.length, bestOf - 1),
      cell: null,
      message: `Nobody has won ${need} ${need === 1 ? "game" : "games"} yet. Add the missing games.`,
    };
  return null;
}

function ResultForm({
  bestOf,
  version,
  pointsToWin,
  winBy,
  names,
  busy,
  blocked,
  onCancel,
  onSubmit,
}: ResultFormProps) {
  const [rows, setRows] = useState(() => Array.from({ length: bestOf }, () => ["", ""]));
  const [reviewed, setReviewed] = useState(version);
  const [problem, setProblem] = useState<{
    row: number;
    cell: number | null;
    message: string;
  } | null>(null);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  useEffect(() => inputs.current[0]?.focus(), []);
  const need = Math.floor(bestOf / 2) + 1;
  const filled = rows.findLastIndex(([a, b]) => a !== "" || b !== "") + 1;
  return (
    <form
      className="co-reopen co-result"
      aria-label="Enter the final score"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (reviewed !== version) {
          setReviewed(version);
          return;
        }
        const found = sheetProblem(rows, bestOf, pointsToWin, winBy);
        setProblem(found);
        if (found) {
          inputs.current[found.cell ?? found.row * 2]?.focus();
          return;
        }
        void onSubmit(
          rows.slice(0, filled).map(([a, b]) => [Number(a), Number(b)] as [number, number]),
        );
      }}
    >
      <p>
        For a score sheet handed in after play. Enter {bestOf > 1 ? "each game played" : "the game"}{" "}
        to {pointsToWin}, win by {winBy}. The log shows who entered it.
      </p>
      <div className="co-result-grid">
        <span />
        <span className="co-result-head">{names[0]}</span>
        <span className="co-result-head">{names[1]}</span>
        {rows.map((row, index) => (
          <Fragment key={index}>
            <span className="co-result-game">{bestOf > 1 ? `Game ${index + 1}` : "Score"}</span>
            {([0, 1] as const).map((side) => (
              <input
                key={side}
                ref={(el) => {
                  inputs.current[index * 2 + side] = el;
                }}
                className="co-num"
                disabled={busy}
                aria-invalid={
                  (problem?.row === index &&
                    (problem.cell === null || problem.cell === index * 2 + side)) ||
                  undefined
                }
                aria-describedby={problem?.row === index ? "co-result-problem" : undefined}
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={3}
                aria-label={`${bestOf > 1 ? `Game ${index + 1}` : "Score"}, ${names[side]}`}
                value={row[side]}
                onChange={(event) => {
                  const value = event.target.value.replace(/\D/g, "");
                  setProblem(null);
                  setRows((current) =>
                    current.map((entry, at) =>
                      at === index ? (side === 0 ? [value, entry[1]!] : [entry[0]!, value]) : entry,
                    ),
                  );
                }}
              />
            ))}
          </Fragment>
        ))}
      </div>
      {reviewed !== version ? (
        <p className="co-inline-error" role="alert">
          This match changed while you were entering scores. Your scores are kept. Check them, then
          record.
        </p>
      ) : null}
      {problem ? (
        <p className="co-inline-error" role="alert" id="co-result-problem">
          {problem.message}
        </p>
      ) : null}
      <div className="co-reopen-buttons">
        <button type="button" className="co-btn is-quiet" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="co-btn is-primary"
          disabled={busy || blocked || filled < need}
        >
          {busy ? "Recording…" : reviewed !== version ? "Use these scores" : "Record result"}
        </button>
      </div>
    </form>
  );
}
