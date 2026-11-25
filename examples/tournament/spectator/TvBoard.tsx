import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, Maximize, Pause, Play, Trophy, X } from "./Icons";
import {
  clock,
  gamePoints,
  gameScores,
  isDecided,
  matchRound,
  pressureLabel,
  timeOfDay,
  trapFocus,
  type Freshness,
  type Snapshot,
  type Standing,
} from "./model";

interface TvBoardProps {
  snapshot: Snapshot;
  people: Map<string, Standing>;
  now: number;
  freshness: Freshness;
  syncedAt: number | null;
  onClose(): void;
}

const RESULT_MS = 90_000;
const PER_PAGE = 6;
const PAGE_MS = 12_000;

const NARROW = "(max-width: 760px)";

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function TvBoard({ snapshot, people, now, freshness, syncedAt, onClose }: TvBoardProps) {
  const frame = useRef<HTMLDivElement | null>(null);
  const [full, setFull] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const tournament = snapshot.tournament!;
  const series = tournament.bestOf > 1;
  const playing = snapshot.courts.flatMap((court) => {
    const live = snapshot.matches.find(
      (match) => match.id === court.matchId && match.status === "live",
    );
    if (live) return [{ court, match: live, final: false }];
    const last = snapshot.matches
      .filter(
        (match) =>
          match.status === "done" &&
          match.courtId === court.id &&
          match.finishedAt !== null &&
          now - match.finishedAt < RESULT_MS,
      )
      .sort((left, right) => right.finishedAt! - left.finishedAt!)[0];
    return last ? [{ court, match: last, final: true }] : [];
  });
  const upNext = snapshot.matches.filter((match) => match.status === "ready").slice(0, 4);
  const champion = tournament.championId ? people.get(tournament.championId) : undefined;
  const person = (id: string | null) => (id ? people.get(id) : undefined);
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const sync = () => setNarrow(query.matches);
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  const perPage = narrow ? 2 : PER_PAGE;
  const pages = Math.max(1, Math.ceil(playing.length / perPage));
  const playingNow = playing.some((entry) => !entry.final);
  const [turn, setTurn] = useState(0);
  const [anchor, setAnchor] = useState<string | null>(null);
  const held = anchor !== null;
  useEffect(() => {
    if (pages < 2 || held) return;
    const timer = window.setInterval(() => setTurn((current) => current + 1), PAGE_MS);
    return () => window.clearInterval(timer);
  }, [pages, held]);
  const at = anchor === null ? -1 : playing.findIndex((entry) => entry.court.id === anchor);
  const start =
    pages < 2 ? 0 : Math.min(at >= 0 ? at : (turn % pages) * perPage, playing.length - perPage);
  const pageOf = (from: number) =>
    from + perPage >= playing.length ? pages - 1 : Math.floor(from / perPage);
  useEffect(() => {
    if (pages < 2 || (anchor !== null && at < 0)) setAnchor(null);
  }, [pages, anchor, at]);
  const shown = playing.slice(start, start + perPage);
  const step = (by: number) => {
    const page = by < 0 ? Math.ceil(start / perPage) : pageOf(start);
    const next = (page + by + pages) % pages;
    setTurn(next);
    setAnchor(playing[next * perPage]?.court.id ?? null);
  };
  const hold = () => {
    setTurn(pageOf(start));
    setAnchor(held ? null : (shown[0]?.court.id ?? null));
  };
  const columns = shown.length <= 1 ? 1 : shown.length <= 4 ? 2 : 3;

  useEffect(() => {
    const el = frame.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el?.focus();
    let entered = false;
    if (el && document.fullscreenEnabled && !document.fullscreenElement)
      void el.requestFullscreen().catch(() => undefined);
    const onChange = () => {
      const now = Boolean(document.fullscreenElement);
      setFull(now);
      if (now) entered = true;
      else if (entered) closeRef.current();
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const rule = `${series ? `Best of ${tournament.bestOf} · ` : ""}to ${tournament.pointsToWin}, win by ${tournament.winBy} · rally scoring`;

  return (
    <div
      ref={frame}
      className="co-tv"
      role="dialog"
      aria-modal="true"
      aria-label={`${tournament.name} scoreboard`}
      tabIndex={-1}
      onKeyDown={(event) => {
        trapFocus(event);
        if (pages > 1 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
          event.preventDefault();
          step(event.key === "ArrowLeft" ? -1 : 1);
        }
        if (event.key === "Escape" || event.key === "f" || event.key === "F") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="co-tv-bar">
        {freshness === "stale" ? (
          <span className="co-live-tag is-tv is-stale" role="status">
            Out of date{syncedAt ? ` · ${timeOfDay(syncedAt)}` : ""}
          </span>
        ) : (
          <span
            className={`co-live-tag is-tv${tournament.status === "finished" ? " is-final" : playingNow ? "" : " is-idle"}`}
          >
            {tournament.status !== "finished" && playingNow ? (
              <span className="co-dot" aria-hidden="true" />
            ) : null}
            {tournament.status === "finished" ? "Final" : playingNow ? "Live" : "Between matches"}
          </span>
        )}
        <strong className="co-tv-title">{tournament.name}</strong>
        <span className="co-tv-sub">
          {tournament.sport} ·{" "}
          {tournament.format === "double" ? "Double elimination" : "Single elimination"} · {rule}
        </span>
        {pages > 1 ? (
          <span className="co-tv-page co-num">
            <button
              type="button"
              className="co-tv-close"
              aria-label="Previous courts"
              onClick={() => step(-1)}
            >
              <ChevronLeft size={15} />
            </button>
            <span aria-live="polite">
              Courts {start + 1}–{start + shown.length} of {playing.length}
            </span>
            <button
              type="button"
              className="co-tv-close"
              aria-label="Next courts"
              onClick={() => step(1)}
            >
              <ChevronRight size={15} />
            </button>
            <button
              type="button"
              className="co-tv-close"
              aria-label={held ? "Rotate pages" : "Hold this page"}
              aria-pressed={held}
              onClick={hold}
            >
              {held ? <Play size={14} /> : <Pause size={14} />}
            </button>
          </span>
        ) : null}
        <span className="co-tv-time co-num">{timeOfDay(now)}</span>
        {full ? null : document.fullscreenEnabled ? (
          <button
            type="button"
            className="co-tv-close"
            aria-label="Full screen"
            onClick={() => void frame.current?.requestFullscreen().catch(() => undefined)}
          >
            <Maximize size={15} />
            <span className="co-tv-hint">Full screen</span>
          </button>
        ) : (
          <span className="co-tv-hint">
            Full screen <kbd>{MAC ? "⌃⌘F" : "F11"}</kbd>
          </span>
        )}
        <button type="button" className="co-tv-close" onClick={onClose} aria-label="Exit TV mode">
          <X size={16} />
          <kbd className="co-tv-esc">Esc</kbd>
        </button>
      </header>
      {champion ? (
        <div className="co-tv-champ" role="status">
          <Trophy size={44} />
          <div>
            <span>Champion</span>
            <strong>{champion.name}</strong>
            <em className="co-num">
              {champion.club ? `${champion.club} · ` : ""}
              {champion.wins}–{champion.losses} · Elo {champion.rating}
            </em>
          </div>
        </div>
      ) : null}
      <p className="co-sr" aria-live="polite">
        {shown
          .map(({ court, match, final }) => {
            const a = person(match.playerA)?.name ?? "TBD";
            const b = person(match.playerB)?.name ?? "TBD";
            if (final && match.outcome === "walkover")
              return `${court.name}: ${person(match.winnerId)?.name ?? "TBD"} wins by walkover.`;
            if (final && tournament.bestOf > 1)
              return `${court.name}: final, ${a} ${match.gamesA} games, ${b} ${match.gamesB} games.`;
            if (final) return `${court.name}: final, ${a} ${match.scoreA}, ${b} ${match.scoreB}.`;
            const series = tournament.bestOf > 1 ? `, games ${match.gamesA}–${match.gamesB}` : "";
            const pending = isDecided(tournament, match.scoreA, match.scoreB)
              ? ", result pending"
              : "";
            return `${court.name}: ${a} ${match.scoreA}, ${b} ${match.scoreB}${series}${pending}.`;
          })
          .join(" ")}
      </p>
      {playing.length > 0 ? (
        <div
          className={`co-tv-courts is-${shown.length === 1 ? 1 : "many"}`}
          style={{ "--co-tv-cols": columns } as CSSProperties}
        >
          {shown.map(({ court, match, final }) => {
            const pressure = final
              ? { a: false, b: false }
              : gamePoints(tournament, match.scoreA, match.scoreB);
            const decided = final || isDecided(tournament, match.scoreA, match.scoreB);
            const games = gameScores(match);
            const tally = final && series;
            const walkover = final && match.outcome === "walkover";
            return (
              <section
                key={court.id}
                className={`co-tv-court${final ? " is-final" : ""}`}
                aria-label={`${court.name} ${final ? "final result" : "score"}`}
              >
                <header>
                  {final ? null : <span className="co-dot" aria-hidden="true" />}
                  <strong>{court.name}</strong>
                  <span className="co-tv-what">
                    <span className="co-tv-round">
                      <span className="co-hide-sm">{matchRound(tournament, match)}</span>
                      <span className="co-show-sm">{matchRound(tournament, match, "tiny")}</span>
                    </span>
                    <span className="co-tv-match">
                      M{match.number}
                      {series && !final ? ` · Game ${match.gamesA + match.gamesB + 1}` : ""}
                    </span>
                  </span>
                  {final ? (
                    <span className="co-tv-state">{walkover ? "Final · W/O" : "Final"}</span>
                  ) : decided ? (
                    <span className="co-tv-state is-pending">
                      <span className="co-hide-sm">Result </span>pending
                    </span>
                  ) : (
                    <span className="co-num">{clock(match.startedAt, now)}</span>
                  )}
                </header>
                {(["a", "b"] as const).map((side) => {
                  const who = person(side === "a" ? match.playerA : match.playerB);
                  const score = tally
                    ? side === "a"
                      ? match.gamesA
                      : match.gamesB
                    : side === "a"
                      ? match.scoreA
                      : match.scoreB;
                  const other = tally
                    ? side === "a"
                      ? match.gamesB
                      : match.gamesA
                    : side === "a"
                      ? match.scoreB
                      : match.scoreA;
                  const won = side === "a" ? match.gamesA : match.gamesB;
                  const ahead = final
                    ? match.winnerId === (side === "a" ? match.playerA : match.playerB)
                    : score > other;
                  const behind = final ? !ahead : score < other;
                  return (
                    <div
                      key={side}
                      className={`co-tv-row${ahead ? " is-leading" : ""}${behind ? " is-trailing" : ""}`}
                    >
                      <span className="co-tv-name">
                        <span className="co-tv-who">
                          <span className="co-tv-seed co-num">{who?.seed ?? ""}</span>
                          <span className="co-tv-player">{who?.name ?? "TBD"}</span>
                          {match.server === side && !decided ? (
                            <span className="co-tv-serve">
                              <span className="co-sr">Serving</span>
                            </span>
                          ) : null}
                        </span>
                        <small>{who?.club ?? "Independent"}</small>
                        {decided && ahead && final ? (
                          <em className="is-won">{walkover ? "Wins by walkover" : "Winner"}</em>
                        ) : pressure[side] ? (
                          <em>{pressureLabel(tournament, match, side)}</em>
                        ) : (
                          <em className="is-empty" aria-hidden="true">
                            Game point
                          </em>
                        )}
                      </span>
                      {series && !walkover && (!tally || games.length > 0) ? (
                        <span
                          className="co-tv-games co-num"
                          role="img"
                          aria-label={
                            tally
                              ? `Game scores ${games.map((game) => (side === "a" ? game[0] : game[1])).join(", ")}`
                              : `${won} ${won === 1 ? "game" : "games"} won${
                                  games.length > 0
                                    ? `, game scores ${games.map((game) => (side === "a" ? game[0] : game[1])).join(", ")}`
                                    : ""
                                }`
                          }
                        >
                          {games.map((game, index) => {
                            const mine = side === "a" ? game[0] : game[1];
                            const theirs = side === "a" ? game[1] : game[0];
                            return (
                              <span key={index} className={mine > theirs ? "is-won" : ""}>
                                {side === "a" ? (
                                  <span className="co-tv-cap" aria-hidden="true">
                                    G{index + 1}
                                  </span>
                                ) : null}
                                {mine}
                              </span>
                            );
                          })}
                          {tally ? null : (
                            <b
                              className={
                                won > (side === "a" ? match.gamesB : match.gamesA)
                                  ? "is-lead"
                                  : undefined
                              }
                            >
                              {side === "a" ? (
                                <span className="co-tv-cap" aria-hidden="true">
                                  Games
                                </span>
                              ) : null}
                              {won}
                            </b>
                          )}
                        </span>
                      ) : null}
                      <span className={`co-tv-score${walkover ? " is-walkover" : ""}`}>
                        {series && side === "a" && !walkover ? (
                          <span className="co-tv-cap" aria-hidden="true">
                            {tally ? "Games" : "Points"}
                          </span>
                        ) : null}
                        {walkover ? (ahead ? "W/O" : "–") : score}
                      </span>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      ) : champion ? null : (
        <p className="co-tv-quiet">Next match starts soon</p>
      )}
      <footer className="co-tv-next">
        <span className="co-tv-next-label">Up next</span>
        {upNext.length === 0 ? (
          <span className="co-tv-next-empty">
            {tournament.status === "finished" ? "Tournament complete" : "Waiting for results"}
          </span>
        ) : (
          <ol>
            {upNext.map((match) => (
              <li key={match.id}>
                <span className="co-num">M{match.number}</span>
                <strong>{person(match.playerA)?.name ?? "TBD"}</strong>
                <i>vs</i>
                <strong>{person(match.playerB)?.name ?? "TBD"}</strong>
              </li>
            ))}
          </ol>
        )}
      </footer>
    </div>
  );
}
