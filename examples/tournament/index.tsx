import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { PlusIcon, TrophyIcon } from "./spectator/Icons";
import { AppProvider, isAppBackendError, mutationKey, useApp } from "dohc/app";
import {
  AppShell,
  Badge,
  Button,
  Callout,
  EmptyState,
  Field,
  Grid,
  Input,
  Modal,
  Select,
  Stack,
  Textarea,
} from "dohc/ui";
import { Dashboard } from "./spectator/Dashboard";
import type { ScoreActions } from "./spectator/Courts";
import {
  isDecided,
  playersById,
  roundCount,
  roundName,
  useLiveSnapshot,
  type Court,
  type Match,
  type Side,
  type Snapshot,
} from "./spectator/model";
import "./spectator/tournament.css";

interface Notice {
  tone: "warning" | "danger";
  title: string;
  message: string;
}

interface LogEntry {
  seq: number;
  kind: string;
  side: Side | null;
  scoreA: number;
  scoreB: number;
  actor: string;
  at: number;
}

function Organizer() {
  const client = useApp();
  const [tournamentId, setTournamentId] = useState<string | null>(null);
  const live = useLiveSnapshot(client, tournamentId, 4000);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [creating, setCreating] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [opened, setOpened] = useState<Match | null>(null);
  const [completing, setCompleting] = useState<Match | null>(null);

  const report = useCallback((caught: unknown, fallback: string) => {
    if (isAppBackendError(caught) && caught.refusal?.code === "conflict")
      setNotice({ tone: "warning", title: "Someone else scored first", message: caught.message });
    else if (isAppBackendError(caught) && caught.status === 429)
      setNotice({
        tone: "warning",
        title: "Slow down a little",
        message: "dohc is pacing requests from this app. Wait a moment, then tap again.",
      });
    else
      setNotice({
        tone: "danger",
        title: fallback,
        message: caught instanceof Error ? caught.message : String(caught),
      });
  }, []);

  const pickTournament = useCallback((id: string) => {
    setTournamentId(id);
    setOpened(null);
    setCompleting(null);
    setNotice(null);
  }, []);

  const run = useCallback(
    async (match: Match, operation: string, input: Record<string, unknown>, refresh: boolean) => {
      const targetTournamentId = live.data?.tournament?.id ?? tournamentId;
      if (!targetTournamentId || !live.isCurrent(targetTournamentId)) return;
      setBusy((current) => new Set(current).add(match.id));
      live.hold();
      try {
        const reply = await client.invoke<Match | { match: Match }>(
          operation,
          { matchId: match.id, expectedVersion: match.version, ...input },
          mutationKey(operation),
        );
        if (!live.isCurrent(targetTournamentId)) return;
        live.hold();
        const saved = "match" in reply.result ? reply.result.match : reply.result;
        live.patchMatch(targetTournamentId, saved);
        setNotice(null);
        if (refresh) live.reload();
      } catch (caught) {
        if (!live.isCurrent(targetTournamentId)) return;
        report(caught, "That didn't save");
        live.reload();
      } finally {
        setBusy((current) => {
          const next = new Set(current);
          next.delete(match.id);
          return next;
        });
      }
    },
    [client, live, report, tournamentId],
  );

  const actions = useMemo<ScoreActions>(
    () => ({
      busy,
      disabled: live.switching,
      start: (match: Match, court: Court) =>
        void run(match, "startMatch", { courtId: court.id }, true),
      point: (match: Match, side: Side) => void run(match, "scorePoint", { side }, false),
      undo: (match: Match) => void run(match, "undoPoint", {}, false),
      complete: (match: Match) => setCompleting(match),
    }),
    [busy, live.switching, run],
  );

  const seedDemo = async () => {
    setSeeding(true);
    try {
      const reply = await client.invoke<{ tournamentId: string }>(
        "seedDemo",
        {},
        mutationKey("seedDemo"),
      );
      pickTournament(reply.result.tournamentId);
    } catch (caught) {
      report(caught, "Couldn't load the demo");
    } finally {
      setSeeding(false);
    }
  };

  const header = (
    <>
      <Button variant="secondary" onClick={seedDemo} loading={seeding}>
        <TrophyIcon /> Demo
      </Button>
      <Button variant="primary" onClick={() => setCreating(true)}>
        <PlusIcon /> New tournament
      </Button>
    </>
  );

  return (
    <AppShell width="wide">
      <Stack gap={14}>
        {notice ? (
          <Callout
            tone={notice.tone}
            title={notice.title}
            action={
              <Button size="sm" variant="ghost" onClick={() => setNotice(null)}>
                Dismiss
              </Button>
            }
          >
            {notice.message}
          </Callout>
        ) : null}
        <Dashboard
          live={live}
          eyebrow="CourtOps · Organizer"
          onPickTournament={pickTournament}
          actions={actions}
          onOpenMatch={setOpened}
          headerActions={header}
          empty={
            <EmptyState
              title="Run your first bracket"
              description="Create a tournament from your player list, or load a 16-player pickleball open that is already in the quarterfinals."
              action={
                <div className="co-header-actions">
                  <Button variant="primary" onClick={seedDemo} loading={seeding}>
                    <TrophyIcon /> Load the 16-player demo
                  </Button>
                  <Button onClick={() => setCreating(true)}>
                    <PlusIcon /> New tournament
                  </Button>
                </div>
              }
            />
          }
        />
      </Stack>
      <CreateTournament
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          pickTournament(id);
        }}
      />
      {opened &&
      live.data?.tournament &&
      live.data.matches.some((entry) => entry.id === opened.id) ? (
        <MatchDetail
          match={live.data.matches.find((entry) => entry.id === opened.id) ?? opened}
          snapshot={live.data}
          onClose={() => setOpened(null)}
        />
      ) : null}
      {completing && live.data?.tournament ? (
        <ConfirmComplete
          match={live.data.matches.find((entry) => entry.id === completing.id) ?? null}
          snapshot={live.data}
          disabled={live.switching || busy.has(completing.id)}
          onCancel={() => setCompleting(null)}
          onConfirm={(target) => {
            setCompleting(null);
            void run(target, "completeMatch", {}, true);
          }}
        />
      ) : null}
    </AppShell>
  );
}

