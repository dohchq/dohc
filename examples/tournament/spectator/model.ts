import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AppBackendError, type AppClient } from "dohc/app";

export type Side = "a" | "b";
export type MatchStatus = "waiting" | "ready" | "live" | "done" | "bye" | "skipped";
export type BracketSide = "winners" | "losers" | "final";
export type Format = "single" | "double";
export type Visibility = "shared" | "private";

export interface TournamentSummary {
  id: string;
  name: string;
  sport: string;
  status: "live" | "finished";
  visibility: Visibility;
  createdAt: number;
}

export interface Tournament extends TournamentSummary {
  format: Format;
  bestOf: number;
  bracketSize: number;
  pointsToWin: number;
  winBy: number;
  kFactor: number;
  championId: string | null;
  updatedAt: number;
}

export interface Standing {
  id: string;
  name: string;
  club: string | null;
  seed: number;
  rating: number;
  startRating: number;
  ratingChange: number;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDiff: number;
  eliminatedRound: number | null;
  place: number;
  tied: boolean;
}

export interface Match {
  id: string;
  number: number;
  bracket: BracketSide;
  round: number;
  slot: number;
  playerA: string | null;
  playerB: string | null;
  nextMatchId: string | null;
  nextSlot: Side | null;
  loserNextMatchId: string | null;
  loserNextSlot: Side | null;
  courtId: string | null;
  status: MatchStatus;
  scoreA: number;
  scoreB: number;
  gamesA: number;
  gamesB: number;
  gameScores: string;
  server: Side | null;
  outcome: "played" | "walkover" | "reported" | null;
  winnerId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  ratingChange: number | null;
  version: number;
}

export interface Court {
  id: string;
  name: string;
  position: number;
  matchId: string | null;
}

export interface MatchEvent {
  id: string;
  matchId: string;
  seq: number;
  game: number;
  kind:
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
  courtId: string | null;
  at: number;
}

export interface Snapshot {
  tournaments: TournamentSummary[];
  tournament: Tournament | null;
  standings: Standing[];
  matches: Match[];
  courts: Court[];
  recent: MatchEvent[];
  now: number;
}

const HEARTBEAT_MS = 15_000;

export type Freshness = "live" | "polling" | "stale";

export interface LiveState {
  data: Snapshot | undefined;
  error: AppBackendError | null;
  freshness: Freshness;
  syncedAt: number | null;
  switching: boolean;
  clockSkew: number;
  isCurrent(tournamentId: string | null): boolean;
  reload(): Promise<boolean>;
  patchMatch(tournamentId: string, match: Match): void;
}

