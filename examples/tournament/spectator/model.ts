import { useCallback, useEffect, useRef, useState } from "react";
import { AppBackendError, type AppClient } from "dohc/app";

export type Side = "a" | "b";
export type MatchStatus = "waiting" | "ready" | "live" | "done" | "bye";

export interface TournamentSummary {
  id: string;
  name: string;
  sport: string;
  status: "live" | "finished";
  createdAt: number;
}

export interface Tournament extends TournamentSummary {
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
}

export interface Match {
  id: string;
  round: number;
  slot: number;
  playerA: string | null;
  playerB: string | null;
  nextMatchId: string | null;
  nextSlot: Side | null;
  courtId: string | null;
  status: MatchStatus;
  scoreA: number;
  scoreB: number;
  winnerId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
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
  kind: "start" | "point" | "undo" | "complete";
  side: Side | null;
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
  rallies: number;
  now: number;
}

export interface LiveState {
  data: Snapshot | undefined;
  error: AppBackendError | null;
  loading: boolean;
  switching: boolean;
  isCurrent(tournamentId: string | null): boolean;
  reload(): void;
  hold(): void;
  patchMatch(tournamentId: string, match: Match): void;
}

export function useLiveSnapshot(
  client: AppClient,
  tournamentId: string | null,
  intervalMs: number,
): LiveState {
  const [data, setData] = useState<Snapshot | undefined>(undefined);
  const [error, setError] = useState<AppBackendError | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const pinnedId = useRef<string | null>(tournamentId);
  if (tournamentId !== null) pinnedId.current = tournamentId;

  const load = useCallback(() => {
    const target = tournamentId ?? pinnedId.current;
    const mine = ++generation.current;
    client.read<Snapshot>("liveSnapshot", target ? { tournamentId: target } : {}).then(
      (result) => {
        if (mine !== generation.current) return;
        if (tournamentId === null && result.tournament) pinnedId.current = result.tournament.id;
        setData(result);
        setError(null);
        setLoading(false);
      },
      (caught: unknown) => {
        if (mine !== generation.current) return;
        setError(caught instanceof AppBackendError ? caught : new AppBackendError(503));
        setLoading(false);
      },
    );
  }, [client, tournamentId]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    setLoading(true);
    load();
    const timer = window.setInterval(() => {
      if (!document.hidden) load();
    }, intervalMs);
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, intervalMs]);

  const isCurrent = useCallback(
    (id: string | null) => id !== null && id === pinnedId.current,
    [],
  );

  const reload = useCallback(() => {
    loadRef.current();
  }, []);

  const hold = useCallback(() => {
    generation.current += 1;
  }, []);

  const patchMatch = useCallback((forTournamentId: string, match: Match) => {
    if (forTournamentId !== pinnedId.current) return;
    setData((current) =>
      current && current.tournament?.id === forTournamentId
        ? {
            ...current,
            matches: current.matches.map((entry) =>
              entry.id === match.id && entry.version < match.version ? match : entry,
            ),
          }
        : current,
    );
  }, []);

  const switching = tournamentId !== null && data?.tournament?.id !== tournamentId;

  return { data, error, loading, switching, isCurrent, reload, hold, patchMatch };
}

export function roundName(round: number, rounds: number): string {
  const remaining = rounds - round;
  if (remaining === 0) return "Final";
  if (remaining === 1) return "Semifinals";
  if (remaining === 2) return "Quarterfinals";
  return `Round of ${2 ** (remaining + 1)}`;
}

export function roundCount(snapshot: Snapshot): number {
  return snapshot.tournament ? Math.log2(snapshot.tournament.bracketSize) : 0;
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

export function minutesSince(from: number | null, now: number): string {
  if (!from) return "";
  const minutes = Math.max(0, Math.floor((now - from) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function describeEvent(
  event: MatchEvent,
  snapshot: Snapshot,
  people: Map<string, Standing>,
): string {
  const match = snapshot.matches.find((entry) => entry.id === event.matchId);
  const nameOf = (side: Side | null) => {
    const id = side === "a" ? match?.playerA : side === "b" ? match?.playerB : null;
    return (id && people.get(id)?.name) || "A player";
  };
  const score = `${event.scoreA}–${event.scoreB}`;
  const court = snapshot.courts.find((entry) => entry.id === event.courtId)?.name ?? "a court";
  if (event.kind === "start")
    return `${nameOf("a")} vs ${nameOf("b")} started on ${court}`;
  if (event.kind === "complete") {
    const winner = event.side;
    const loser = winner === "a" ? "b" : "a";
    const high = Math.max(event.scoreA, event.scoreB);
    const low = Math.min(event.scoreA, event.scoreB);
    return `${nameOf(winner)} beat ${nameOf(loser)} ${high}–${low}`;
  }
  if (event.kind === "undo") return `Point taken back from ${nameOf(event.side)} (${score})`;
  return `${nameOf(event.side)} wins the rally (${score})`;
}
