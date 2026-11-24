import { useMemo, useState, type ReactNode } from "react";
import { Callout, Card, Grid, PageHeader, Select, Skeleton, Stack, StatCard, Tabs, Button } from "dohc/ui";
import { Bracket } from "./Bracket";
import { CourtBoard, type ScoreActions } from "./Courts";
import { Standings } from "./Standings";
import { TvBoard } from "./TvBoard";
import {
  describeEvent,
  playersById,
  roundCount,
  roundName,
  type LiveState,
  type Match,
} from "./model";

interface DashboardProps {
  live: LiveState;
  eyebrow: string;
  onPickTournament(id: string): void;
  actions?: ScoreActions;
  onOpenMatch?: (match: Match) => void;
  headerActions?: ReactNode;
  empty: ReactNode;
}

export function Dashboard({
  live,
  eyebrow,
  onPickTournament,
  actions,
  onOpenMatch,
  headerActions,
  empty,
}: DashboardProps) {
  const [view, setView] = useState(actions ? "courts" : "bracket");
  const snapshot = live.data;
  const people = useMemo(
    () => (snapshot?.tournament ? playersById(snapshot) : new Map()),
    [snapshot],
  );

  if (!snapshot) {
    return live.error ? (
      <Callout
        tone="danger"
        title="Couldn't load the tournament"
        action={<Button onClick={live.reload}>Try again</Button>}
      >
        {live.error.message}
      </Callout>
    ) : (
      <Stack gap={12}>
        <Skeleton height={44} width="40%" />
        <Grid cols={4}>
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} height={88} />
          ))}
        </Grid>
        <Skeleton height={420} />
      </Stack>
    );
  }

  const tournament = snapshot.tournament;
  if (!tournament) return <>{empty}</>;

  const rounds = roundCount(snapshot);
  const remaining = snapshot.standings.filter((row) => row.eliminatedRound === null).length;
  const liveMatches = snapshot.matches.filter((match) => match.status === "live");
  const played = snapshot.matches.filter((match) => match.status === "done").length;
  const playable = snapshot.matches.filter((match) => match.status !== "bye").length;
  const currentRound =
    snapshot.matches.find((match) => match.status !== "done" && match.status !== "bye")?.round ??
    rounds;
  const hot = [...snapshot.standings].sort((a, b) => b.ratingChange - a.ratingChange)[0];

  return (
    <Stack gap={18}>
      <PageHeader
        eyebrow={eyebrow}
        title={tournament.name}
        subtitle={`${tournament.sport} · ${snapshot.standings.length} players · first to ${tournament.pointsToWin}, win by ${tournament.winBy}`}
        actions={
          <div className="co-header-actions">
            {snapshot.tournaments.length > 1 ? (
              <>
                <label className="kit-sr-only" htmlFor="co-pick">
                  Tournament
                </label>
                <Select
                  id="co-pick"
                  value={tournament.id}
                  onChange={(event) => onPickTournament(event.target.value)}
                >
                  {snapshot.tournaments.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                      {entry.status === "finished" ? " (finished)" : ""}
                    </option>
                  ))}
                </Select>
              </>
            ) : null}
            {headerActions}
          </div>
        }
      />
      {live.error ? (
        <Callout
          tone="warning"
          title="Scores may be out of date"
          action={<Button onClick={live.reload}>Try again</Button>}
        >
          {live.error.message}
        </Callout>
      ) : null}
      <Grid cols={4}>
        <StatCard
          label={tournament.status === "finished" ? "Champion" : "Stage"}
          value={
            tournament.championId
              ? (people.get(tournament.championId)?.name ?? "—")
              : roundName(currentRound, rounds)
          }
          hint={`${played} of ${playable} matches played`}
        />
        <StatCard
          label="On court"
          value={liveMatches.length}
          hint={`${snapshot.courts.length - liveMatches.length} of ${snapshot.courts.length} courts free`}
          tone={liveMatches.length > 0 ? "success" : "neutral"}
          delta={liveMatches.length > 0 ? "Live" : undefined}
        />
        <StatCard label="Players left" value={`${remaining} / ${snapshot.standings.length}`} hint={`${snapshot.rallies} rallies logged`} />
        <StatCard
          label="Biggest climber"
          value={hot && hot.ratingChange > 0 ? hot.name : "—"}
          delta={hot && hot.ratingChange > 0 ? `+${hot.ratingChange}` : undefined}
          tone="success"
          hint={hot && hot.ratingChange > 0 ? `Now rated ${hot.rating}` : "No rated results yet"}
        />
      </Grid>
      <Tabs
        label="Views"
        value={view}
        onChange={setView}
        items={[
          {
            id: "courts",
            label: actions ? "Scorekeeper" : "Courts",
            content: (
              <div className="co-split">
                <CourtBoard snapshot={snapshot} people={people} actions={actions} />
                <Card title="Latest" subtitle="Newest first">
                  {snapshot.recent.length === 0 ? (
                    <p className="co-muted">Nothing has happened yet.</p>
                  ) : (
                    <ol className="co-feed">
                      {snapshot.recent.map((event) => (
                        <li key={event.id} className={`co-feed-item co-feed-item--${event.kind}`}>
                          <span>{describeEvent(event, snapshot, people)}</span>
                          <time dateTime={new Date(event.at).toISOString()}>
                            {new Date(event.at).toLocaleTimeString([], {
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </time>
                        </li>
                      ))}
                    </ol>
                  )}
                </Card>
              </div>
            ),
          },
          {
            id: "bracket",
            label: "Bracket",
            content: (
              <Card title="Bracket" subtitle="Select or hover a player to trace their path">
                <Bracket snapshot={snapshot} onOpenMatch={onOpenMatch} />
              </Card>
            ),
          },
          { id: "standings", label: "Standings", content: <Standings snapshot={snapshot} /> },
          { id: "tv", label: "TV board", content: <TvBoard snapshot={snapshot} people={people} /> },
        ]}
      />
    </Stack>
  );
}
