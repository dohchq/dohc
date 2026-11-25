import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, Play, Undo2 } from "./Icons";
import {
  clock,
  eloDelta,
  eventScore,
  eventText,
  gamePoints,
  gameScores,
  gamesToWin,
  isDecided,
  liveCourts,
  matchRound,
  modalOpen,
  nextLabel,
  pressureLabel,
  timeOfDay,
  type Court,
  type Match,
  type Side,
  type Snapshot,
  type Standing,
} from "./model";

export interface ScoreActions {
  start(match: Match, court: Court): void;
  point(match: Match, side: Side): void;
  undo(match: Match): void;
  complete(match: Match): void;
  walkover(match: Match, winner: Side): void;
  report(match: Match, games: Array<[number, number]>): Promise<boolean>;
  reopen(match: Match): void;
  returnToQueue(match: Match): void;
  pending: ReadonlySet<string>;
  taps: ReadonlyMap<string, readonly Side[]>;
  sending: ReadonlyMap<string, number>;
  disabled: boolean;
}

interface DeskProps {
  snapshot: Snapshot;
  people: Map<string, Standing>;
  now: number;
  actions?: ScoreActions;
  focusRequest?: { matchId: string; seq: number } | null;
  onOpenMatch(match: Match): void;
}

export function shownScore(match: Match, actions: ScoreActions | undefined) {
  const queued = actions?.taps.get(match.id) ?? [];
  const sentFrom = actions?.sending.get(match.id);
  const taps = sentFrom !== undefined && match.version > sentFrom ? queued.slice(1) : queued;
  let scoreA = match.scoreA;
  let scoreB = match.scoreB;
  for (const side of taps) {
    if (side === "a") scoreA += 1;
    else scoreB += 1;
  }
  return {
    scoreA,
    scoreB,
    server: taps.at(-1) ?? match.server,
    unconfirmed: {
      a: taps.filter((side) => side === "a").length,
      b: taps.filter((side) => side === "b").length,
    },
  };
}

