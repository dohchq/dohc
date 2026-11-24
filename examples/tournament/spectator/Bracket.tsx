import { useMemo, useState, type CSSProperties } from "react";
import { TrophyIcon } from "./Icons";
import {
  playersById,
  roundCount,
  roundName,
  type Match,
  type Snapshot,
  type Standing,
} from "./model";

const CARD_WIDTH = 212;
const CARD_HEIGHT = 64;
const ROW = 84;
const GAP = 56;
const HEADER = 34;

interface BracketProps {
  snapshot: Snapshot;
  onOpenMatch?: (match: Match) => void;
}

function columnX(round: number): number {
  return (round - 1) * (CARD_WIDTH + GAP);
}

function centerY(round: number, slot: number): number {
  return HEADER + (slot - 0.5) * 2 ** (round - 1) * ROW;
}

export function Bracket({ snapshot, onOpenMatch }: BracketProps) {
  const [hoveredPlayer, setHoveredPlayer] = useState<string | null>(null);
  const [pinnedPlayer, setPinnedPlayer] = useState<string | null>(null);
  const rounds = roundCount(snapshot);
  const people = useMemo(() => playersById(snapshot), [snapshot]);
  const courts = useMemo(
    () => new Map(snapshot.courts.map((court) => [court.id, court.name])),
    [snapshot],
  );
  const rawFocus = hoveredPlayer ?? pinnedPlayer;
  const focusPlayer = rawFocus && people.has(rawFocus) ? rawFocus : null;
  const activePinned = pinnedPlayer && people.has(pinnedPlayer) ? pinnedPlayer : null;
  const size = snapshot.tournament?.bracketSize ?? 0;
  const height = HEADER + (size / 2) * ROW;
  const width = columnX(rounds + 1) + 150;
  const champion = snapshot.tournament?.championId
    ? people.get(snapshot.tournament.championId)
    : undefined;
  const final = snapshot.matches.find((match) => match.round === rounds);

  const togglePlayer = (id: string) => {
    setPinnedPlayer((current) => {
      if (current === id) {
        setHoveredPlayer(null);
        return null;
      }
      return id;
    });
  };

  const onPath = (match: Match) =>
    focusPlayer !== null && (match.playerA === focusPlayer || match.playerB === focusPlayer);

  return (
    <div className="co-bracket-scroll" onMouseLeave={() => setHoveredPlayer(null)}>
      <div
        className={`co-bracket${focusPlayer ? " co-bracket--focus" : ""}`}
        style={{ width, height }}
        role="group"
        aria-label="Tournament bracket"
      >
        <svg className="co-bracket-lines" width={width} height={height} aria-hidden="true">
          {snapshot.matches
            .filter((match) => match.round < rounds)
            .map((match) => {
              const x1 = columnX(match.round) + CARD_WIDTH;
              const y1 = centerY(match.round, match.slot);
              const x2 = columnX(match.round + 1);
              const y2 = centerY(match.round + 1, Math.ceil(match.slot / 2));
              const mid = x1 + GAP / 2;
              const decided = match.winnerId !== null;
              const lit = decided && focusPlayer !== null && match.winnerId === focusPlayer;
              return (
                <path
                  key={match.id}
                  d={`M${x1} ${y1} H${mid} V${y2} H${x2}`}
                  className={`co-line${decided ? " co-line--decided" : ""}${lit ? " co-line--lit" : ""}`}
                />
              );
            })}
          {final ? (
            <path
              d={`M${columnX(rounds) + CARD_WIDTH} ${centerY(rounds, 1)} H${columnX(rounds + 1)}`}
              className={`co-line${final.winnerId ? " co-line--decided" : ""}${
                final.winnerId && final.winnerId === focusPlayer ? " co-line--lit" : ""
              }`}
            />
          ) : null}
        </svg>
        {Array.from({ length: rounds }, (_, index) => (
          <div
            key={index}
            className="co-round-label"
            style={{ left: columnX(index + 1), width: CARD_WIDTH }}
          >
            {roundName(index + 1, rounds)}
          </div>
        ))}
        <div
          className="co-round-label"
          style={{ left: columnX(rounds + 1), width: 150 }}
        >
          Champion
        </div>
        {snapshot.matches.map((match) => (
          <MatchCard
            key={match.id}
            match={match}
            people={people}
            courtName={match.courtId ? courts.get(match.courtId) : undefined}
            highlighted={onPath(match)}
            focusPlayer={focusPlayer}
            pinnedPlayer={activePinned}
            onHoverPlayer={setHoveredPlayer}
            onTogglePlayer={togglePlayer}
            onOpen={onOpenMatch}
            style={{
              left: columnX(match.round),
              top: centerY(match.round, match.slot) - CARD_HEIGHT / 2,
              width: CARD_WIDTH,
              height: CARD_HEIGHT,
            }}
          />
        ))}
        {champion ? (
          <button
            type="button"
            className="co-champion co-champion--crowned"
            style={{ left: columnX(rounds + 1), top: centerY(rounds, 1) - 44, width: 150 }}
            aria-pressed={activePinned === champion.id}
            onClick={() => togglePlayer(champion.id)}
            onMouseEnter={() => setHoveredPlayer(champion.id)}
            onMouseLeave={() => setHoveredPlayer(null)}
            onFocus={() => setHoveredPlayer(champion.id)}
            onBlur={() => setHoveredPlayer(null)}
          >
            <TrophyIcon size={22} />
            <span>{champion.name}</span>
          </button>
        ) : (
          <div
            className="co-champion"
            style={{ left: columnX(rounds + 1), top: centerY(rounds, 1) - 44, width: 150 }}
          >
            <TrophyIcon size={22} />
            <span>To be decided</span>
          </div>
        )}
      </div>
    </div>
  );
}