export function useLiveSnapshot(
  client: AppClient,
  tournamentId: string | null,
  pollMs: number,
  view: "public" | "desk",
): LiveState {
  const [data, setData] = useState<Snapshot | undefined>(undefined);
  const [error, setError] = useState<AppBackendError | null>(null);
  const [pushed, setPushed] = useState(false);
  const [clockSkew, setClockSkew] = useState(0);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [answeredFor, setAnsweredFor] = useState<string | null>(null);
  const pinnedId = useRef<string | null>(tournamentId);
  const loadRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));

  useEffect(() => {
    if (tournamentId !== null) pinnedId.current = tournamentId;
    let disposed = false;
    let inFlight = false;
    let again = false;
    let seen = -1;
    let eventsArrive = false;
    let token = 0;
    let timer: number | undefined;
    let waiters: Array<(ok: boolean) => void> = [];
    const settle = (ok: boolean) => {
      const done = waiters;
      waiters = [];
      for (const resolve of done) resolve(ok);
    };
    const clearTimer = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      clearTimer();
      if (disposed || document.hidden) return;
      timer = window.setTimeout(() => void load(), eventsArrive ? HEARTBEAT_MS : pollMs);
    };
    const load = async () => {
      clearTimer();
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      again = false;
      const started = Date.now();
      const mine = ++token;
      const target = tournamentId ?? pinnedId.current;
      let ok = false;
      try {
        const reply = await client.invoke<Snapshot>(
          "liveSnapshot",
          {
            ...(target ? { tournamentId: target } : {}),
            ...(view === "public" ? { view } : {}),
          },
          undefined,
          { readOnly: true },
        );
        if (disposed || mine !== token) return;
        seen = Math.max(seen, reply.revision);
        const result = reply.result;
        if (result.tournament) pinnedId.current = result.tournament.id;
        setAnsweredFor(target);
        setData((current) => keepNewerMatches(current, result));
        const skew = result.now - Date.now();
        setClockSkew((current) => (Math.abs(current - skew) > 1000 ? skew : current));
        setSyncedAt((previous) => Math.max((previous ?? 0) + 1, started));
        setError(null);
        ok = true;
      } catch (caught: unknown) {
        if (disposed || mine !== token) return;
        setError(caught instanceof AppBackendError ? caught : new AppBackendError(503));
      } finally {
        if (!disposed && mine === token) {
          inFlight = false;
          if (again) void load();
          else {
            schedule();
            settle(ok);
          }
        }
      }
    };
    loadRef.current = () => {
      if (disposed) return Promise.resolve(false);
      const done = new Promise<boolean>((resolve) => waiters.push(resolve));
      void load();
      return done;
    };
    const unsubscribe = client.subscribe?.((event) => {
      if (disposed) return;
      if (!eventsArrive) {
        eventsArrive = true;
        setPushed(true);
      }
      if (event.revision > seen) void load();
    });
    void load();
    const onVisible = () => {
      if (document.hidden) clearTimer();
      else void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      token += 1;
      settle(false);
      clearTimer();
      unsubscribe?.();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [client, tournamentId, pollMs, view]);

  const isCurrent = useCallback((id: string | null) => id !== null && id === pinnedId.current, []);
  const reload = useCallback(() => loadRef.current(), []);
  const patchMatch = useCallback((forTournamentId: string, match: Match) => {
    if (forTournamentId !== pinnedId.current) return;
    setData((current) => {
      if (!current || current.tournament?.id !== forTournamentId) return current;
      const known = current.matches.find((entry) => entry.id === match.id);
      if (!known || known.version >= match.version) return current;
      const onCourt = match.status === "live" ? match.courtId : null;
      return {
        ...current,
        matches: current.matches.map((entry) => (entry.id === match.id ? match : entry)),
        courts: current.courts.map((court) =>
          court.id === onCourt
            ? { ...court, matchId: match.id }
            : court.matchId === match.id
              ? { ...court, matchId: null }
              : court,
        ),
      };
    });
  }, []);

  const switching = tournamentId !== null && answeredFor !== tournamentId;
  const freshness: Freshness = error ? "stale" : pushed ? "live" : "polling";
  return {
    data,
    error,
    freshness,
    syncedAt,
    switching,
    clockSkew,
    isCurrent,
    reload,
    patchMatch,
  };
}

function keepNewerMatches(current: Snapshot | undefined, next: Snapshot): Snapshot {
  if (!current?.tournament || current.tournament.id !== next.tournament?.id) return next;
  const known = new Map(current.matches.map((match) => [match.id, match]));
  let kept = false;
  const matches = next.matches.map((match) => {
    const mine = known.get(match.id);
    if (mine && mine.version > match.version) {
      kept = true;
      return mine;
    }
    return match;
  });
  if (!kept) return next;
  return {
    ...next,
    matches,
    courts: next.courts.map((court) => ({
      ...court,
      matchId:
        matches.find((match) => match.status === "live" && match.courtId === court.id)?.id ?? null,
    })),
  };
}

export function useNow(skew: number, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => {
    setNow(Date.now() + skew);
    const id = window.setInterval(() => setNow(Date.now() + skew), everyMs);
    return () => window.clearInterval(id);
  }, [skew, everyMs]);
  return now;
}

