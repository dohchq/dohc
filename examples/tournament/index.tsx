import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, isAppBackendError, mutationKey, useApp } from "dohc/app";
import { Dashboard } from "./spectator/Dashboard";
import type { ScoreActions } from "./spectator/Courts";
import { ChevronDown, ChevronUp, Copy, Plus, RefreshCw, Trophy, Undo2, X } from "./spectator/Icons";
import type { TimelineEntry } from "./spectator/Inspector";
import {
  HISTORY_LIMIT,
  gameScores,
  matchRound,
  signed,
  trapFocus,
  useLiveSnapshot,
  type Court,
  type Match,
  type Side,
  type Tournament,
  type Visibility,
} from "./spectator/model";
import "./spectator/tournament.css";

interface Completed {
  match: Match;
  matchOver?: boolean;
  gameWinnerId?: string;
  winnerId?: string;
  loserId?: string;
  ratingChange?: number;
  advancedTo?: string | null;
  droppedTo?: string | null;
  championId?: string | null;
  loserOut?: boolean;
}

interface Toast {
  id: number;
  tone: "done" | "warning" | "danger";
  matchId?: string;
  tournamentId?: string;
  sticky?: boolean;
  title: string;
  message: string;
  action?: { label: string; undo?: boolean; run(): void };
}

const LABELS: Record<string, string> = {
  startMatch: "start the match",
  returnToQueue: "return the match to the queue",
  scorePoint: "save the point",
  undoPoint: "undo the point",
  completeMatch: "record the game",
  awardWalkover: "record the walkover",
  reportResult: "record the result",
  reopenMatch: "reopen the match",
  setVisibility: "change who can follow it",
};

function describeActor(actor: string): string {
  if (actor === "owner") return "Organizer";
  if (actor.startsWith("named:")) return `Scorekeeper ${actor.slice(-4).toUpperCase()}`;
  if (actor.startsWith("automation:")) return "Automation";
  return "Link viewer";
}

