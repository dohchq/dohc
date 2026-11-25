import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useApp } from "dohc/app";
import { Dashboard } from "./Dashboard";
import { Trophy } from "./Icons";
import type { Timeline, TimelineEntry } from "./Inspector";
import { useLiveSnapshot, type Match, type Snapshot } from "./model";
import "./tournament.css";

function Spectator() {
  const client = useApp();
  const [tournamentId, setTournamentId] = useState<string | null>(null);
  const live = useLiveSnapshot(client, tournamentId, 5000, "public");
  const current = live.data?.tournament?.id ?? tournamentId;
  const loadTimeline = useCallback(
    async (match: Match) => {
      const reply = await client.read<
        Snapshot & { timeline?: TimelineEntry[]; timelineCut?: boolean }
      >("liveSnapshot", {
        tournamentId: current,
        matchId: match.id,
        view: "public",
      });
      return { entries: reply.timeline ?? [], cut: reply.timelineCut ?? false } satisfies Timeline;
    },
    [client, current],
  );
  return (
    <Dashboard
      live={live}
      role="spectator"
      onPickTournament={setTournamentId}
      loadTimeline={loadTimeline}
      empty={
        <div className="co-empty">
          <span className="co-empty-mark" aria-hidden="true">
            <Trophy size={22} />
          </span>
          <strong>No tournament yet</strong>
          <span>This page fills in when the organizer starts one.</span>
        </div>
      }
    />
  );
}

const mount = document.getElementById("root");
if (mount) {
  createRoot(mount).render(
    <AppProvider>
      <Spectator />
    </AppProvider>,
  );
}