export type LabelLength = "full" | "short" | "tiny";

export function winnersRounds(tournament: Tournament): number {
  return Math.log2(tournament.bracketSize);
}

export function losersRounds(tournament: Tournament): number {
  return tournament.format === "double" ? 2 * (winnersRounds(tournament) - 1) : 0;
}

export function roundLabel(
  tournament: Tournament,
  bracket: BracketSide,
  round: number,
  length: LabelLength = "full",
): string {
  if (bracket === "final") {
    if (round === 1) return length === "tiny" ? "GF" : "Grand final";
    return length === "tiny" ? "GF2" : length === "short" ? "Reset" : "Grand final reset";
  }
  if (bracket === "losers") {
    if (round === losersRounds(tournament)) return length === "tiny" ? "LF" : "Losers final";
    return length === "tiny"
      ? `LR${round}`
      : length === "short"
        ? `Losers R${round}`
        : `Losers round ${round}`;
  }
  const double = tournament.format === "double";
  const remaining = winnersRounds(tournament) - round;
  const names =
    remaining === 0
      ? ["F", "Final", "Final"]
      : remaining === 1
        ? ["SF", "Semifinal", "Semifinals"]
        : remaining === 2
          ? ["QF", "Quarterfinal", "Quarterfinals"]
          : [
              `R${2 ** (remaining + 1)}`,
              `R${2 ** (remaining + 1)}`,
              `Round of ${2 ** (remaining + 1)}`,
            ];
  const [tiny, short, full] = names as [string, string, string];
  if (!double) return length === "tiny" ? tiny : length === "short" ? short : full;
  if (length === "tiny") return `W${tiny}`;
  if (length === "short") return remaining === 0 ? "Winners final" : `Winners ${tiny}`;
  return `Winners ${full.toLowerCase()}`;
}

export function matchRound(
  tournament: Tournament,
  match: Match,
  length: LabelLength = "full",
): string {
  return roundLabel(tournament, match.bracket, match.round, length);
}

export function isTitleMatch(tournament: Tournament, match: Match): boolean {
  return tournament.format === "double"
    ? match.bracket === "final"
    : match.round === winnersRounds(tournament);
}

export function stageLabel(tournament: Tournament, stage: number): string {
  if (tournament.format === "single") return roundLabel(tournament, "winners", stage, "short");
  const losers = losersRounds(tournament);
  return stage <= losers ? roundLabel(tournament, "losers", stage, "short") : "Grand final";
}

export function feederText(snapshot: Snapshot, match: Match, side: Side): string | null {
  for (const other of snapshot.matches) {
    if (other.nextMatchId === match.id && other.nextSlot === side)
      return `Winner of M${other.number}`;
    if (other.loserNextMatchId === match.id && other.loserNextSlot === side)
      return `Loser of M${other.number}`;
  }
  return null;
}

export function gameScores(match: Match): Array<[number, number]> {
  return match.gameScores
    .split(" ")
    .filter(Boolean)
    .map((game) => game.split("-").map(Number) as [number, number]);
}

export function gamesToWin(tournament: Tournament): number {
  return Math.floor(tournament.bestOf / 2) + 1;
}

export function pressureLabel(tournament: Tournament, match: Match, side: Side): string {
  const games = side === "a" ? match.gamesA : match.gamesB;
  if (games + 1 < gamesToWin(tournament)) return "Game point";
  if (
    isTitleMatch(tournament, match) &&
    !(match.bracket === "final" && match.round === 1 && side === "b")
  )
    return "Championship point";
  return "Match point";
}

export function nextLabel(tournament: Tournament, snapshot: Snapshot, match: Match): string {
  const next = match.nextMatchId
    ? snapshot.matches.find((entry) => entry.id === match.nextMatchId)
    : undefined;
  return next ? matchRound(tournament, next, "short") : "the title";
}

export function playersById(snapshot: Snapshot): Map<string, Standing> {
  return new Map(snapshot.standings.map((player) => [player.id, player]));
}