function ConfirmComplete({
  match,
  snapshot,
  disabled,
  onCancel,
  onConfirm,
}: {
  match: Match | null;
  snapshot: Snapshot;
  disabled: boolean;
  onCancel(): void;
  onConfirm(match: Match): void;
}) {
  const people = useMemo(() => playersById(snapshot), [snapshot]);
  const tournament = snapshot.tournament;
  if (!match || !tournament || match.status !== "live") return null;
  const decided = isDecided(tournament, match.scoreA, match.scoreB);
  const aWon = match.scoreA > match.scoreB;
  const winner = people.get((aWon ? match.playerA : match.playerB) ?? "")?.name ?? "Winner";
  const loser = people.get((aWon ? match.playerB : match.playerA) ?? "")?.name ?? "Opponent";
  const high = Math.max(match.scoreA, match.scoreB);
  const low = Math.min(match.scoreA, match.scoreB);
  return (
    <Modal
      open
      title="Complete match?"
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button
            variant="primary"
            disabled={disabled || !decided}
            onClick={() => onConfirm(match)}
          >
            Complete match
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <p className="co-muted">
          {decided
            ? `${winner} wins ${high}–${low} over ${loser}.`
            : `The score is now ${match.scoreA}–${match.scoreB} and is no longer decided.`}
        </p>
        <Callout tone="warning" title="This can't be undone">
          Completing this match updates Elo ratings, frees the court, and advances the winner into
          the next round.
        </Callout>
      </Stack>
    </Modal>
  );
}

