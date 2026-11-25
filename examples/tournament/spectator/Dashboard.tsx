import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bracket } from "./Bracket";
import { CourtDesk, type ScoreActions } from "./Courts";
import { ChevronDown, Eye, EyeOff, Maximize, RefreshCw, Trophy } from "./Icons";
import { Inspector, type Timeline } from "./Inspector";
import { Standings } from "./Standings";
import { TvBoard } from "./TvBoard";
import {
  isDecided,
  isTyping,
  liveCourts,
  matchRound,
  modalOpen,
  playersById,
  useNow,
  type LiveState,
  type Match,
  type Snapshot,
  type Tournament,
  type Visibility,
} from "./model";

export type ViewId = "bracket" | "courts" | "standings";

interface DashboardProps {
  live: LiveState;
  role: "organizer" | "spectator";
  onPickTournament(id: string): void;
  actions?: ScoreActions;
  loadTimeline(match: Match): Promise<Timeline>;
  describeActor?: (actor: string) => string;
  barEnd?: ReactNode;
  empty: ReactNode;
  covered?: boolean;
  onSetVisibility?: (tournament: Tournament, visibility: Visibility) => Promise<void>;
  reopenRequest?: { matchId: string; seq: number } | null;
  onViewChange?: (view: ViewId) => void;
}

const VIEWS: Array<{ id: ViewId; key: string; organizer: string; spectator: string }> = [
  { id: "bracket", key: "B", organizer: "Bracket", spectator: "Bracket" },
  { id: "courts", key: "C", organizer: "Courts", spectator: "Live courts" },
  { id: "standings", key: "S", organizer: "Standings", spectator: "Standings" },
];

const PHONE = "(max-width: 760px)";