interface MatchCardProps {
  match: Match;
  people: Map<string, Standing>;
  courtName: string | undefined;
  highlighted: boolean;
  focusPlayer: string | null;
  pinnedPlayer: string | null;
  onHoverPlayer: (id: string | null) => void;
  onTogglePlayer: (id: string) => void;
  onOpen?: (match: Match) => void;
  style: CSSProperties;
}

function MatchCard({
  match,
  people,
  courtName,
  highlighted,
  focusPlayer,
  pinnedPlayer,
  onHoverPlayer,
  onTogglePlayer,
  onOpen,
  style,
}: MatchCardProps) {
  const label = `${match.status === "live" ? "Live" : match.status === "done" ? "Final" : match.status === "bye" ? "Bye" : match.status === "ready" ? "Up next" : "Waiting"}`;
  const rows = (["a", "b"] as const).map((side) => {
    const id = side === "a" ? match.playerA : match.playerB;
    const player = id ? people.get(id) : undefined;
    const score = side === "a" ? match.scoreA : match.scoreB;
    const won = id !== null && match.winnerId === id;
    const lost = match.winnerId !== null && id !== null && !won;
    const rowClass = `co-card-row${won ? " co-card-row--won" : ""}${lost ? " co-card-row--lost" : ""}${
      id && id === focusPlayer ? " co-card-row--focus" : ""
    }`;
    const cells = (
      <>
        <span className="co-seed">{player ? player.seed : ""}</span>
        <span className="co-name">
          {player ? player.name : match.status === "bye" ? "Bye" : "—"}
        </span>
        <span className="co-score">
          {match.status === "live" || match.status === "done" ? score : ""}
        </span>
      </>
    );
    if (id) {
      return (
        <button
          key={side}
          type="button"
          className={`${rowClass} co-card-row--player`}
          aria-pressed={pinnedPlayer === id}
          aria-label={`Trace ${player?.name ?? "player"}'s bracket path`}
          onClick={() => onTogglePlayer(id)}
          onMouseEnter={() => onHoverPlayer(id)}
          onMouseLeave={() => onHoverPlayer(null)}
          onFocus={() => onHoverPlayer(id)}
          onBlur={() => onHoverPlayer(null)}
        >
          {cells}
        </button>
      );
    }
    return (
      <div key={side} className={rowClass}>
        {cells}
      </div>
    );
  });
  const className = `co-card co-card--${match.status}${highlighted ? " co-card--path" : ""}`;
  const title = `${label}${courtName && match.status === "live" ? ` on ${courtName}` : ""}`;
  const canOpen = Boolean(onOpen && match.status !== "bye");
  return (
    <div className={className} style={style} title={title}>
      {match.status === "live" ? (
        canOpen ? (
          <button
            type="button"
            className="co-card-flag co-card-flag--btn"
            onClick={() => onOpen!(match)}
            aria-label={`Open point log for ${title}: ${describeSides(match, people)}`}
          >
            <span className="co-pulse" aria-hidden="true" />
            {courtName ?? "Live"}
          </button>
        ) : (
          <span className="co-card-flag">
            <span className="co-pulse" aria-hidden="true" />
            {courtName ?? "Live"}
          </span>
        )
      ) : canOpen ? (
        <button
          type="button"
          className="co-card-log"
          onClick={() => onOpen!(match)}
          aria-label={`Open point log for ${title}: ${describeSides(match, people)}`}
        >
          Log
        </button>
      ) : null}
      {rows}
    </div>
  );
}

function describeSides(match: Match, people: Map<string, Standing>): string {
  const name = (id: string | null) => (id ? (people.get(id)?.name ?? "Unknown") : "to be decided");
  const scores =
    match.status === "live" || match.status === "done" ? ` ${match.scoreA}–${match.scoreB}` : "";
  return `${name(match.playerA)} vs ${name(match.playerB)}${scores}`;
}
