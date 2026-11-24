import { useState } from "react";
import { CheckIcon, PlayIcon, UndoIcon } from "./Icons";
import { Button, Select } from "dohc/ui";
import {
  gamePoints,
  isDecided,
  minutesSince,
  roundCount,
  roundName,
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
  busy: ReadonlySet<string>;
  disabled: boolean;
}

interface CourtBoardProps {
  snapshot: Snapshot;
  people: Map<string, Standing>;
  actions?: ScoreActions;
}

export function CourtBoard({ snapshot, people, actions }: CourtBoardProps) {
  const ready = snapshot.matches.filter((match) => match.status === "ready");
  return (
    <div className="co-courts">
      {snapshot.courts.map((court) => {
        const match = court.matchId
          ? snapshot.matches.find((entry) => entry.id === court.matchId)
          : undefined;
        return match ? (
          <LiveCourt
            key={court.id}
            court={court}
            match={match}
            snapshot={snapshot}
            people={people}
            actions={actions}
          />
        ) : (
          <FreeCourt
            key={court.id}
            court={court}
            ready={ready}
            snapshot={snapshot}
            people={people}
            actions={actions}
          />
        );
      })}
    </div>
  );
}

function LiveCourt({
  court,
  match,
  snapshot,
  people,
  actions,
}: {
  court: Court;
  match: Match;
  snapshot: Snapshot;
  people: Map<string, Standing>;
  actions?: ScoreActions;
}) {
  const tournament = snapshot.tournament!;
  const decided = isDecided(tournament, match.scoreA, match.scoreB);
  const pressure = gamePoints(tournament, match.scoreA, match.scoreB);
  const busy = (actions?.disabled ?? false) || (actions?.busy.has(match.id) ?? false);
  const rounds = roundCount(snapshot);
  const isFinal = match.round === rounds;
  const pressureLabel = isFinal ? "Championship" : "Game";
  return (
    <section className="co-court co-court--live" aria-label={`${court.name}, live`}>
      <header className="co-court-head">
        <div>
          <h3>{court.name}</h3>
          <p>
            {roundName(match.round, rounds)} · Match {match.slot}
          </p>
        </div>
        <span className="co-live-chip">
          <span className="co-pulse" aria-hidden="true" />
          Live · {minutesSince(match.startedAt, snapshot.now)}
        </span>
      </header>
      <div className="co-sides">
        {(["a", "b"] as const).map((side) => {
          const id = side === "a" ? match.playerA : match.playerB;
          const player = id ? people.get(id) : undefined;
          const score = side === "a" ? match.scoreA : match.scoreB;
          const leading =
            side === "a" ? match.scoreA > match.scoreB : match.scoreB > match.scoreA;
          const content = (
            <>
              <span className="co-side-seed">{player?.seed}</span>
              <span className="co-side-name">
                <strong>{player?.name ?? "—"}</strong>
                <small>
                  {player?.club ?? "Independent"} · {player?.rating ?? "—"}
                </small>
              </span>
              <span className="co-side-score" aria-live="polite">
                {score}
              </span>
            </>
          );
          const className = `co-side${leading ? " co-side--leading" : ""}${
            pressure[side] ? " co-side--pressure" : ""
          }`;
          return actions ? (
            <button
              key={side}
              type="button"
              className={`${className} co-side--tap`}
              disabled={busy || decided}
              onClick={() => actions.point(match, side)}
              aria-label={`Point to ${player?.name ?? "this side"}, now ${score}`}
            >
              {content}
              <span className="co-plus" aria-hidden="true">
                +1
              </span>
            </button>
          ) : (
            <div key={side} className={className}>
              {content}
            </div>
          );
        })}
      </div>
      <p className="co-court-note" role="status">
        {decided
          ? `${people.get((match.scoreA > match.scoreB ? match.playerA : match.playerB) ?? "")?.name ?? "A player"} wins ${Math.max(match.scoreA, match.scoreB)}–${Math.min(match.scoreA, match.scoreB)}${actions ? " — complete the match to advance them." : "."}`
          : pressure.a && pressure.b
            ? `${pressureLabel} point for both players`
            : pressure.a || pressure.b
              ? `${pressureLabel} point ${people.get((pressure.a ? match.playerA : match.playerB) ?? "")?.name ?? ""}`
              : `First to ${tournament.pointsToWin}, win by ${tournament.winBy}`}
      </p>
      {actions ? (
        <div className="co-court-actions">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || match.scoreA + match.scoreB === 0}
            onClick={() => actions.undo(match)}
          >
            <UndoIcon /> Undo point
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !decided}
            loading={busy && decided}
            onClick={() => actions.complete(match)}
          >
            <CheckIcon /> Complete match
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function FreeCourt({
  court,
  ready,
  snapshot,
  people,
  actions,
}: {
  court: Court;
  ready: Match[];
  snapshot: Snapshot;
  people: Map<string, Standing>;
  actions?: ScoreActions;
}) {
  const [choice, setChoice] = useState("");
  const rounds = roundCount(snapshot);
  const selected = ready.find((match) => match.id === choice) ?? ready[0];
  const label = (match: Match) =>
    `${roundName(match.round, rounds)} ${match.slot}: ${people.get(match.playerA ?? "")?.name ?? "?"} vs ${people.get(match.playerB ?? "")?.name ?? "?"}`;
  return (
    <section className="co-court co-court--free" aria-label={`${court.name}, free`}>
      <header className="co-court-head">
        <div>
          <h3>{court.name}</h3>
          <p>Free</p>
        </div>
      </header>
      {snapshot.tournament?.status === "finished" ? (
        <p className="co-court-empty">The tournament is over.</p>
      ) : !actions ? (
        <p className="co-court-empty">Waiting for the next match.</p>
      ) : ready.length === 0 ? (
        <p className="co-court-empty">No match is ready yet. Finish a live match to fill the next round.</p>
      ) : (
        <div className="co-start">
          <label className="kit-sr-only" htmlFor={`next-${court.id}`}>
            Match to start on {court.name}
          </label>
          <Select
            id={`next-${court.id}`}
            value={selected?.id ?? ""}
            disabled={actions.disabled}
            onChange={(event) => setChoice(event.target.value)}
          >
            {ready.map((match) => (
              <option key={match.id} value={match.id}>
                {label(match)}
              </option>
            ))}
          </Select>
          <Button
            variant="primary"
            size="sm"
            disabled={actions.disabled || !selected || actions.busy.has(selected.id)}
            onClick={() => selected && actions.start(selected, court)}
          >
            <PlayIcon /> Start on {court.name}
          </Button>
        </div>
      )}
    </section>
  );
}
