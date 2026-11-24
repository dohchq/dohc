import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useApp } from "dohc/app";
import { AppShell, EmptyState } from "dohc/ui";
import { Dashboard } from "./Dashboard";
import { useLiveSnapshot } from "./model";
import "./tournament.css";

function Spectator() {
  const client = useApp();
  const [tournamentId, setTournamentId] = useState<string | null>(null);
  const live = useLiveSnapshot(client, tournamentId, 5000);
  return (
    <AppShell width="wide">
      <Dashboard
        live={live}
        eyebrow="Live results"
        onPickTournament={setTournamentId}
        empty={
          <EmptyState
            title="Nothing to watch yet"
            description="The organizer hasn't started a tournament. This page fills in on its own when they do."
          />
        }
      />
    </AppShell>
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
