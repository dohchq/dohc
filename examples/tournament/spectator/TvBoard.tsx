import { useRef } from "react";
import { ExpandIcon, TrophyIcon } from "./Icons";
import { Button } from "dohc/ui";
import {
  describeEvent,
  gamePoints,
  roundCount,
  roundName,
  type Snapshot,
  type Standing,
} from "./model";

export function TvBoard({ snapshot, people }: { snapshot: Snapshot; people: Map<string, Standing> }) {
  const frame = useRef<HTMLDivElement | null>(null);
  const tournament = snapshot.tournament!;
  const rounds = roundCount(snapshot);
  const live = snapshot.courts.flatMap((court) => {
    const match = snapshot.matches.find((entry) => entry.id === court.matchId);
    return match ? [{ court, match }] : [];
  });
  const upNext = snapshot.matches.filter((match) => match.status === "ready").slice(0, 4);
  const champion = tournament.championId ? people.get(tournament.championId) : undefined;
  const name = (id: string | null) => (id ? (people.get(id)?.name ?? "—") : "To be decided");
  const canFullscreen = typeof document !== "undefined" && document.fullscreenEnabled;

  return (
    <div className="co-tv" ref={frame}>
      <header className="co-tv-head">
        <div>
          <p className="co-tv-eyebrow">{tournament.sport} · Live scores</p>
          <h2>{tournament.name}</h2>
        </div>
        {canFullscreen ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void frame.current?.requestFullscreen().catch(() => undefined);
            }}
          >
            <ExpandIcon /> Full screen
          </Button>
        ) : null}
      </header>
      {champion ? (
        <div className="co-tv-champion" role="status">
          <TrophyIcon size={48} />
          <div>
            <p>Champion</p>
            <strong>{champion.name}</strong>
            <span>
              {champion.wins}–{champion.losses} · rating {champion.rating}
            </span>
          </div>
        </div>
      ) : null}
      {live.length > 0 ? (
        <div className="co-tv-courts">
          {live.map(({ court, match }) => {
            const pressure = gamePoints(tournament, match.scoreA, match.scoreB);
            return (
              <section key={court.id} className="co-tv-court" aria-label={`${court.name} score`}>
                <p className="co-tv-court-name">
                  <span className="co-pulse" aria-hidden="true" />
                  {court.name} · {roundName(match.round, rounds)}
                </p>
                {(["a", "b"] as const).map((side) => {
                  const score = side === "a" ? match.scoreA : match.scoreB;
                  const other = side === "a" ? match.scoreB : match.scoreA;
                  return (
                    <div
                      key={side}
                      className={`co-tv-row${score > other ? " co-tv-row--leading" : ""}`}
                    >
                      <span className="co-tv-name">
                        {name(side === "a" ? match.playerA : match.playerB)}
                        {pressure[side] ? <em>Game point</em> : null}
                      </span>
                      <span className="co-tv-score">{score}</span>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      ) : champion ? null : (
        <p className="co-tv-quiet">No match is on court right now.</p>
      )}
      <div className="co-tv-foot">
        <section aria-label="Up next">
          <h3>Up next</h3>
          {upNext.length === 0 ? (
            <p className="co-tv-muted">Waiting on live results.</p>
          ) : (
            <ol>
              {upNext.map((match) => (
                <li key={match.id}>
                  <span>{roundName(match.round, rounds)}</span>
                  {name(match.playerA)} vs {name(match.playerB)}
                </li>
              ))}
            </ol>
          )}
        </section>
        <section aria-label="Latest">
          <h3>Latest</h3>
          <ol>
            {snapshot.recent.slice(0, 4).map((event) => (
              <li key={event.id}>{describeEvent(event, snapshot, people)}</li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