function MatchDetail({
  match,
  snapshot,
  onClose,
}: {
  match: Match;
  snapshot: Snapshot;
  onClose(): void;
}) {
  const client = useApp();
  const [log, setLog] = useState<LogEntry[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const people = useMemo(() => playersById(snapshot), [snapshot]);
  const rounds = roundCount(snapshot);
  const name = (id: string | null) => (id ? (people.get(id)?.name ?? "Unknown") : "To be decided");

  useEffect(() => {
    let active = true;
    client.read<LogEntry[]>("matchLog", { matchId: match.id }).then(
      (rows) => {
        if (active) setLog(rows);
      },
      (caught: unknown) => {
        if (active) setFailed(caught instanceof Error ? caught.message : String(caught));
      },
    );
    return () => {
      active = false;
    };
  }, [client, match.id, match.version]);

  return (
    <Modal
      open
      title={`${roundName(match.round, rounds)} · Match ${match.slot}`}
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <Stack gap={14}>
        <div className="co-detail-score">
          <span>{name(match.playerA)}</span>
          <strong>
            {match.scoreA}–{match.scoreB}
          </strong>
          <span>{name(match.playerB)}</span>
        </div>
        <p className="co-muted">
          <Badge tone={match.status === "live" ? "success" : "neutral"}>{match.status}</Badge>{" "}
          Version {match.version}
          {match.courtId
            ? ` · ${snapshot.courts.find((court) => court.id === match.courtId)?.name ?? ""}`
            : ""}
        </p>
        {failed ? (
          <Callout tone="danger" title="Couldn't load the point log">
            {failed}
          </Callout>
        ) : !log ? (
          <p className="co-muted">Loading the point log…</p>
        ) : log.length === 0 ? (
          <p className="co-muted">No points yet.</p>
        ) : (
          <ol className="co-log">
            {log.map((entry) => (
              <li key={entry.seq}>
                <span className="co-num">#{entry.seq}</span>
                <span>
                  {entry.kind === "point"
                    ? `Point ${name(entry.side === "a" ? match.playerA : match.playerB)}`
                    : entry.kind === "undo"
                      ? `Undo ${name(entry.side === "a" ? match.playerA : match.playerB)}`
                      : entry.kind === "complete"
                        ? `${name(entry.side === "a" ? match.playerA : match.playerB)} won`
                        : entry.kind === "start"
                          ? "Started"
                          : "Bye"}
                </span>
                <span className="co-num">
                  {entry.scoreA}–{entry.scoreB}
                </span>
                <span className="co-muted">{entry.actor}</span>
              </li>
            ))}
          </ol>
        )}
      </Stack>
    </Modal>
  );
}

const SAMPLE_PLAYERS = `Rhea Okafor, Mission Paddle, 1610
Tomas Lindqvist, Northside, 1580
Priya Raman, Mission Paddle, 1540
Diego Salas, Harbor PC, 1500
June Park, Northside, 1470
Owen Mbeki, Harbor PC, 1440`;

function CreateTournament({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose(): void;
  onCreated(id: string): void;
}) {
  const client = useApp();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const players = String(form.get("players") ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name = "", club = "", rating = ""] = line.split(",").map((part) => part.trim());
        return { name, club: club || undefined, rating: rating ? Number(rating) : undefined };
      });
    setPending(true);
    setError(null);
    try {
      const reply = await client.invoke<{ tournamentId: string }>(
        "createTournament",
        {
          name: form.get("name"),
          sport: form.get("sport"),
          pointsToWin: Number(form.get("pointsToWin")),
          winBy: Number(form.get("winBy")),
          courts: Number(form.get("courts")),
          players,
        },
        mutationKey("createTournament"),
      );
      onCreated(reply.result.tournamentId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal open={open} title="New tournament" onClose={onClose}>
      <form onSubmit={submit}>
        <fieldset disabled={pending} className="co-form">
          <Field label="Name" htmlFor="co-name">
            <Input id="co-name" name="name" required maxLength={80} placeholder="Thursday Ladder" />
          </Field>
          <Grid cols={2}>
            <Field label="Sport" htmlFor="co-sport">
              <Select id="co-sport" name="sport" defaultValue="Pickleball">
                <option>Pickleball</option>
                <option>Esports</option>
                <option>Tabletop</option>
              </Select>
            </Field>
            <Field label="Courts" htmlFor="co-courts">
              <Input id="co-courts" name="courts" type="number" min={1} max={16} defaultValue={4} />
            </Field>
            <Field label="Points to win" htmlFor="co-points">
              <Input id="co-points" name="pointsToWin" type="number" min={1} max={99} defaultValue={11} />
            </Field>
            <Field label="Win by" htmlFor="co-winby">
              <Input id="co-winby" name="winBy" type="number" min={1} max={5} defaultValue={2} />
            </Field>
          </Grid>
          <Field
            label="Players"
            htmlFor="co-players"
            hint="One per line: name, club, rating. Club and rating are optional. Top seeds get byes."
          >
            <Textarea id="co-players" name="players" rows={8} required defaultValue={SAMPLE_PLAYERS} />
          </Field>
          {error ? (
            <Callout tone="danger" title="Couldn't create the tournament">
              {error}
            </Callout>
          ) : null}
          <div className="co-form-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={pending}>
              Create bracket
            </Button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}

const mount = document.getElementById("root");
if (mount) {
  createRoot(mount).render(
    <AppProvider>
      <Organizer />
    </AppProvider>,
  );
}
