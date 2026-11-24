import { useMemo } from "react";
import { Badge, Card, DataTable, type DataTableColumn } from "dohc/ui";
import { BarChart } from "dohc/charts";
import { roundCount, roundName, type Snapshot, type Standing } from "./model";

function signed(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

export function Standings({ snapshot }: { snapshot: Snapshot }) {
  const rounds = roundCount(snapshot);
  const championId = snapshot.tournament?.championId ?? null;
  const columns = useMemo<DataTableColumn<Standing>[]>(
    () => [
      {
        key: "place",
        header: "#",
        align: "right",
        render: (row) => row.place,
        sortValue: (row) => row.place,
      },
      {
        key: "name",
        header: "Player",
        render: (row) => (
          <span className="co-standing-name">
            <strong>{row.name}</strong>
            <small>
              Seed {row.seed}
              {row.club ? ` · ${row.club}` : ""}
            </small>
          </span>
        ),
        sortValue: (row) => row.name,
      },
      {
        key: "status",
        header: "Status",
        render: (row) =>
          row.id === championId ? (
            <Badge tone="success">Champion</Badge>
          ) : row.eliminatedRound !== null ? (
            <Badge>Out in {roundName(row.eliminatedRound, rounds)}</Badge>
          ) : (
            <Badge tone="warning">Still in</Badge>
          ),
        sortValue: (row) => (row.id === championId ? 99 : (row.eliminatedRound ?? 50)),
      },
      {
        key: "record",
        header: "W–L",
        align: "right",
        render: (row) => `${row.wins}–${row.losses}`,
        sortValue: (row) => row.wins - row.losses,
      },
      {
        key: "points",
        header: "Points",
        align: "right",
        render: (row) => (
          <span className="co-num">
            {row.pointsFor}–{row.pointsAgainst}{" "}
            <small className={row.pointDiff >= 0 ? "co-up" : "co-down"}>{signed(row.pointDiff)}</small>
          </span>
        ),
        sortValue: (row) => row.pointDiff,
      },
      {
        key: "rating",
        header: "Rating",
        align: "right",
        render: (row) => (
          <span className="co-num">
            {row.rating}{" "}
            <small className={row.ratingChange >= 0 ? "co-up" : "co-down"}>
              {signed(row.ratingChange)}
            </small>
          </span>
        ),
        sortValue: (row) => row.rating,
      },
    ],
    [championId, rounds],
  );
  const movers = useMemo(
    () =>
      [...snapshot.standings]
        .filter((row) => row.ratingChange !== 0)
        .sort((left, right) => right.ratingChange - left.ratingChange)
        .map((row) => ({
          label: row.name,
          value: row.ratingChange,
          color: row.ratingChange >= 0 ? "var(--kit-success)" : "var(--kit-danger)",
        })),
    [snapshot.standings],
  );
  return (
    <div className="co-standings">
      <Card title="Leaderboard" subtitle="Ranked by how far each player got, then point difference">
        <DataTable
          rows={snapshot.standings}
          columns={columns}
          rowKey={(row) => row.id}
          searchable
          searchPlaceholder="Find a player"
          searchText={(row) => `${row.name} ${row.club ?? ""}`}
          emptyTitle="No players yet"
        />
      </Card>
      <Card title="Rating movers" subtitle={`Elo change this event, K = ${snapshot.tournament?.kFactor ?? 32}`}>
        <BarChart
          data={movers}
          orientation="horizontal"
          height={Math.max(160, movers.length * 26)}
          formatValue={signed}
          ariaLabel="Elo rating change per player"
        />
      </Card>
    </div>
  );
}