function Organizer() {
  const client = useApp();
  const [tournamentId, setTournamentId] = useState<string | null>(null);
  const live = useLiveSnapshot(client, tournamentId, 4000, "desk");
  const { isCurrent, patchMatch, reload } = live;
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [stale, setStale] = useState<ReadonlyMap<string, number>>(new Map());
  const [taps, setTaps] = useState<ReadonlyMap<string, readonly Side[]>>(new Map());
  const [sending, setSending] = useState<ReadonlyMap<string, number>>(new Map());
  const tapsRef = useRef(new Map<string, readonly Side[]>());
  const draining = useRef(new Set<string>());
  const drained = useRef(new Map<string, Match>());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [setupOpen, setSetupOpen] = useState(false);
  const [reopenRequest, setReopenRequest] = useState<{ matchId: string; seq: number } | null>(null);
  const [seeding, setSeeding] = useState(false);
  const toastId = useRef(0);
  const timers = useRef(new Map<number, number>());
  const shownId = live.data?.tournament?.id;
  const shownRef = useRef(shownId);
  shownRef.current = shownId;

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) window.clearTimeout(timer);
      active.clear();
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const arm = useCallback(
    (toast: Pick<Toast, "id" | "action">) => {
      window.clearTimeout(timers.current.get(toast.id));
      timers.current.set(
        toast.id,
        window.setTimeout(() => dismiss(toast.id), toast.action ? 10000 : 6000),
      );
    },
    [dismiss],
  );
  const hold = (id: number) => {
    if (!timers.current.has(id)) return;
    window.clearTimeout(timers.current.get(id));
    timers.current.set(id, 0);
  };
  const resume = (toast: Toast, box: HTMLElement) => {
    if (!timers.current.has(toast.id)) return;
    if (box.matches(":hover") || box.contains(document.activeElement)) return;
    arm(toast);
  };
  const push = useCallback(
    (toast: Omit<Toast, "id">) => {
      const id = ++toastId.current;
      setToasts((current) => [
        ...current.filter((shown) => toast.tone !== "done" || shown.tone !== "done").slice(-4),
        { ...toast, id, tournamentId: toast.tournamentId ?? shownRef.current },
      ]);
      if (toast.tone !== "danger" && !toast.sticky) arm({ id, action: toast.action });
    },
    [arm],
  );

  const dropDone = useCallback(
    () => setToasts((current) => current.filter((toast) => toast.tone !== "done")),
    [],
  );

  const pickTournament = useCallback((id: string) => {
    setTournamentId(id);
    setToasts((current) => current.filter((toast) => toast.sticky));
  }, []);

  const setTapList = useCallback((matchId: string, list: readonly Side[]) => {
    const next = new Map(tapsRef.current);
    if (list.length > 0) next.set(matchId, list);
    else next.delete(matchId);
    tapsRef.current = next;
    setTaps(next);
  }, []);

  const run = useCallback(
    async (
      match: Match,
      operation: string,
      input: Record<string, unknown>,
      key: string,
      owner?: string,
    ): Promise<Match | null> => {
      const target = owner ?? shownId ?? tournamentId;
      if (!target || (!owner && !isCurrent(target))) return null;
      const point = operation === "scorePoint";
      const hold = !point || !draining.current.has(match.id);
      if (hold) setPending((current) => new Set(current).add(match.id));
      try {
        const reply = await client.invoke<Match | Completed>(
          operation,
          { matchId: match.id, expectedVersion: match.version, ...input },
          key,
        );
        const saved = "match" in reply.result ? reply.result.match : reply.result;
        if (point && draining.current.has(match.id)) {
          setTapList(match.id, (tapsRef.current.get(match.id) ?? []).slice(1));
          setSending((sent) => new Map(sent).set(match.id, saved.version));
        }
        if (!isCurrent(target)) return owner ? saved : null;
        patchMatch(target, saved);
        setStale((current) => {
          if (!current.has(match.id)) return current;
          const next = new Map(current);
          next.delete(match.id);
          return next;
        });
        setToasts((current) => current.filter((toast) => toast.matchId !== match.id));
        if (operation === "completeMatch" || operation === "awardWalkover" || operation === "reportResult")
          announceRef.current(reply.result as Completed);
        if (!point && operation !== "undoPoint") void reload();
        return saved;
      } catch (caught) {
        const away = !isCurrent(target);
        const unsent = point ? Math.max(0, (tapsRef.current.get(match.id)?.length ?? 1) - 1) : 0;
        const dropped =
          unsent > 0 ? ` ${unsent} more ${unsent === 1 ? "tap was" : "taps were"} not sent.` : "";
        const where = { matchId: match.id, tournamentId: target, sticky: away || unsent > 0 };
        const tapping = point || operation === "undoPoint" || operation === "completeMatch";
        if (isAppBackendError(caught) && caught.refusal?.code === "conflict")
          push({
            tone: "warning",
            ...where,
            title: tapping ? "Score already changed" : "Match already changed",
            message: `${caught.message}${dropped} ${tapping ? "Check the board, then tap again." : "Check the match, then try again."}`,
          });
        else if (isAppBackendError(caught) && caught.refusal)
          push({
            tone: "warning",
            ...where,
            title: `Could not ${LABELS[operation]}`,
            message: `${caught.message}${dropped}`,
          });
        else
          push({
            tone: "danger",
            ...where,
            title: `Could not ${LABELS[operation]}`,
            message:
              isAppBackendError(caught) && caught.status === 429
                ? `dohc is pacing taps from this app. Wait a moment.${dropped}`
                : `${caught instanceof Error ? caught.message : String(caught)}${dropped}`,
            action:
              away || point || operation === "reportResult"
                ? undefined
              : {
                  label: "Try again",
                  run: () => void runRef.current(match, operation, input, key),
                },
          });
        if (!away) {
          const failedAt = Date.now();
          if (point) setTapList(match.id, []);
          setStale((current) => new Map(current).set(match.id, failedAt));
        }
        if (!away && !(await reload()))
          push({
            tone: "danger",
            matchId: match.id,
            tournamentId: target,
            title: "Could not load the latest score",
            message: "The board may be out of date. Load it again before scoring.",
            action: { label: "Try again", run: () => void reload() },
          });
        return null;
      } finally {
        if (hold)
          setPending((current) => {
            const next = new Set(current);
            next.delete(match.id);
            return next;
          });
      }
    },
    [client, isCurrent, patchMatch, reload, push, setTapList, shownId, tournamentId],
  );
  const runRef = useRef(run);
  runRef.current = run;

  const drain = useCallback(
    async (match: Match, owner: string) => {
      if (draining.current.has(match.id)) return;
      draining.current.add(match.id);
      const known = drained.current.get(match.id);
      let current = known && known.version > match.version ? known : match;
      try {
        while ((tapsRef.current.get(match.id) ?? []).length > 0) {
          const [side] = tapsRef.current.get(match.id)!;
          const from = current.version;
          setSending((sent) => new Map(sent).set(match.id, from));
          const saved = await runRef.current(
            current,
            "scorePoint",
            { side },
            mutationKey("scorePoint"),
            owner,
          );
          if (!saved) {
            setTapList(match.id, []);
            break;
          }
          current = saved;
          drained.current.set(match.id, saved);
        }
      } finally {
        draining.current.delete(match.id);
        setSending((sent) => {
          const next = new Map(sent);
          next.delete(match.id);
          return next;
        });
      }
    },
    [setTapList],
  );

  const announce = (result: Completed) => {
    const snapshot = live.data;
    const tournament = snapshot?.tournament;
    if (!snapshot || !tournament) return;
    const nameOf = (id: string | null | undefined) =>
      snapshot.standings.find((row) => row.id === id)?.name ?? "A player";
    const { match } = result;
    const last = gameScores(match).at(-1);
    const score = last ? `${Math.max(...last)}–${Math.min(...last)}` : "";
    const games = `${Math.max(match.gamesA, match.gamesB)}–${Math.min(match.gamesA, match.gamesB)}`;
    if (result.matchOver === false) {
      const aWon = result.gameWinnerId === match.playerA;
      const mine = aWon ? match.gamesA : match.gamesB;
      const theirs = aWon ? match.gamesB : match.gamesA;
      const standing = mine === theirs ? "Level" : mine > theirs ? "Leads" : "Trails";
      push({
        tone: "done",
        matchId: match.id,
        title: `${nameOf(result.gameWinnerId)} takes game ${match.gamesA + match.gamesB}`,
        message: `${score} · ${standing} ${mine}–${theirs} in games`,
        action: {
          label: "Undo",
          undo: true,
          run: () => void runRef.current(match, "undoPoint", {}, mutationKey("undoPoint")),
        },
      });
      return;
    }
    const find = (id: string | null | undefined) =>
      id ? snapshot.matches.find((entry) => entry.id === id) : undefined;
    const advanced = find(result.advancedTo);
    const dropped = find(result.droppedTo);
    const walkover = match.outcome === "walkover";
    const parts = [
      walkover
        ? "Walkover, no Elo change"
        : `${tournament.bestOf > 1 ? games : score} · Elo ${signed(result.ratingChange ?? 0)}`,
      advanced
        ? advanced.bracket === "final" && advanced.round === 2
          ? "Forces a reset"
          : `Advances to ${matchRound(tournament, advanced, "short")}`
        : "",
      dropped ? `${nameOf(result.loserId)} drops to ${matchRound(tournament, dropped, "short")}` : "",
      result.loserOut && !result.championId ? `${nameOf(result.loserId)} is out` : "",
    ].filter(Boolean);
    push({
      tone: "done",
      matchId: match.id,
      title: result.championId
        ? `${nameOf(result.winnerId)} wins ${tournament.name}`
        : `${nameOf(result.winnerId)} wins M${match.number}`,
      message: parts.join("\n"),
      action: {
        label: "Reopen",
        undo: true,
        run: () => setReopenRequest({ matchId: match.id, seq: Date.now() }),
      },
    });
  };
  const announceRef = useRef(announce);
  announceRef.current = announce;

  useEffect(
    () =>
      setStale((current) => {
        const synced = live.syncedAt ?? 0;
        const next = new Map([...current].filter(([, failedAt]) => failedAt > synced));
        return next.size === current.size ? current : next;
      }),
    [live.syncedAt],
  );

  const owner = live.data?.tournament?.id;
  const actions = useMemo<ScoreActions>(
    () => ({
      pending: stale.size > 0 ? new Set([...pending, ...stale.keys()]) : pending,
      taps,
      sending,
      disabled: live.switching,
      start: (match: Match, court: Court) =>
        void run(match, "startMatch", { courtId: court.id }, mutationKey("startMatch")),
      point: (match: Match, side: Side) => {
        if (!owner) return;
        setTapList(match.id, [...(tapsRef.current.get(match.id) ?? []), side]);
        void drain(match, owner);
      },
      undo: (match: Match) => void run(match, "undoPoint", {}, mutationKey("undoPoint")),
      complete: (match: Match) =>
        void run(match, "completeMatch", {}, mutationKey("completeMatch")),
      walkover: (match: Match, winner: Side) =>
        void run(match, "awardWalkover", { winner }, mutationKey("awardWalkover")),
      report: async (match: Match, games: Array<[number, number]>) =>
        (await run(match, "reportResult", { games }, mutationKey("reportResult"))) !== null,
      reopen: (match: Match) => void run(match, "reopenMatch", {}, mutationKey("reopenMatch")),
      returnToQueue: (match: Match) =>
        void run(match, "returnToQueue", {}, mutationKey("returnToQueue")),
    }),
    [pending, stale, taps, sending, live.switching, owner, run, drain, setTapList],
  );

  const setVisibility = async (tournament: Tournament, visibility: Visibility) => {
    try {
      await client.invoke(
        "setVisibility",
        { tournamentId: tournament.id, visibility },
        mutationKey("setVisibility"),
      );
      push({
        tone: "done",
        tournamentId: tournament.id,
        title: visibility === "shared" ? "Shown on the share link" : "Hidden from the share link",
        message:
          visibility === "shared"
            ? `Anyone with the spectator link can follow ${tournament.name}.`
            : `Spectators no longer see ${tournament.name}.`,
      });
    } catch (caught) {
      push({
        tone: "danger",
        tournamentId: tournament.id,
        title: `Could not ${LABELS.setVisibility}`,
        message: `${caught instanceof Error ? caught.message : String(caught)} Check the share link setting, then change it again.`,
      });
    } finally {
      void reload();
    }
  };

  const loadTimeline = useCallback(
    async (match: Match) => {
      const entries = await client.read<TimelineEntry[]>("matchLog", { matchId: match.id });
      return { entries, cut: entries.length >= HISTORY_LIMIT };
    },
    [client],
  );

  const seedDemo = async (key = mutationKey("seedDemo")) => {
    setSeeding(true);
    try {
      const reply = await client.invoke<{ tournamentId: string }>("seedDemo", {}, key);
      setSetupOpen(false);
      pickTournament(reply.result.tournamentId);
    } catch (caught) {
      push({
        tone: "danger",
        title: "Could not load the demo",
        message: caught instanceof Error ? caught.message : String(caught),
        action: { label: "Try again", run: () => void seedDemo(key) },
      });
    } finally {
      setSeeding(false);
    }
  };

  return (
    <>
      <Dashboard
        live={live}
        role="organizer"
        onPickTournament={pickTournament}
        actions={actions}
        loadTimeline={loadTimeline}
        describeActor={describeActor}
        covered={setupOpen}
        onSetVisibility={setVisibility}
        reopenRequest={reopenRequest}
        onViewChange={dropDone}
        barEnd={
          <button
            type="button"
            className="co-btn is-primary"
            aria-label="New tournament"
            onClick={() => setSetupOpen(true)}
          >
            <Plus size={14} aria-hidden="true" />
            <span className="co-hide-sm">New tournament</span>
          </button>
        }
        empty={
          <div className="co-empty">
            <span className="co-empty-mark" aria-hidden="true">
              <Trophy size={22} />
            </span>
            <strong>No tournament yet</strong>
            <span>Seed a bracket from your player list, or load the demo: a 16-player double elimination open, best of 3, with two matches live.</span>
            <div className="co-empty-actions">
              <button type="button" className="co-btn is-primary" onClick={() => setSetupOpen(true)}>
                <Plus size={14} />
                New tournament
              </button>
              <button type="button" className="co-btn" onClick={() => void seedDemo()} disabled={seeding}>
                {seeding ? "Loading demo…" : "Load the 16-player demo"}
              </button>
            </div>
          </div>
        }
      />
      {setupOpen ? (
        <SetupDrawer
          onClose={() => setSetupOpen(false)}
          onDemo={() => void seedDemo()}
          seeding={seeding}
          onCreated={(id) => {
            setSetupOpen(false);
            pickTournament(id);
          }}
        />
      ) : null}
      <div className="co-toasts" aria-live="polite">
        {toasts
          .filter((toast) => !toast.tournamentId || toast.tournamentId === shownId)
          .map((toast) => (
            <div
              key={toast.id}
              className={`co-toast is-${toast.tone}`}
              role={toast.tone === "danger" ? "alert" : undefined}
              onPointerEnter={() => hold(toast.id)}
              onPointerLeave={(event) => resume(toast, event.currentTarget)}
              onFocus={() => hold(toast.id)}
              onBlur={(event) => {
                const box = event.currentTarget;
                window.requestAnimationFrame(() => resume(toast, box));
              }}
            >
              <div className="co-toast-text">
                <strong>{toast.title}</strong>
                {toast.message.split("\n").map((line, index) => (
                  <span key={index} className="co-toast-line">
                    {line}
                  </span>
                ))}
              </div>
              <div className="co-toast-actions">
                {toast.action ? (
                  <button
                    type="button"
                    className="co-btn is-quiet"
                    onClick={() => {
                      dismiss(toast.id);
                      toast.action?.run();
                    }}
                  >
                    {toast.action.undo ? <Undo2 size={13} /> : <RefreshCw size={13} />}
                    {toast.action.label}
                  </button>
                ) : null}
                {toast.tone !== "done" ? (
                  <button
                    type="button"
                    className="co-icon-btn"
                    aria-label="Copy the error"
                    title="Copy the error"
                    onClick={() =>
                      void navigator.clipboard
                        ?.writeText(`${toast.title}. ${toast.message}`)
                        .catch(() => undefined)
                    }
                  >
                    <Copy size={14} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="co-icon-btn"
                  aria-label="Dismiss"
                  onClick={() => dismiss(toast.id)}
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          ))}
      </div>
    </>
  );
}

interface Entry {
  key: number;
  name: string;
  club: string;
  rating: string;
}

let entryKey = 0;

function parsePlayers(text: string): { entries: Entry[]; problem: string | null } {
  const entries: Entry[] = [];
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const [name = "", club = "", rating = ""] = line.split(",").map((part) => part.trim());
    if (!name) return { entries, problem: `Line ${index + 1} needs a name.` };
    entries.push({ key: ++entryKey, name, club, rating });
  }
  return { entries, problem: null };
}