export function CourtDesk({
  snapshot,
  people,
  now,
  actions,
  focusRequest,
  onOpenMatch,
}: DeskProps) {
  const tournament = snapshot.tournament!;
  const playing = liveCourts(snapshot);
  const busyCourts = new Set(playing.map(({ court }) => court.id));
  const free = snapshot.courts.filter((court) => !busyCourts.has(court.id));
  const ready = snapshot.matches.filter((match) => match.status === "ready");
  const [activeMatch, setActiveMatch] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ id: string; version: number } | null>(null);
  const courtRefs = useRef(new Map<string, HTMLElement>());
  const active = playing.find(({ match }) => match.id === activeMatch);
  const focusCourt = playing.find(({ match }) => match.id === focusRequest?.matchId)?.court.id;
  const isConfirming = (match: Match) =>
    confirming?.id === match.id && confirming.version === match.version;

  useEffect(() => {
    if (!focusCourt || !focusRequest) return;
    setActiveMatch(focusRequest.matchId);
    courtRefs.current.get(focusCourt)?.focus();
  }, [focusRequest, focusCourt]);

  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (!(event.target as HTMLElement | null)?.closest(".co-board")) setActiveMatch(null);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, []);

  const onKeyRef = useRef<(event: globalThis.KeyboardEvent) => void>(() => undefined);

  useEffect(() => {
    onKeyRef.current = (event) => {
      if (!actions || !active) return;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.repeat || modalOpen()) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.closest("input, textarea, select, [role=dialog], .co-inspector") ||
          target.isContentEditable)
      )
        return;
      const board = target?.closest(".co-board");
      if (!board || board !== courtRefs.current.get(active.court.id)) return;
      const { match } = active;
      const taps = actions.taps.get(match.id);
      const shown = shownScore(match, actions);
      const decided = isDecided(tournament, shown.scoreA, shown.scoreB);
      const busy = actions.disabled || actions.pending.has(match.id);
      const settled = !busy && !taps?.length;
      if (isConfirming(match)) {
        if (event.key === "Enter" && target?.closest("button")) return;
        if (event.key === "Enter" && settled && decided) {
          event.preventDefault();
          setConfirming(null);
          actions.complete(match);
        } else if (event.key === "Escape") {
          event.preventDefault();
          setConfirming(null);
        }
        return;
      }
      if ((event.key === "1" || event.key === "2") && !busy && !decided) {
        event.preventDefault();
        actions.point(match, event.key === "1" ? "a" : "b");
      } else if (
        (event.key === "z" || event.key === "Z") &&
        settled &&
        match.scoreA + match.scoreB + match.gamesA + match.gamesB > 0
      ) {
        event.preventDefault();
        actions.undo(match);
      } else if (
        (event.key === "c" || event.key === "C" || event.key === "Enter") &&
        decided &&
        settled
      ) {
        if (event.key === "Enter" && target?.closest("button")) return;
        event.preventDefault();
        setConfirming({ id: match.id, version: match.version });
      }
    };
  });

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => onKeyRef.current(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const suggested = actions && tournament.status !== "finished" ? free.slice(0, ready.length) : [];
  const idle = tournament.status !== "finished" ? free.slice(suggested.length) : [];
  const slots = Boolean(actions) && tournament.status !== "finished";
  const tiles = snapshot.courts.map((court): { court: Court; match?: Match; next?: Match } => {
    const live = playing.find((entry) => entry.court.id === court.id);
    const slot = suggested.indexOf(court);
    return live ?? { court, next: slot >= 0 ? ready[slot] : undefined };
  });

  return (
    <div className={`co-desk${actions ? " is-operator" : ""}`}>
      <div className="co-desk-main">
        {playing.length === 0 && tournament.status === "finished" ? (
          <div className="co-quiet">
            <strong>Tournament finished</strong>
            <span>
              {tournament.championId
                ? `${people.get(tournament.championId)?.name ?? "The champion"} won ${tournament.name}.`
                : "Every match is played."}
            </span>
          </div>
        ) : null}
        {playing.length === 0 && tournament.status !== "finished" && !slots ? (
          <div className="co-quiet">
            <strong>No match on court</strong>
            <span>
              {ready.length > 0
                ? actions
                  ? "Start a ready match from Up next."
                  : `${ready.length} ${ready.length === 1 ? "match is" : "matches are"} ready to start.`
                : "Waiting for results."}
            </span>
          </div>
        ) : null}
        <div
          className="co-boards"
          onBlur={(event) => {
            const next = event.relatedTarget as HTMLElement | null;
            if (next && !next.closest(".co-board")) setActiveMatch(null);
          }}
        >
          {tiles.map(({ court, match, next }) =>
            match ? (
              <CourtBoard
                key={`${court.id}:${match.id}`}
                boardRef={(el) => {
                  if (el) courtRefs.current.set(court.id, el);
                  else courtRefs.current.delete(court.id);
                }}
                court={court}
                match={match}
                snapshot={snapshot}
                people={people}
                now={now}
                actions={actions}
                active={Boolean(actions) && active?.court.id === court.id}
                confirming={isConfirming(match)}
                onConfirm={(value) =>
                  setConfirming(value ? { id: match.id, version: match.version } : null)
                }
                onActivate={() => setActiveMatch(match.id)}
                onOpen={() => onOpenMatch(match)}
              />
            ) : slots ? (
              <FreeCourt
                key={court.id}
                court={court}
                next={next}
                snapshot={snapshot}
                people={people}
                now={now}
                actions={actions!}
              />
            ) : null,
          )}
        </div>
        {idle.length > 0 && !slots ? (
          <p className="co-free-row">
            <span className="co-free-tag">Free</span>
            {idle.map((court) => court.name).join(" · ")}
            <span className="co-free-note">
              {!actions && ready.length > 0
                ? `${ready.length} ready to start`
                : "Waiting for a result"}
            </span>
          </p>
        ) : null}
      </div>
      <aside className="co-rail" aria-label="Up next">
        <UpNext
          ready={ready}
          snapshot={snapshot}
          people={people}
          free={free}
          planned={new Map(suggested.map((court, index) => [ready[index]!.id, court]))}
          actions={actions}
          onOpenMatch={onOpenMatch}
        />
        <Feed snapshot={snapshot} people={people} />
      </aside>
    </div>
  );
}