export function isDecided(tournament: Tournament, scoreA: number, scoreB: number): boolean {
  return (
    Math.max(scoreA, scoreB) >= tournament.pointsToWin &&
    Math.abs(scoreA - scoreB) >= tournament.winBy
  );
}

export function gamePoints(
  tournament: Tournament,
  scoreA: number,
  scoreB: number,
): { a: boolean; b: boolean } {
  if (isDecided(tournament, scoreA, scoreB)) return { a: false, b: false };
  return {
    a: isDecided(tournament, scoreA + 1, scoreB),
    b: isDecided(tournament, scoreA, scoreB + 1),
  };
}

export function eloDelta(winnerRating: number, loserRating: number, kFactor: number): number {
  const expected = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
  return Math.round(kFactor * (1 - expected));
}

export function clock(from: number | null, now: number): string {
  if (!from) return "0:00";
  const seconds = Math.max(0, Math.floor((now - from) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return minutes < 60
    ? `${minutes}:${rest}`
    : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${rest}`;
}

export function timeOfDay(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function signed(value: number): string {
  return value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : "0";
}

export function liveCourts(snapshot: Snapshot): Array<{ court: Court; match: Match }> {
  return snapshot.courts.flatMap((court) => {
    const match = court.matchId
      ? snapshot.matches.find((entry) => entry.id === court.matchId && entry.status === "live")
      : undefined;
    return match ? [{ court, match }] : [];
  });
}

export function eventText(
  event: MatchEvent,
  snapshot: Snapshot,
  people: Map<string, Standing>,
): string {
  const match = snapshot.matches.find((entry) => entry.id === event.matchId);
  const nameOf = (side: Side | null) => {
    const id = side === "a" ? event.playerA : side === "b" ? event.playerB : null;
    return (id && people.get(id)?.name) || "A player";
  };
  const court = snapshot.courts.find((entry) => entry.id === event.courtId)?.name ?? "a court";
  if (event.kind === "start") return `M${match?.number ?? ""} started · ${court}`;
  if (event.kind === "complete") return `${nameOf(event.side)} won M${match?.number ?? ""}`;
  if (event.kind === "report")
    return `${nameOf(event.side)} won M${match?.number ?? ""} · score sheet`;
  if (event.kind === "walkover") return `${nameOf(event.side)} won M${match?.number ?? ""}`;
  if (event.kind === "game") return `${nameOf(event.side)} took game ${event.game} · ${court}`;
  if (event.kind === "reopen") return `M${match?.number ?? ""} result reopened`;
  if (event.kind === "cancel") return `M${match?.number ?? ""} start cancelled · ${court}`;
  if (event.kind === "undo")
    return event.side
      ? `Point removed · ${nameOf(event.side)} · ${court}`
      : `Game ${event.game} reopened · ${court}`;
  return `${nameOf(event.side)} · ${court}`;
}

export const HISTORY_LIMIT = 500;

export function eventScore(
  tournament: Tournament,
  event: { kind: string; side: Side | null; game: number; scoreA: number; scoreB: number },
): string {
  if (event.kind === "start" || event.kind === "cancel" || event.kind === "bye") return "";
  if (event.kind === "walkover" || (event.kind === "reopen" && !event.side)) return "W/O";
  if (
    tournament.bestOf > 1 &&
    (event.kind === "complete" || event.kind === "report" || event.kind === "reopen") &&
    event.side
  ) {
    const won = gamesToWin(tournament);
    const lost = Math.max(0, event.game - won);
    return event.side === "a" ? `${won}–${lost}` : `${lost}–${won}`;
  }
  return `${event.scoreA}–${event.scoreB}`;
}

export function modalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

export function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}

export function trapFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex='0']",
    ),
  ];
  if (items.length === 0) {
    event.preventDefault();
    return;
  }
  const first = items[0]!;
  const last = items.at(-1)!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === event.currentTarget)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