const ratingOf = (entry: Entry) => Number(entry.rating) || 1500;
const badRating = (entry: Entry) => {
  const value = Number(entry.rating);
  return entry.rating.trim() !== "" && (!Number.isInteger(value) || value < 100 || value > 3500);
};

const byRating = (entries: Entry[]) =>
  [...entries].sort(
    (a, b) => ratingOf(b) - ratingOf(a) || a.name.localeCompare(b.name) || a.key - b.key,
  );

function rosterProblem(entries: Entry[]): string | null {
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const name = entry.name.trim();
    if (!name) return `Seed ${index + 1} needs a name.`;
    if (seen.has(name.toLowerCase())) return `${name} is listed twice.`;
    seen.add(name.toLowerCase());
    if (badRating(entry))
      return `${name}'s rating must be a whole number from 100 to 3500.`;
  }
  if (entries.length < 3 || entries.length > 32)
    return `A bracket needs 3 to 32 players. This list has ${entries.length}.`;
  return null;
}

function SetupDrawer({
  onClose,
  onCreated,
  onDemo,
  seeding,
}: {
  onClose(): void;
  onCreated(id: string): void;
  onDemo(): void;
  seeding: boolean;
}) {
  const client = useApp();
  const [pending, setPending] = useState(false);
  const busy = pending || seeding;
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [checked, setChecked] = useState(false);
  const [paste, setPaste] = useState("");
  const [pasteProblem, setPasteProblem] = useState<string | null>(null);
  const panel = useRef<HTMLFormElement | null>(null);
  const opener = useRef<Element | null>(document.activeElement);
  const problem = useMemo(() => rosterProblem(entries), [entries]);
  const sorted = useMemo(
    () => byRating(entries).every((entry, index) => entry === entries[index]),
    [entries],
  );
  const focusRow = (index: number, selector: string) =>
    window.requestAnimationFrame(() => {
      const found = [
        ...(panel.current?.querySelectorAll<HTMLElement>(`[data-seed="${index}"]${selector}`) ?? []),
        ...(panel.current?.querySelectorAll<HTMLElement>(`[data-seed="${index}"]`) ?? []),
      ];
      found.find((el) => !(el as HTMLButtonElement).disabled)?.focus();
    });
  const update = (key: number, patch: Partial<Entry>) =>
    setEntries((current) =>
      current.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)),
    );
  const move = (index: number, by: -1 | 1) => {
    setEntries((current) => {
      const next = [...current];
      const [entry] = next.splice(index, 1);
      next.splice(index + by, 0, entry!);
      return next;
    });
    focusRow(index + by, `[data-move="${by}"]`);
  };
  const remove = (index: number) => {
    setEntries((current) => current.filter((_, at) => at !== index));
    focusRow(Math.max(0, index - 1), "[data-field=name]");
  };
  const add = () => {
    setEntries((current) => [...current, { key: ++entryKey, name: "", club: "", rating: "" }]);
    focusRow(entries.length, "[data-field=name]");
  };
  const addPasted = () => {
    const pasted = parsePlayers(paste);
    setPasteProblem(pasted.problem);
    if (pasted.problem || pasted.entries.length === 0) return;
    setEntries((current) => [...current, ...pasted.entries]);
    setPaste("");
  };
  const [format, setFormat] = useState<"single" | "double">("double");
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const size = [4, 8, 16, 32].find((candidate) => candidate >= entries.length) ?? 32;
  const byes = Math.max(0, size - entries.length);
  const matchCount = format === "double" ? 2 * entries.length - 2 : entries.length - 1;

  useEffect(() => {
    panel.current?.querySelector<HTMLInputElement>("input[name=name]")?.focus();
    const back = opener.current;
    return () => {
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setChecked(true);
    if (problem) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const input = {
          name: form.get("name"),
          sport: form.get("sport"),
          format: form.get("format"),
          bestOf: Number(form.get("bestOf")),
          visibility: form.get("visibility") ? "shared" : "private",
          pointsToWin: Number(form.get("pointsToWin")),
          winBy: Number(form.get("winBy")),
          courts: Number(form.get("courts")),
          seeding: "order",
          players: entries.map((entry) => ({
            name: entry.name.trim(),
            club: entry.club.trim() || undefined,
            rating: ratingOf(entry),
          })),
      };
      const body = JSON.stringify(input);
      const key =
        attempt.current?.body === body ? attempt.current.key : mutationKey("createTournament");
      attempt.current = { body, key };
      const reply = await client.invoke<{ tournamentId: string }>("createTournament", input, key);
      attempt.current = null;
      onCreated(reply.result.tournamentId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="co-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        ref={panel}
        className="co-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="co-setup-title"
        onSubmit={submit}
        onKeyDown={(event) => {
          trapFocus(event);
          if (event.key === "Escape" && !busy) {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="co-drawer-head">
          <h2 id="co-setup-title">New tournament</h2>
          <button type="button" className="co-icon-btn" onClick={onClose} disabled={busy} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <fieldset className="co-drawer-body" disabled={busy}>
          <label className="co-field">
            <span>Name</span>
            <input name="name" required maxLength={80} placeholder="Thursday Ladder" />
          </label>
          <div className="co-field-row is-two">
            <label className="co-field">
              <span>Format</span>
              <select
                name="format"
                value={format}
                onChange={(event) => setFormat(event.target.value as "single" | "double")}
              >
                <option value="double">Double elimination</option>
                <option value="single">Single elimination</option>
              </select>
            </label>
            <label className="co-field">
              <span>Match length</span>
              <select name="bestOf" defaultValue="1">
                <option value="1">One game</option>
                <option value="3">Best of 3 games</option>
                <option value="5">Best of 5 games</option>
              </select>
            </label>
          </div>
          <div className="co-field-row is-four">
            <label className="co-field">
              <span>Sport</span>
              <select name="sport" defaultValue="Pickleball">
                <option>Pickleball</option>
                <option>Esports</option>
                <option>Tabletop</option>
              </select>
            </label>
            <label className="co-field">
              <span>Courts</span>
              <input name="courts" type="number" min={1} max={16} defaultValue={4} />
            </label>
            <label className="co-field">
              <span>Points to win</span>
              <input name="pointsToWin" type="number" min={1} max={99} defaultValue={11} />
            </label>
            <label className="co-field">
              <span>Win by</span>
              <input name="winBy" type="number" min={1} max={5} defaultValue={2} />
            </label>
          </div>
          <label className="co-check">
            <input type="checkbox" name="visibility" defaultChecked />
            <span>
              Show on the spectator link
              <small>Turn off for a private or practice event. You can change this later.</small>
            </span>
          </label>
          <section className="co-seeding" aria-labelledby="co-roster-title">
            <h3 className="co-rail-title" id="co-roster-title">
              Players and seeds
              <span className="co-num">
                {entries.length < 3
                  ? `${entries.length} of at least 3`
                  : `${size}-player bracket · ${
                      format === "double" ? `${matchCount} or ${matchCount + 1}` : matchCount
                    } matches${
                      byes > 0 ? ` · ${byes} ${byes === 1 ? "bye" : "byes"}` : ""
                    }`}
              </span>
            </h3>
            {entries.length === 0 ? (
              <p className="co-roster-empty">
                No players yet. Add them one at a time, or paste a list with one player per line.
              </p>
            ) : null}
            <ol className="co-roster">
              {entries.map((entry, index) => (
                <li key={entry.key}>
                  <span className="co-seed-box">{index + 1}</span>
                  <input
                    className="co-roster-name"
                    data-seed={index}
                    data-field="name"
                    value={entry.name}
                    placeholder="Name"
                    maxLength={60}
                    aria-label={`Seed ${index + 1} name`}
                    aria-invalid={checked && !entry.name.trim() ? true : undefined}
                    onChange={(event) => update(entry.key, { name: event.target.value })}
                  />
                  <input
                    className="co-roster-club"
                    value={entry.club}
                    placeholder="Club"
                    maxLength={60}
                    aria-label={`Seed ${index + 1} club`}
                    onChange={(event) => update(entry.key, { club: event.target.value })}
                  />
                  <input
                    className="co-roster-rating co-num"
                    value={entry.rating}
                    placeholder="1500"
                    inputMode="numeric"
                    maxLength={4}
                    aria-label={`Seed ${index + 1} rating`}
                    aria-invalid={checked && badRating(entry) ? true : undefined}
                    onChange={(event) => update(entry.key, { rating: event.target.value })}
                  />
                  <span className="co-roster-bye">
                    {index < byes ? <span className="co-status">Bye</span> : null}
                  </span>
                  <span className="co-seeding-move">
                    <button
                      type="button"
                      className="co-icon-btn"
                      data-seed={index}
                      data-move={-1}
                      disabled={index === 0}
                      aria-label={`Move ${entry.name || "player"} up to seed ${index}`}
                      onClick={() => move(index, -1)}
                    >
                      <ChevronUp size={13} />
                    </button>
                    <button
                      type="button"
                      className="co-icon-btn"
                      data-seed={index}
                      data-move={1}
                      disabled={index === entries.length - 1}
                      aria-label={`Move ${entry.name || "player"} down to seed ${index + 2}`}
                      onClick={() => move(index, 1)}
                    >
                      <ChevronDown size={13} />
                    </button>
                    <button
                      type="button"
                      className="co-icon-btn"
                      aria-label={`Remove ${entry.name || `seed ${index + 1}`}`}
                      onClick={() => remove(index)}
                    >
                      <X size={13} />
                    </button>
                  </span>
                </li>
              ))}
            </ol>
            <p
              className={checked && problem ? "co-roster-note co-field-error" : "co-roster-note"}
              role={checked && problem ? "alert" : undefined}
            >
              {checked && problem
                ? problem
                : entries.length > 0
                  ? "Seed 1 meets the lowest seed. Top seeds get the byes."
                  : null}
            </p>
            <div className="co-roster-actions">
              <button type="button" className="co-btn" onClick={add} disabled={entries.length >= 32}>
                <Plus size={13} aria-hidden="true" />
                Add player
              </button>
              {sorted ? null : (
                <button type="button" className="co-btn is-quiet" onClick={() => setEntries(byRating)}>
                  Sort by rating
                </button>
              )}
            </div>
            <details className="co-paste" open={entries.length === 0 ? true : undefined}>
              <summary>Paste a list</summary>
              <label className="co-field">
                <span className="co-sr">Players to add</span>
                <textarea
                  rows={4}
                  value={paste}
                  spellCheck={false}
                  placeholder={"Name, club, rating\nOne player per line"}
                  aria-invalid={pasteProblem ? true : undefined}
                  onChange={(event) => setPaste(event.target.value)}
                />
                {pasteProblem ? <small className="co-field-error">{pasteProblem}</small> : null}
              </label>
              <button type="button" className="co-btn" onClick={addPasted} disabled={!paste.trim()}>
                Add these players
              </button>
            </details>
          </section>
          {error ? (
            <p className="co-inline-error" role="alert">
              Could not create the tournament. {error}
            </p>
          ) : null}
        </fieldset>
        <footer className="co-drawer-foot">
          <button type="button" className="co-btn is-quiet" onClick={onDemo} disabled={busy}>
            {seeding ? "Loading demo…" : "Load demo"}
          </button>
          <span className="co-spacer" />
          <button type="button" className="co-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="co-btn is-primary" disabled={busy}>
            {pending ? "Creating bracket…" : "Create bracket"}
          </button>
        </footer>
      </form>
    </div>
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