function FreeCourt({
  court,
  next,
  snapshot,
  people,
  now,
  actions,
}: {
  court: Court;
  next?: Match;
  snapshot: Snapshot;
  people: Map<string, Standing>;
  now: number;
  actions: ScoreActions;
}) {
  const tournament = snapshot.tournament!;
  const name = (id: string | null) => (id ? (people.get(id)?.name ?? "TBD") : "TBD");
  const surname = (id: string | null) => name(id).split(" ").at(-1);
  const last = snapshot.matches
    .filter((match) => match.status === "done" && match.courtId === court.id && match.finishedAt)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
  const idle = last?.finishedAt ? Math.floor((now - last.finishedAt) / 60_000) : null;
  const lastScore = (match: Match) => {
    if (match.outcome === "walkover") return "W/O";
    const [a, b] =
      tournament.bestOf > 1
        ? [match.gamesA, match.gamesB]
        : (gameScores(match).at(-1) ?? [match.scoreA, match.scoreB]);
    return `${Math.max(a, b)}–${Math.min(a, b)}`;
  };
  const freeFor =
    idle === null
      ? null
      : idle < 1
        ? "Free just now"
        : `Free for ${idle >= 60 ? `${Math.floor(idle / 60)}h ${idle % 60}m` : `${idle}m`}`;
  return (
    <section className="co-free-court" aria-label={`${court.name}, free`}>
      <header className="co-free-head">
        <span className="co-free-tag">Free</span>
        <strong className="co-free-name">{court.name}</strong>
        {freeFor ? <span className="co-free-for co-num">{freeFor}</span> : null}
      </header>
      <div className="co-free-next">
        {next ? (
          <>
            <span className="co-free-kicker co-num">
              Suggested · M{next.number} · {matchRound(tournament, next, "short")}
            </span>
            {[next.playerA, next.playerB].map((id, index) => {
              const who = id ? people.get(id) : undefined;
              return (
                <span key={index} className="co-free-player">
                  <span className="co-free-seed co-num">{who?.seed ?? ""}</span>
                  <strong>{name(id)}</strong>
                  {who ? (
                    <small className="co-num">
                      {who.club ?? "Independent"} · {who.rating}
                    </small>
                  ) : null}
                </span>
              );
            })}
          </>
        ) : (
          <span className="co-free-idle">Waiting for a result</span>
        )}
      </div>
      {next || last ? (
        <footer className="co-free-foot">
          {next ? (
            <button
              type="button"
              className="co-btn is-primary"
              disabled={actions.disabled || actions.pending.has(next.id)}
              onClick={() => actions.start(next, court)}
            >
              <Play size={12} />
              Start on {court.name}
            </button>
          ) : null}
          {last ? (
            <span className="co-free-last co-num">
              Last · M{last.number} · {surname(last.winnerId)} {lastScore(last)}{" "}
              {surname(last.winnerId === last.playerA ? last.playerB : last.playerA)}
            </span>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}

interface BoardProps {
  boardRef(el: HTMLElement | null): void;
  court: Court;
  match: Match;
  snapshot: Snapshot;
  people: Map<string, Standing>;
  now: number;
  actions?: ScoreActions;
  active: boolean;
  confirming: boolean;
  onConfirm(value: boolean): void;
  onActivate(): void;
  onOpen(): void;
}

function CourtBoard({
  boardRef,
  court,
  match,
  snapshot,
  people,
  now,
  actions,
  active,
  confirming,
  onConfirm,
  onActivate,
  onOpen,
}: BoardProps) {
  const tournament = snapshot.tournament!;
  const taps = actions?.taps.get(match.id);
  const shown = shownScore(match, actions);
  const decided = isDecided(tournament, shown.scoreA, shown.scoreB);
  const pressure = gamePoints(tournament, shown.scoreA, shown.scoreB);
  const busy = Boolean(actions && (actions.disabled || actions.pending.has(match.id)));
  const settled = !busy && !taps?.length;
  const self = useRef<HTMLElement | null>(null);
  const operator = Boolean(actions);
  useEffect(() => {
    if (operator && active && document.activeElement === document.body)
      self.current?.focus({ preventScroll: true });
  }, [operator, active, decided, busy, confirming]);
  const series = tournament.bestOf > 1;
  const game = match.gamesA + match.gamesB + 1;
  const past = gameScores(match);
  const winnerSide: Side | null = decided ? (shown.scoreA > shown.scoreB ? "a" : "b") : null;
  const named = actions ? winnerSide : null;
  const takesMatch =
    winnerSide !== null &&
    (winnerSide === "a" ? match.gamesA : match.gamesB) + 1 >= gamesToWin(tournament);
  const player = (side: Side) => {
    const id = side === "a" ? match.playerA : match.playerB;
    return id ? people.get(id) : undefined;
  };
  const winner = winnerSide ? player(winnerSide) : undefined;
  const loser = winnerSide ? player(winnerSide === "a" ? "b" : "a") : undefined;
  const delta = winner && loser ? eloDelta(winner.rating, loser.rating, tournament.kFactor) : 0;
  const keys = Boolean(actions) && active;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" && event.target === event.currentTarget && !actions) onOpen();
  };
  const destination = () => {
    if (match.bracket === "final" && match.round === 1)
      return winnerSide === "a" ? "champion" : "forces a reset";
    if (!match.nextMatchId) return "champion";
    const drop = match.loserNextMatchId
      ? snapshot.matches.find((entry) => entry.id === match.loserNextMatchId)
      : undefined;
    return `to ${nextLabel(tournament, snapshot, match)}${
      drop && loser
        ? ` · ${loser.name} drops to ${matchRound(tournament, drop, "short")}`
        : loser && !match.loserNextMatchId
          ? ` · ${loser.name} is out`
          : ""
    }`;
  };
  const rule = (
    <>
      To {tournament.pointsToWin}, win by {tournament.winBy}
      <span className="co-hide-sm"> · rally scoring</span>
    </>
  );

  return (
    <section
      ref={(el) => {
        self.current = el;
        boardRef(el);
      }}
      data-match={match.id}
      className={`co-board${active ? " is-active" : ""}${decided ? " is-decided" : ""}`}
      aria-label={`${court.name}, ${matchRound(tournament, match)}${series ? `, game ${game}` : ""}`}
      aria-keyshortcuts={actions ? "1 2 Z C" : undefined}
      tabIndex={0}
      onFocus={onActivate}
      onPointerDown={onActivate}
      onClick={
        actions
          ? undefined
          : (event) => {
              if (!(event.target as HTMLElement).closest("button")) onOpen();
            }
      }
      onKeyDown={onKeyDown}
    >
      <header className="co-board-head">
        <span className="co-live-tag">
          <span className="co-dot" aria-hidden="true" />
          Live
        </span>
        <strong className="co-board-court">{court.name}</strong>
        <button type="button" className="co-board-round" onClick={onOpen}>
          <span className="co-board-stage">
            <span className="co-hide-sm">{matchRound(tournament, match, "short")}</span>
            <span className="co-show-sm">{matchRound(tournament, match, "tiny")}</span>
          </span>
          <span className="co-board-num">M{match.number}</span>
        </button>
        {series ? (
          <span className="co-board-game co-num">
            Game {game}
            {named ? <span className="co-hide-sm"> won</span> : null} ·{" "}
            {match.gamesA + (named === "a" ? 1 : 0)}–{match.gamesB + (named === "b" ? 1 : 0)}
          </span>
        ) : null}
        <span className="co-board-clock">
          <span className="co-sr">Time on court </span>
          {clock(match.startedAt, now)}
        </span>
      </header>
      <span className="co-sr" aria-live="polite">
        {`${player("a")?.name ?? "TBD"} ${shown.scoreA}, ${player("b")?.name ?? "TBD"} ${shown.scoreB}${
          decided
            ? actions
              ? takesMatch || !series
                ? ", match over"
                : `, game ${game} over`
              : ", result pending"
            : ""
        }`}
      </span>
      <div className="co-board-sides">
        {(["a", "b"] as const).map((side) => {
          const who = player(side);
          const score = side === "a" ? shown.scoreA : shown.scoreB;
          const other = side === "a" ? shown.scoreB : shown.scoreA;
          const games = side === "a" ? match.gamesA : match.gamesB;
          const content: ReactNode = (
            <>
              <span className="co-side-who">
                <span className="co-side-seed">{who?.seed ?? ""}</span>
                <span className="co-side-name">{who?.name ?? "TBD"}</span>
                {shown.server === side && !decided ? (
                  <span className="co-serve-tag" title="Serving">
                    <span className="co-serve" aria-hidden="true" />
                    <span className="co-sr">Serving</span>
                  </span>
                ) : null}
              </span>
              <span className="co-side-meta">
                {who?.club ?? "Independent"}
                <span className="co-num"> · {who?.rating ?? "—"}</span>
              </span>
              <span
                className={`co-side-score${shown.unconfirmed[side] > 0 ? " is-unconfirmed" : ""}`}
              >
                {score}
              </span>
              <span className="co-side-foot">
                {series ? (
                  <span
                    className="co-games"
                    aria-label={`${games} ${games === 1 ? "game" : "games"} won`}
                  >
                    {Array.from({ length: gamesToWin(tournament) }, (_, index) => (
                      <i
                        key={index}
                        className={
                          index < games
                            ? "is-won"
                            : index === games && named === side
                              ? "is-projected"
                              : ""
                        }
                      />
                    ))}
                  </span>
                ) : null}
                {past.length > 0 ? (
                  <span className="co-side-past co-num">
                    {past.map(([a, b], index) => {
                      const mine = side === "a" ? a : b;
                      const theirs = side === "a" ? b : a;
                      return (
                        <span key={index} className={mine > theirs ? "is-won" : undefined}>
                          <small>G{index + 1}</small>
                          {mine}
                        </span>
                      );
                    })}
                  </span>
                ) : null}
                {pressure[side] ? (
                  <span className="co-pressure">{pressureLabel(tournament, match, side)}</span>
                ) : null}
                {named === side ? (
                  <span className="co-pressure is-won">
                    {takesMatch ? "Winner" : `Game ${game}`}
                  </span>
                ) : null}
                {actions && !decided ? (
                  <span className="co-plus" aria-hidden="true">
                    +1 {keys ? <kbd>{side === "a" ? "1" : "2"}</kbd> : null}
                  </span>
                ) : null}
              </span>
            </>
          );
          const className = `co-side is-${side}${score < other ? " is-trailing" : ""}${
            named === side ? " is-winner" : named ? " is-loser" : ""
          }`;
          return actions ? (
            <button
              key={side}
              type="button"
              className={`${className} is-tap`}
              disabled={busy || decided}
              onClick={() => actions.point(match, side)}
              aria-label={`Point to ${who?.name ?? "this side"}, now ${score}`}
            >
              {content}
            </button>
          ) : (
            <div key={side} className={className}>
              {content}
            </div>
          );
        })}
      </div>
      {actions ? (
        <footer className={`co-board-foot${confirming && decided ? " is-confirm" : ""}`}>
          {confirming && decided ? (
            <div className="co-confirm-pop">
              <span className="co-confirm-text">
                <strong>{winner?.name}</strong> {takesMatch ? "wins" : `takes game ${game}`}{" "}
                {series && takesMatch
                  ? `${Math.max(match.gamesA, match.gamesB) + 1}–${Math.min(match.gamesA, match.gamesB)}`
                  : `${Math.max(shown.scoreA, shown.scoreB)}–${Math.min(shown.scoreA, shown.scoreB)}`}
                {takesMatch ? (
                  <>
                    {" · "}
                    <span className="co-up co-num">Elo +{delta}</span> · {destination()}
                  </>
                ) : null}
              </span>
              <button type="button" className="co-btn" onClick={() => onConfirm(false)}>
                Cancel {keys ? <kbd>Esc</kbd> : null}
              </button>
              <button
                type="button"
                className="co-btn is-primary"
                disabled={!settled}
                autoFocus
                onClick={() => {
                  onConfirm(false);
                  actions.complete(match);
                }}
              >
                <Check size={14} />
                {takesMatch ? "Complete match" : `Record game ${game}`} {keys ? <kbd>↵</kbd> : null}
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="co-btn"
            disabled={!settled || match.scoreA + match.scoreB + match.gamesA + match.gamesB === 0}
            onClick={() => actions.undo(match)}
          >
            <Undo2 size={14} />
            Undo {keys ? <kbd>Z</kbd> : null}
          </button>
          <span className="co-board-rule">
            {decided ? (takesMatch || !series ? "Match over" : `Game ${game} over`) : rule}
          </span>
          <button
            type="button"
            className={`co-btn${decided ? " is-primary" : ""}`}
            disabled={!settled || !decided}
            onClick={() => onConfirm(true)}
          >
            <Check size={14} />
            {takesMatch || !series ? "Complete" : `Record game ${game}`}{" "}
            {keys ? <kbd>C</kbd> : null}
          </button>
        </footer>
      ) : (
        <footer className="co-board-foot is-quiet">
          <span className={`co-board-rule${decided ? " is-pending" : ""}`}>
            {decided ? (takesMatch || !series ? "Result pending" : `Game ${game} pending`) : rule}
          </span>
        </footer>
      )}
    </section>
  );
}

interface UpNextProps {
  ready: Match[];
  snapshot: Snapshot;
  people: Map<string, Standing>;
  free: Court[];
  planned: ReadonlyMap<string, Court>;
  actions?: ScoreActions;
  onOpenMatch(match: Match): void;
}

function UpNext({ ready, snapshot, people, free, planned, actions, onOpenMatch }: UpNextProps) {
  const tournament = snapshot.tournament!;
  const waiting = snapshot.matches.filter(
    (match) => match.status === "waiting" && (match.playerA || match.playerB),
  );
  return (
    <section className="co-rail-section">
      <h2 className="co-rail-title">
        Up next <span className="co-num">{ready.length}</span>
      </h2>
      {ready.length === 0 ? (
        <p className="co-rail-empty">
          {tournament.status === "finished" ? "Tournament complete" : "Nothing ready yet"}
        </p>
      ) : (
        <ol className="co-queue">
          {ready.map((match) => (
            <li key={match.id} className="co-queue-item">
              <button type="button" className="co-queue-open" onClick={() => onOpenMatch(match)}>
                <span className="co-queue-meta">
                  M{match.number} · {matchRound(tournament, match)}
                </span>
                <QueuePlayer id={match.playerA} people={people} />
                <QueuePlayer id={match.playerB} people={people} />
              </button>
              {actions ? (
                planned.has(match.id) ? (
                  <span className="co-queue-wait">Suggested for {planned.get(match.id)!.name}</span>
                ) : free.length > 0 ? (
                  <div className="co-queue-courts" role="group" aria-label="Start on">
                    {free.map((court) => (
                      <button
                        key={court.id}
                        type="button"
                        className="co-chip"
                        disabled={actions.disabled || actions.pending.has(match.id)}
                        onClick={() => actions.start(match, court)}
                        aria-label={`Start match ${match.number} on ${court.name}`}
                      >
                        <Play size={11} />
                        {court.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <span className="co-queue-wait">All courts busy</span>
                )
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {waiting.length > 0 && actions ? (
        <p className="co-rail-foot">
          <span className="co-num">{waiting.length}</span> waiting on results
        </p>
      ) : null}
    </section>
  );
}

function QueuePlayer({ id, people }: { id: string | null; people: Map<string, Standing> }) {
  const player = id ? people.get(id) : undefined;
  return (
    <span className="co-queue-player">
      <span className="co-num">{player?.seed ?? ""}</span>
      {player?.name ?? "TBD"}
    </span>
  );
}

function Feed({ snapshot, people }: { snapshot: Snapshot; people: Map<string, Standing> }) {
  return (
    <section className="co-rail-section">
      <h2 className="co-rail-title">Latest</h2>
      {snapshot.recent.length === 0 ? (
        <p className="co-rail-empty">No points yet</p>
      ) : (
        <ol className="co-feed">
          {snapshot.recent.slice(0, 10).map((event) => (
            <li key={event.id} className={`is-${event.kind}`}>
              <span className="co-feed-score co-num">
                {eventScore(snapshot.tournament!, event)}
              </span>
              <span className="co-feed-text">{eventText(event, snapshot, people)}</span>
              <time dateTime={new Date(event.at).toISOString()}>{timeOfDay(event.at)}</time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
