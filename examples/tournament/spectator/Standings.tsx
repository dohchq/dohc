import { useMemo, useState } from "react";
import { ChevronDown } from "./Icons";
import { liveCourts, signed, stageLabel, type Snapshot, type Standing } from "./model";

type SortKey = "place" | "name" | "record" | "diff" | "rating" | "delta";

const COLUMNS: Array<{ key: SortKey; label: string; numeric: boolean; title?: string }> = [
  { key: "place", label: "#", numeric: true, title: "Place" },
  { key: "name", label: "Player", numeric: false },
  { key: "record", label: "W–L", numeric: true, title: "Wins and losses" },
  { key: "diff", label: "Diff", numeric: true, title: "Diff: points for minus points against" },
  { key: "rating", label: "Elo", numeric: true },
  { key: "delta", label: "±", numeric: true, title: "Elo change this event" },
];

const sortValue: Record<SortKey, (row: Standing) => number | string> = {
  place: (row) => row.place,
  name: (row) => row.name,
  record: (row) => row.wins * 100 - row.losses,
  diff: (row) => row.pointDiff,
  rating: (row) => row.rating,
  delta: (row) => row.ratingChange,
};

export function Standings({
  snapshot,
  onTrace,
}: {
  snapshot: Snapshot;
  onTrace(playerId: string): void;
}) {
  const tournament = snapshot.tournament!;
  const championId = tournament.championId;
  const double = tournament.format === "double";
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "place", dir: 1 });
  const rows = useMemo(() => {
    const rank = new Map(snapshot.standings.map((row, index) => [row.id, index]));
    const value = sortValue[sort.key];
    return [...snapshot.standings].sort((left, right) => {
      const a = value(left);
      const b = value(right);
      const order = typeof a === "string" ? a.localeCompare(String(b)) : a - Number(b);
      return order * sort.dir || rank.get(left.id)! - rank.get(right.id)!;
    });
  }, [snapshot.standings, sort]);
  const movers = useMemo(
    () =>
      [...snapshot.standings]
        .filter((row) => row.ratingChange !== 0)
        .sort((left, right) => right.ratingChange - left.ratingChange),
    [snapshot.standings],
  );
  const span = Math.max(1, ...movers.map((row) => Math.abs(row.ratingChange)));

  const placeOf = (row: Standing): [string, string | undefined] =>
    row.eliminatedRound === null && row.id !== championId
      ? ["–", "Still playing"]
      : row.tied
        ? [`T${row.place}`, `Tied for ${row.place}`]
        : [String(row.place), undefined];

  const onCourt = new Map(
    liveCourts(snapshot).flatMap(({ court, match }) => [
      [match.playerA, court.name],
      [match.playerB, court.name],
    ]),
  );
  const statusOf = (row: Standing): [string, string] =>
    row.id === championId
      ? ["Champion", " is-champ"]
      : onCourt.has(row.id)
        ? [`On ${onCourt.get(row.id)}`, " is-live"]
        : row.eliminatedRound !== null
          ? [`Out · ${stageLabel(tournament, row.eliminatedRound)}`, ""]
          : double && row.losses > 0
            ? ["Losers side", " is-drop"]
            : ["Active", " is-plain"];

  return (
    <div className="co-standings">
      <div className="co-table-wrap">
        <table className="co-table">
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={`${column.numeric ? "is-num" : ""} is-${column.key}`}
                  aria-sort={
                    sort.key === column.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"
                  }
                >
                  <button
                    type="button"
                    title={column.title}
                    aria-label={column.title}
                    onClick={() =>
                      setSort((current) =>
                        current.key === column.key
                          ? { key: column.key, dir: current.dir === 1 ? -1 : 1 }
                          : {
                              key: column.key,
                              dir: column.key === "place" || column.key === "name" ? 1 : -1,
                            },
                      )
                    }
                  >
                    {column.label}
                    <span
                      className={`co-sort${sort.key === column.key ? " is-on" : ""}${
                        sort.key === column.key && sort.dir === -1 ? " is-desc" : ""
                      }`}
                      aria-hidden="true"
                    >
                      <ChevronDown size={12} />
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={row.eliminatedRound === null ? "is-alive" : "is-out"}>
                <td className="is-num is-place" title={placeOf(row)[1]}>
                  <span aria-hidden={placeOf(row)[1] === "Still playing" || undefined}>
                    {placeOf(row)[0]}
                  </span>
                  {placeOf(row)[1] === "Still playing" ? (
                    <span className="co-sr">Still playing</span>
                  ) : null}
                </td>
                <td className="is-name">
                  <div className="co-name-cell">
                    <button
                      type="button"
                      className="co-player-link"
                      onClick={() => onTrace(row.id)}
                      title="Trace in bracket"
                    >
                      <span className="co-seed-box">{row.seed}</span>
                      <span className="co-player-text">
                        <strong>{row.name}</strong>
                        <small>
                          {row.club ?? "Independent"}
                          <span className={`co-status-inline${statusOf(row)[1]}`}>
                            {statusOf(row)[0]}
                          </span>
                        </small>
                      </span>
                    </button>
                    <span className={`co-status${statusOf(row)[1]}`}>{statusOf(row)[0]}</span>
                  </div>
                </td>
                <td className="is-num">
                  {row.wins}–{row.losses}
                </td>
                <td
                  className={`is-num ${row.pointDiff > 0 ? "co-up" : row.pointDiff < 0 ? "co-down" : ""}`}
                >
                  {signed(row.pointDiff)}
                </td>
                <td className="is-num is-rating">{row.rating}</td>
                <td
                  className={`is-num is-delta ${row.ratingChange > 0 ? "co-up" : row.ratingChange < 0 ? "co-down" : "co-flat"}`}
                >
                  {signed(row.ratingChange)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="co-movers" aria-label="Elo movers">
        <h2 className="co-rail-title">
          Elo movers <span className="co-num">K {tournament.kFactor}</span>
        </h2>
        {movers.length === 0 ? (
          <p className="co-rail-empty">No rated results yet</p>
        ) : (
          <ol className="co-mover-list">
            {movers.map((row) => {
              const width = (Math.abs(row.ratingChange) / span) * 50;
              const up = row.ratingChange > 0;
              return (
                <li key={row.id}>
                  <span className="co-mover-name">{row.name}</span>
                  <span className="co-mover-track" aria-hidden="true">
                    <span
                      className={`co-mover-bar ${up ? "is-up" : "is-down"}`}
                      style={
                        up
                          ? { left: "50%", width: `${width}%` }
                          : { right: "50%", width: `${width}%` }
                      }
                    />
                  </span>
                  <span className={`co-mover-value co-num ${up ? "co-up" : "co-down"}`}>
                    {signed(row.ratingChange)}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