export function Dashboard({
  live,
  role,
  onPickTournament,
  actions,
  loadTimeline,
  describeActor,
  barEnd,
  empty,
  covered = false,
  onSetVisibility,
  reopenRequest = null,
  onViewChange,
}: DashboardProps) {
  const [view, setView] = useState<ViewId>(role === "organizer" ? "courts" : "bracket");
  const [openId, setOpenId] = useState<string | null>(null);
  const viewChanged = useRef(onViewChange);
  viewChanged.current = onViewChange;
  useEffect(() => viewChanged.current?.(view), [view]);
  const [traced, setTraced] = useState<string | null>(null);
  const [tv, setTv] = useState(false);
  const [deskFocus, setDeskFocus] = useState<{ matchId: string; seq: number } | null>(null);
  const recording = useRef(false);
  const onRecording = useCallback((on: boolean) => {
    recording.current = on;
  }, []);
  const close = () => {
    if (!recording.current) setOpenId(null);
  };
  const openMatch = (match: Match) => {
    if (!recording.current) setOpenId(match.id);
  };
  const [changingVisibility, setChangingVisibility] = useState(false);
  const [ask, setAsk] = useState<{ matchId: string; seq: number } | null>(null);
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE).matches);
  useEffect(() => {
    const query = window.matchMedia(PHONE);
    const change = () => setPhone(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const snapshot = live.data;
  const now = useNow(live.clockSkew);
  const people = useMemo(
    () => (snapshot?.tournament ? playersById(snapshot) : new Map()),
    [snapshot],
  );
  const tournamentId = snapshot?.tournament?.id ?? null;

  useEffect(() => {
    setOpenId(null);
    setTraced(null);
  }, [tournamentId]);

  useEffect(() => {
    if (view !== "courts") setDeskFocus(null);
  }, [view]);

  useEffect(() => {
    if (!openId || view !== "courts") return;
    const frame = window.requestAnimationFrame(() =>
      document
        .querySelector(`.co-board[data-match="${openId}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [openId, view]);

  useEffect(() => {
    if (!reopenRequest || recording.current) return;
    setAsk(reopenRequest);
    setOpenId(reopenRequest.matchId);
  }, [reopenRequest]);

  useEffect(() => {
    if (ask && openId !== ask.matchId) setAsk(null);
  }, [ask, openId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target) || tv) return;
      if (event.repeat || modalOpen()) return;
      const key = event.key.toLowerCase();
      const target = VIEWS.find((entry) => entry.key.toLowerCase() === key);
      if (target && !(key === "c" && view === "courts" && actions)) {
        event.preventDefault();
        setView(target.id);
      } else if (key === "f" && snapshot?.tournament) {
        event.preventDefault();
        setTv(true);
      } else if (event.key === "Escape" && openId) {
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, openId, snapshot?.tournament, tv, view]);

  if (!snapshot) {
    return live.error ? (
      <div className="co-app">
        <div className="co-fatal" role="alert">
          <strong>Could not load the tournament</strong>
          <span>{live.error.message}</span>
          <button type="button" className="co-btn" onClick={live.reload}>
            <RefreshCw size={13} />
            Try again
          </button>
        </div>
      </div>
    ) : (
      <div className="co-app" aria-busy="true">
        <div className="co-bar">
          <span className="co-skel" style={{ width: 220 }} />
        </div>
        <div className="co-loading" />
      </div>
    );
  }

  const tournament = snapshot.tournament;
  if (!tournament)
    return (
      <div className="co-app" inert={covered}>
        {live.error ? (
          <div className="co-stale" role="status">
            <span>Could not check for tournaments. {live.error.message}</span>
            <button type="button" className="co-btn is-quiet" onClick={live.reload}>
              <RefreshCw size={13} />
              Try again
            </button>
          </div>
        ) : null}
        {empty}
      </div>
    );
  const playing = liveCourts(snapshot);

  const opened = openId ? snapshot.matches.find((match) => match.id === openId) : undefined;
  const sheet = phone && opened !== undefined;
  const trace = (id: string | null) => {
    if (id && recording.current) return;
    setTraced(id);
    if (!id) return;
    setView("bracket");
    if (phone) setOpenId(null);
  };

  return (
    <div className={`co-app is-${role}`}>
      <div className="co-chrome" inert={covered || tv}>
        <div className="co-chrome" inert={sheet}>
          {role === "spectator" ? <Ticker snapshot={snapshot} onOpenMatch={openMatch} /> : null}
          <header className="co-bar">
            <div className="co-event">
              <span className="co-mark" aria-hidden="true">
                <Trophy size={15} />
              </span>
              <div className="co-event-text">
                <div className="co-event-name">
                  {snapshot.tournaments.length > 1 ? (
                    <>
                      <h1 className="co-sr">{tournament.name}</h1>
                      <select
                        aria-label="Tournament"
                        value={tournament.id}
                        onChange={(event) => onPickTournament(event.target.value)}
                      >
                        {snapshot.tournaments.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.name}
                            {entry.status === "finished" ? " (finished)" : ""}
                          </option>
                        ))}
                      </select>
                      <span aria-hidden="true">{tournament.name}</span>
                      <ChevronDown size={14} aria-hidden="true" />
                    </>
                  ) : (
                    <h1>{tournament.name}</h1>
                  )}
                </div>
                <span className="co-event-meta">
                  <Stage snapshot={snapshot} />
                  {onSetVisibility ? (
                    <button
                      type="button"
                      className={`co-visibility is-${tournament.visibility}`}
                      aria-label={
                        tournament.visibility === "shared" ? "On share link" : "Hidden from link"
                      }
                      title={
                        tournament.visibility === "shared"
                          ? "Anyone with the spectator link can follow this tournament. Click to hide it."
                          : "Hidden from the spectator link. Click to show it."
                      }
                      disabled={changingVisibility}
                      onClick={() => {
                        setChangingVisibility(true);
                        void onSetVisibility(
                          tournament,
                          tournament.visibility === "shared" ? "private" : "shared",
                        ).finally(() => setChangingVisibility(false));
                      }}
                    >
                      {tournament.visibility === "shared" ? (
                        <Eye size={13} />
                      ) : (
                        <EyeOff size={13} />
                      )}
                      <span className="co-hide-sm">
                        {tournament.visibility === "shared" ? "On share link" : "Hidden from link"}
                      </span>
                    </button>
                  ) : null}
                </span>
              </div>
            </div>
            <nav className="co-views" aria-label="Views">
              {VIEWS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="co-view"
                  aria-current={view === entry.id ? "page" : undefined}
                  aria-keyshortcuts={entry.key}
                  title={`${role === "organizer" ? entry.organizer : entry.spectator}  ${entry.key}`}
                  onClick={() => setView(entry.id)}
                >
                  {role === "organizer" ? entry.organizer : entry.spectator}
                  {entry.id === "courts" && playing.length > 0 ? (
                    <span className="co-view-count co-num">{playing.length}</span>
                  ) : null}
                </button>
              ))}
            </nav>
            <div className="co-bar-end">
              <Freshness live={live} />
              <button
                type="button"
                className="co-btn is-quiet"
                onClick={() => setTv(true)}
                aria-keyshortcuts="F"
                aria-label="TV mode"
                title="TV mode  F"
              >
                <Maximize size={14} />
                <span className="co-hide-sm">TV</span>
                <kbd className="co-hide-sm">F</kbd>
              </button>
              {barEnd}
            </div>
          </header>
          {live.error ? (
            <div className="co-stale" role="status">
              <span>Scores may be out of date. {live.error.message}</span>
              <button type="button" className="co-btn is-quiet" onClick={live.reload}>
                <RefreshCw size={13} />
                Try again
              </button>
            </div>
          ) : null}
        </div>
        <div className={`co-stage${opened ? " has-inspector" : ""}`}>
          <main
            className={`co-view-body is-${view}`}
            aria-busy={live.switching || undefined}
            inert={sheet}
          >
            {view === "bracket" ? (
              <Bracket
                snapshot={snapshot}
                selectedMatchId={openId}
                tracedPlayer={traced}
                onTrace={setTraced}
                onOpenMatch={openMatch}
              />
            ) : view === "courts" ? (
              <CourtDesk
                key={tournament.id}
                snapshot={snapshot}
                people={people}
                now={now}
                actions={actions}
                focusRequest={deskFocus}
                onOpenMatch={openMatch}
              />
            ) : (
              <Standings snapshot={snapshot} onTrace={trace} />
            )}
          </main>
          {sheet ? <div className="co-sheet-scrim" aria-hidden="true" onClick={close} /> : null}
          {opened ? (
            <Inspector
              modal={sheet}
              key={`${opened.id}:${ask?.matchId === opened.id ? ask.seq : 0}`}
              askReopen={ask?.matchId === opened.id}
              match={opened}
              snapshot={snapshot}
              people={people}
              now={now}
              loadTimeline={loadTimeline}
              describeActor={describeActor}
              actions={actions}
              onScore={
                actions
                  ? (match) => {
                      setDeskFocus((current) => ({
                        matchId: match.id,
                        seq: (current?.seq ?? 0) + 1,
                      }));
                      setView("courts");
                      setOpenId(null);
                    }
                  : undefined
              }
              onTrace={trace}
              onClose={close}
              onRecording={onRecording}
            />
          ) : null}
        </div>
      </div>
      {tv ? (
        <TvBoard
          snapshot={snapshot}
          people={people}
          now={now}
          freshness={live.freshness}
          syncedAt={live.syncedAt}
          onClose={() => setTv(false)}
        />
      ) : null}
    </div>
  );
}

function Stage({ snapshot }: { snapshot: Snapshot }) {
  const tournament = snapshot.tournament!;
  const champion = tournament.championId
    ? snapshot.standings.find((row) => row.id === tournament.championId)
    : undefined;
  const open = snapshot.matches.filter(
    (match) => match.status === "live" || match.status === "ready",
  );
  const side = { winners: 0, losers: 1, final: 2 } as const;
  const stages = [
    ...new Set(
      [...open]
        .sort((left, right) => side[left.bracket] - side[right.bracket])
        .map((match) => matchRound(tournament, match)),
    ),
  ].slice(0, 2);
  const played = snapshot.matches.filter((match) => match.status === "done").length;
  const reset = snapshot.matches.some(
    (match) =>
      match.bracket === "final" &&
      match.round === 2 &&
      match.status !== "waiting" &&
      match.status !== "skipped",
  );
  const players = snapshot.standings.length;
  const playable = tournament.format === "double" ? 2 * players - 2 + (reset ? 1 : 0) : players - 1;
  return (
    <>
      <span>
        {tournament.sport} · {tournament.format === "double" ? "Double elim" : "Single elim"}
        {tournament.bestOf > 1 ? ` · Bo${tournament.bestOf}` : ""}
      </span>
      <span className="co-num">{snapshot.standings.length} players</span>
      <span className="co-event-stage">
        {champion ? (
          <>
            Won by <strong>{champion.name}</strong>
          </>
        ) : (
          stages.join(" · ") || "Waiting for results"
        )}
      </span>
      <span className="co-num co-hide-sm">
        {played}/{playable} played
      </span>
    </>
  );
}

function Freshness({ live }: { live: LiveState }) {
  const label =
    live.freshness === "live"
      ? "Connected"
      : live.freshness === "polling"
        ? "Auto-updating"
        : "Out of date";
  return (
    <span
      className={`co-fresh is-${live.freshness}`}
      role="status"
      aria-label={label}
      title={
        live.freshness === "live"
          ? "Updates the moment a score changes"
          : live.freshness === "polling"
            ? "Checks for new scores every few seconds"
            : "dohc could not reach the tournament"
      }
    >
      <span className="co-dot" aria-hidden="true" />
      <span className="co-hide-sm">{label}</span>
    </span>
  );
}

function shortName(full: string): ReactNode {
  const cut = full.lastIndexOf(" ");
  if (cut < 0) return full;
  return (
    <>
      <span className="co-hide-sm">{full.slice(0, cut)} </span>
      {full.slice(cut + 1)}
    </>
  );
}

function Ticker({
  snapshot,
  onOpenMatch,
}: {
  snapshot: Snapshot;
  onOpenMatch(match: Match): void;
}) {
  const name = (id: string | null) =>
    (id && snapshot.standings.find((row) => row.id === id)?.name) || "TBD";
  const playing = liveCourts(snapshot);
  const tournament = snapshot.tournament!;
  const series = tournament.bestOf > 1;
  const champion = tournament.championId ? name(tournament.championId) : null;
  return (
    <div className="co-ticker" role="region" aria-label="Live scores">
      <div className="co-ticker-track">
        {champion ? (
          <span className="co-ticker-item">
            <span className="co-ticker-tag is-final">Final</span>
            <strong>{champion}</strong> wins {tournament.name}
          </span>
        ) : playing.length === 0 ? (
          <span className="co-ticker-item">
            <span className="co-ticker-tag is-idle">Next</span>
            Next match starts soon
          </span>
        ) : (
          playing.map(({ court, match }) => (
            <button
              type="button"
              key={court.id}
              className="co-ticker-item"
              onClick={() => onOpenMatch(match)}
              aria-label={`${court.name}, ${matchRound(tournament, match)}: ${name(match.playerA)} ${match.scoreA}, ${name(match.playerB)} ${match.scoreB}${series ? `, games ${match.gamesA}–${match.gamesB}` : ""}${isDecided(tournament, match.scoreA, match.scoreB) ? ", result pending" : ""}`}
            >
              <span className="co-ticker-tag">
                <span className="co-dot" aria-hidden="true" />
                {court.name}
              </span>
              <span className="co-ticker-round">{matchRound(tournament, match, "tiny")}</span>
              <span className={match.scoreA > match.scoreB ? "is-lead" : undefined}>
                {shortName(name(match.playerA))}
              </span>
              {series ? (
                <span className="co-ticker-games co-num">
                  {match.gamesA}–{match.gamesB}
                </span>
              ) : null}
              <strong className="co-num">
                {match.scoreA}–{match.scoreB}
              </strong>
              <span className={match.scoreB > match.scoreA ? "is-lead" : undefined}>
                {shortName(name(match.playerB))}
              </span>
              {isDecided(tournament, match.scoreA, match.scoreB) ? (
                <span className="co-ticker-games is-pending">Pending</span>
              ) : null}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
