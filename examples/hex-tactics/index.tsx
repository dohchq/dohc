import "./styles.css";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useApp, useDatasetMutation, useDatasetQuery } from "dohc/app";
import {
  AppShell,
  Badge,
  Button,
  Callout,
  Card,
  DataTable,
  EmptyState,
  Field,
  Grid,
  Input,
  Modal,
  PageHeader,
  Stack,
  StatCard,
} from "dohc/ui";
import { LineChart } from "dohc/charts";
import { HexBoard, axialDistance, hexKeyOf } from "./hex-board";
import { reconstructReplayFrames } from "./replay";
import type {
  CreateGameReply,
  GameSummary,
  JoinGameReply,
  ReplayPayload,
  SeatCredential,
  StartDemoReply,
  SubmitMoveReply,
  VisibleBoardState,
  VisibleTile,
} from "./types";

interface StoredMatchSession {
  readonly gameId: string;
  readonly joinCode: string | null;
  readonly seats: readonly SeatCredential[];
  readonly activeSeat: 1 | 2;
}

function formatSeatKey(gameId: string, playerToken: string): string {
  return `HC1:${gameId}:${playerToken}`;
}

function parseSeatKey(raw: string): { gameId: string; playerToken: string } | null {
  const trimmed = raw.trim();
  const match = /^HC1:([A-Za-z0-9_-]{3,128}):([a-f0-9]{64})$/.exec(trimmed);
  if (!match) return null;
  return { gameId: match[1]!, playerToken: match[2]! };
}

function formatWinReason(reason: GameSummary["winReason"]): string {
  switch (reason) {
    case "capital_captured":
      return "Capital captured";
    case "resignation":
      return "Opponent resigned";
    default:
      return "Finished";
  }
}

function predictCombat(
  attackerUnits: number,
  targetTile: VisibleTile,
): { defensePower: number; willCapture: boolean; terrainBonus: number; fortifyBonus: number } {
  const defenderUnits = targetTile.units ?? 0;
  const terrainBonus =
    defenderUnits > 0
      ? targetTile.terrain === "capital"
        ? 2
        : targetTile.terrain === "forest"
          ? 1
          : 0
      : 0;
  const fortifyBonus = defenderUnits > 0 && targetTile.fortified ? 2 : 0;
  const defensePower = defenderUnits + terrainBonus + fortifyBonus;
  return {
    defensePower,
    willCapture: attackerUnits > defensePower,
    terrainBonus,
    fortifyBonus,
  };
}

export function HexClashApp() {
  const client = useApp();
  const gamesQuery = useDatasetQuery<{
    games: GameSummary[];
    canSpectateActive?: boolean;
  }>("listGames", {});
  const startDemo = useDatasetMutation<
    { player1Name?: string; player2Name?: string; seed?: number },
    StartDemoReply
  >("startDemoMatch");
  const createGame = useDatasetMutation<
    { title?: string; playerName?: string },
    CreateGameReply
  >("createGame");
  const joinGame = useDatasetMutation<
    { joinCode: string; playerName?: string },
    JoinGameReply
  >("joinGame");
  const submitMove = useDatasetMutation<
    {
      gameId: string;
      playerToken: string;
      actionType: "march" | "fortify" | "reinforce" | "pass" | "resign";
      expectedTurn?: number;
      fromQ?: number;
      fromR?: number;
      toQ?: number;
      toR?: number;
      units?: number;
    },
    SubmitMoveReply
  >("submitMove");

  const [sessions, setSessions] = useState<Record<string, StoredMatchSession>>({});
  const [activeGameId, setActiveGameId] = useState<string | null>(null);
  const activeGameIdRef = useRef<string | null>(null);
  activeGameIdRef.current = activeGameId;
  const [spectatorMode, setSpectatorMode] = useState(false);

  const [selectedHex, setSelectedHex] = useState<string | null>(null);
  const [targetHex, setTargetHex] = useState<string | null>(null);
  const [marchUnits, setMarchUnits] = useState(1);
  const [reinforceUnits, setReinforceUnits] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);
  const [copiedCodeValue, setCopiedCodeValue] = useState<string | null>(null);
  const copiedCodeTimerRef = useRef<number | null>(null);
  const [seatKeyFeedback, setSeatKeyFeedback] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createName, setCreateName] = useState("Crimson");

  const [joinOpen, setJoinOpen] = useState(false);
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [joinName, setJoinName] = useState("Cobalt");

  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeKeyInput, setResumeKeyInput] = useState("");
  const [resumePending, setResumePending] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const [seatKeyOpen, setSeatKeyOpen] = useState(false);
  const [resignOpen, setResignOpen] = useState(false);

  const [replayOpen, setReplayOpen] = useState(false);
  const [replayData, setReplayData] = useState<ReplayPayload | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [replayStep, setReplayStep] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const replayRequestSeq = useRef(0);

  useEffect(() => {
    return () => {
      replayRequestSeq.current += 1;
      if (copiedCodeTimerRef.current !== null) {
        window.clearTimeout(copiedCodeTimerRef.current);
      }
    };
  }, []);

  const cancelPendingReplay = useCallback(() => {
    replayRequestSeq.current += 1;
    setReplayLoading(false);
    setReplayError(null);
    setReplayPlaying(false);
  }, []);

  const activeSession = activeGameId ? (sessions[activeGameId] ?? null) : null;
  const activeSeatCredential = useMemo(() => {
    if (!activeSession) return null;
    return (
      activeSession.seats.find((s) => s.seat === activeSession.activeSeat) ??
      activeSession.seats[0] ??
      null
    );
  }, [activeSession]);

  const boardInput = useMemo(() => {
    if (!activeGameId) return undefined;
    if (spectatorMode) return { gameId: activeGameId, spectator: true };
    if (!activeSeatCredential) return undefined;
    return { gameId: activeGameId, playerToken: activeSeatCredential.playerToken };
  }, [activeGameId, activeSeatCredential, spectatorMode]);

  const boardQuery = useDatasetQuery<VisibleBoardState>("getVisibleState", boardInput, {
    enabled: Boolean(boardInput),
  });

  const board = boardQuery.data ?? null;
  const games = gamesQuery.data?.games ?? [];
  const canSpectateActive = gamesQuery.data?.canSpectateActive === true;

  const updateSession = useCallback((session: StoredMatchSession) => {
    setSessions((prev) => ({ ...prev, [session.gameId]: session }));
  }, []);

  const switchSeat = useCallback(
    (seat: 1 | 2) => {
      if (!activeSession) return;
      cancelPendingReplay();
      updateSession({ ...activeSession, activeSeat: seat });
      setSpectatorMode(false);
      setReplayOpen(false);
      setResignOpen(false);
      setSelectedHex(null);
      setTargetHex(null);
      setNotice(null);
    },
    [activeSession, cancelPendingReplay, updateSession],
  );

  useEffect(() => {
    if (!activeGameId || replayOpen) return;
    if (!board || board.game.status === "finished") return;
    const isPassAndPlay = (activeSession?.seats.length ?? 0) === 2;
    const needsRemoteRefresh =
      board.game.status === "waiting" || (!isPassAndPlay && board.game.status === "active");
    if (!needsRemoteRefresh) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        boardQuery.reload();
      }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [activeGameId, activeSession?.seats.length, board, boardQuery.reload, replayOpen]);

  const replayFrames = useMemo(
    () => (replayData ? reconstructReplayFrames(replayData) : []),
    [replayData],
  );

  useEffect(() => {
    if (!replayPlaying || !replayOpen || replayFrames.length <= 1) return;
    const timer = window.setInterval(() => {
      setReplayStep((current) => {
        if (current >= replayFrames.length - 1) {
          setReplayPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 850);
    return () => window.clearInterval(timer);
  }, [replayFrames.length, replayOpen, replayPlaying]);

  const activeReplayFrame =
    replayOpen && replayFrames.length > 0
      ? (replayFrames[Math.min(replayStep, replayFrames.length - 1)] ?? null)
      : null;

  const displayedTiles = activeReplayFrame ? activeReplayFrame.tiles : (board?.tiles ?? []);
  const tileByKey = useMemo(() => {
    const map = new Map<string, VisibleTile>();
    for (const tile of displayedTiles) {
      map.set(hexKeyOf(tile.q, tile.r), tile);
    }
    return map;
  }, [displayedTiles]);

  const selectedTile = selectedHex ? (tileByKey.get(selectedHex) ?? null) : null;
  const targetTile = targetHex ? (tileByKey.get(targetHex) ?? null) : null;

  const viewerSeat = replayOpen ? null : (board?.viewer.seat ?? null);
  const isMyTurn = Boolean(
    !replayOpen &&
      board &&
      board.game.status === "active" &&
      viewerSeat !== null &&
      board.game.activeSeat === viewerSeat &&
      activeSeatCredential,
  );

  const validTargets = useMemo(() => {
    const set = new Set<string>();
    if (!isMyTurn || !selectedTile || selectedTile.ownerSeat !== viewerSeat) return set;
    if ((selectedTile.units ?? 0) <= 1) return set;
    for (const tile of displayedTiles) {
      if (!tile.visible || tile.terrain === "mountain") continue;
      if (axialDistance(selectedTile.q, selectedTile.r, tile.q, tile.r) === 1) {
        set.add(hexKeyOf(tile.q, tile.r));
      }
    }
    return set;
  }, [displayedTiles, isMyTurn, selectedTile, viewerSeat]);

  const currentPlayer = useMemo(() => {
    if (!board || viewerSeat === null) return null;
    return board.players.find((p) => p.seat === viewerSeat) ?? null;
  }, [board, viewerSeat]);

  const activeSeatKey =
    activeGameId && activeSeatCredential
      ? formatSeatKey(activeGameId, activeSeatCredential.playerToken)
      : null;

  const applyDemoResult = (data: StartDemoReply) => {
    cancelPendingReplay();
    updateSession({
      gameId: data.gameId,
      joinCode: data.joinCode,
      seats: data.seats,
      activeSeat: 1,
    });
    setActiveGameId(data.gameId);
    setSpectatorMode(false);
    setReplayOpen(false);
    setReplayData(null);
    setResignOpen(false);
    setSelectedHex(null);
    setTargetHex(null);
    setNotice(`Demo match ready. Join code ${data.joinCode}.`);
    gamesQuery.reload();
  };

  const applyCreateResult = (data: CreateGameReply) => {
    cancelPendingReplay();
    updateSession({
      gameId: data.gameId,
      joinCode: data.joinCode,
      seats: [
        {
          seat: 1,
          playerId: data.playerId,
          name: data.playerName,
          color: "crimson",
          playerToken: data.playerToken,
        },
      ],
      activeSeat: 1,
    });
    setActiveGameId(data.gameId);
    setSpectatorMode(false);
    setReplayOpen(false);
    setReplayData(null);
    setResignOpen(false);
    setSelectedHex(null);
    setTargetHex(null);
    setCreateOpen(false);
    setCreateTitle("");
    setNotice(
      `Match created. Share join code ${data.joinCode} for Seat 2, and save your seat key.`,
    );
    gamesQuery.reload();
  };

  const applyJoinResult = (data: JoinGameReply) => {
    cancelPendingReplay();
    const seat2: SeatCredential = {
      seat: 2,
      playerId: data.playerId,
      name: data.playerName,
      color: "cobalt",
      playerToken: data.playerToken,
    };
    setSessions((prev) => {
      const existing = prev[data.gameId];
      const seats = existing ? [...existing.seats.filter((s) => s.seat !== 2), seat2] : [seat2];
      return {
        ...prev,
        [data.gameId]: {
          gameId: data.gameId,
          joinCode: data.joinCode,
          seats,
          activeSeat: 2,
        },
      };
    });
    setActiveGameId(data.gameId);
    setSpectatorMode(false);
    setReplayOpen(false);
    setReplayData(null);
    setResignOpen(false);
    setSelectedHex(null);
    setTargetHex(null);
    setJoinOpen(false);
    setJoinCodeInput("");
    setNotice(
      `Joined match ${data.joinCode} as Seat 2 (${data.playerName}). Save your seat key to resume after reload.`,
    );
    gamesQuery.reload();
  };

  const applyMoveResult = (result: SubmitMoveReply) => {
    if (result.state.game.status === "active") {
      setSessions((prev) => {
        const current = prev[result.state.game.id];
        if (!current || current.seats.length !== 2) return prev;
        return {
          ...prev,
          [result.state.game.id]: {
            ...current,
            activeSeat: result.state.game.activeSeat,
          },
        };
      });
    }
    if (activeGameIdRef.current === result.state.game.id) {
      setSelectedHex(null);
      setTargetHex(null);
      setResignOpen(false);
      setNotice(result.outcome.summary);
      boardQuery.reload();
    }
    gamesQuery.reload();
  };

  const handleStartDemo = async () => {
    setNotice(null);
    try {
      const reply = startDemo.uncertain ? await startDemo.retry() : await startDemo.mutate({});
      if (!reply) return;
      applyDemoResult(reply.result);
    } catch {
      return;
    }
  };

  const handleRetryCreate = async () => {
    setNotice(null);
    try {
      const reply = await createGame.retry();
      if (!reply) return;
      applyCreateResult(reply.result);
    } catch {
      return;
    }
  };

  const handleCreateGame = async (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    try {
      const reply = createGame.uncertain
        ? await createGame.retry()
        : await createGame.mutate({
            title: createTitle.trim() || undefined,
            playerName: createName.trim() || "Crimson",
          });
      if (!reply) return;
      applyCreateResult(reply.result);
    } catch {
      return;
    }
  };

  const handleRetryJoin = async () => {
    setNotice(null);
    try {
      const reply = await joinGame.retry();
      if (!reply) return;
      applyJoinResult(reply.result);
    } catch {
      return;
    }
  };

  const handleJoinGame = async (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    try {
      const reply = joinGame.uncertain
        ? await joinGame.retry()
        : await joinGame.mutate({
            joinCode: joinCodeInput.trim().toUpperCase(),
            playerName: joinName.trim() || "Cobalt",
          });
      if (!reply) return;
      applyJoinResult(reply.result);
    } catch {
      return;
    }
  };

  const handleRetryMove = async () => {
    setNotice(null);
    try {
      const reply = await submitMove.retry();
      if (!reply) return;
      applyMoveResult(reply.result);
    } catch {
      return;
    }
  };

  const handleResumeSeat = async (event: FormEvent) => {
    event.preventDefault();
    setResumeError(null);
    const parsed = parseSeatKey(resumeKeyInput);
    if (!parsed) {
      setResumeError("Enter a valid seat key starting with HC1:.");
      return;
    }
    setResumePending(true);
    try {
      const state = await client.read<VisibleBoardState>("getVisibleState", {
        gameId: parsed.gameId,
        playerToken: parsed.playerToken,
      });
      if (state.viewer.seat === null) {
        setResumeError("That seat key does not match an active seat.");
        return;
      }
      const seat = state.viewer.seat;
      const playerInfo = state.players.find((p) => p.seat === seat);
      const restored: SeatCredential = {
        seat,
        playerId: playerInfo?.id ?? `p${seat}_${parsed.gameId}`,
        name: playerInfo?.name ?? (seat === 1 ? "Crimson" : "Cobalt"),
        color: seat === 1 ? "crimson" : "cobalt",
        playerToken: parsed.playerToken,
      };
      cancelPendingReplay();
      setSessions((prev) => {
        const existing = prev[parsed.gameId];
        const seats = existing
          ? [...existing.seats.filter((s) => s.seat !== seat), restored]
          : [restored];
        return {
          ...prev,
          [parsed.gameId]: {
            gameId: parsed.gameId,
            joinCode: state.game.joinCode ?? null,
            seats,
            activeSeat: seat,
          },
        };
      });
      setActiveGameId(parsed.gameId);
      setSpectatorMode(false);
      setReplayOpen(false);
      setReplayData(null);
      setResignOpen(false);
      setSelectedHex(null);
      setTargetHex(null);
      setResumeOpen(false);
      setResumeKeyInput("");
      setNotice(`Resumed Seat ${seat} (${restored.name}) in ${state.game.title}.`);
      gamesQuery.reload();
    } catch (caught) {
      setResumeError(caught instanceof Error ? caught.message : "Could not resume that seat key.");
    } finally {
      setResumePending(false);
    }
  };

  const handleSelectHex = (tile: VisibleTile) => {
    if (replayOpen || !tile.visible) return;
    const key = hexKeyOf(tile.q, tile.r);
    if (isMyTurn && selectedTile && validTargets.has(key)) {
      setTargetHex(key);
      const maxMovable = Math.max(1, (selectedTile.units ?? 1) - 1);
      setMarchUnits(maxMovable);
      return;
    }
    if (selectedHex === key) {
      setSelectedHex(null);
      setTargetHex(null);
      return;
    }
    if (isMyTurn && tile.ownerSeat === viewerSeat) {
      setSelectedHex(key);
      setTargetHex(null);
      const maxMovable = Math.max(1, (tile.units ?? 1) - 1);
      setMarchUnits(maxMovable);
      setReinforceUnits(1);
    }
  };

  const executeOrder = async (
    actionType: "march" | "fortify" | "reinforce" | "pass" | "resign",
  ) => {
    if (!activeGameId || !activeSeatCredential) return;
    const submittedGameId = activeGameId;
    setNotice(null);
    try {
      const payload: {
        gameId: string;
        playerToken: string;
        actionType: "march" | "fortify" | "reinforce" | "pass" | "resign";
        expectedTurn?: number;
        fromQ?: number;
        fromR?: number;
        toQ?: number;
        toR?: number;
        units?: number;
      } = {
        gameId: submittedGameId,
        playerToken: activeSeatCredential.playerToken,
        actionType,
        ...(actionType !== "resign" && board ? { expectedTurn: board.game.turnNumber } : {}),
      };
      if (actionType === "march" && selectedTile && targetTile) {
        payload.fromQ = selectedTile.q;
        payload.fromR = selectedTile.r;
        payload.toQ = targetTile.q;
        payload.toR = targetTile.r;
        payload.units = marchUnits;
      } else if (actionType === "fortify" && selectedTile) {
        payload.fromQ = selectedTile.q;
        payload.fromR = selectedTile.r;
      } else if (actionType === "reinforce" && selectedTile) {
        payload.fromQ = selectedTile.q;
        payload.fromR = selectedTile.r;
        payload.units = reinforceUnits;
      }
      const reply = await submitMove.mutate(payload);
      applyMoveResult(reply.result);
    } catch {
      if (activeGameIdRef.current === submittedGameId) {
        boardQuery.reload();
      }
      gamesQuery.reload();
      return;
    }
  };

  const openReplay = async (gameId: string) => {
    const requestId = ++replayRequestSeq.current;
    setReplayLoading(true);
    setReplayError(null);
    setReplayPlaying(false);
    try {
      const firstPage = await client.read<ReplayPayload>("replayGame", {
        gameId,
        afterTurn: 0,
        limit: 200,
      });
      if (replayRequestSeq.current !== requestId) return;
      const allMoves = [...firstPage.moves];
      let cursor = firstPage.nextAfterTurn;
      while (cursor !== null) {
        const nextPage = await client.read<ReplayPayload>("replayGame", {
          gameId,
          afterTurn: cursor,
          limit: 200,
        });
        if (replayRequestSeq.current !== requestId) return;
        allMoves.push(...nextPage.moves);
        cursor = nextPage.nextAfterTurn;
      }
      setReplayData({ ...firstPage, moves: allMoves, nextAfterTurn: null });
      setReplayStep(0);
      setReplayOpen(true);
    } catch (caught) {
      if (replayRequestSeq.current !== requestId) return;
      setReplayError(caught instanceof Error ? caught.message : "Could not load match replay.");
    } finally {
      if (replayRequestSeq.current === requestId) {
        setReplayLoading(false);
      }
    }
  };

  const handleCopyJoinCode = async (code: string) => {
    const requestedGameId = activeGameIdRef.current;
    if (window.origin !== "null" && typeof navigator.clipboard?.writeText === "function") {
      try {
        await navigator.clipboard.writeText(code);
        if (activeGameIdRef.current !== requestedGameId) return;
        if (copiedCodeTimerRef.current !== null) {
          window.clearTimeout(copiedCodeTimerRef.current);
        }
        setCopiedCodeValue(code);
        copiedCodeTimerRef.current = window.setTimeout(() => {
          copiedCodeTimerRef.current = null;
          setCopiedCodeValue((current) => (current === code ? null : current));
        }, 1800);
        return;
      } catch {
        if (activeGameIdRef.current === requestedGameId) {
          setNotice(`Copy join code manually: ${code}`);
        }
        return;
      }
    }
    setNotice(`Copy join code manually: ${code}`);
  };

  const handleCopySeatKey = async (keyText: string) => {
    if (window.origin !== "null" && typeof navigator.clipboard?.writeText === "function") {
      try {
        await navigator.clipboard.writeText(keyText);
        setSeatKeyFeedback("Copied to clipboard.");
        return;
      } catch {
        setSeatKeyFeedback(null);
      }
    }
    const input = document.getElementById("seat-key-value");
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
      try {
        if (document.execCommand("copy")) {
          setSeatKeyFeedback("Copied to clipboard.");
          return;
        }
      } catch {
        setSeatKeyFeedback("Seat key selected. Press Ctrl+C or Cmd+C to copy.");
        return;
      }
    }
    setSeatKeyFeedback("Seat key selected. Press Ctrl+C or Cmd+C to copy.");
  };

  const maxMovable = selectedTile ? Math.max(0, (selectedTile.units ?? 0) - 1) : 0;
  const maxReinforce = currentPlayer?.gold ? Math.min(5, Math.floor(currentPlayer.gold / 2)) : 0;
  const combatEstimate =
    selectedTile && targetTile && targetTile.ownerSeat !== viewerSeat
      ? predictCombat(marchUnits, targetTile)
      : null;

  const lastMoveForBoard = useMemo(() => {
    if (activeReplayFrame) {
      return activeReplayFrame.move
        ? { fromHex: activeReplayFrame.move.fromHex, toHex: activeReplayFrame.move.toHex }
        : null;
    }
    const latest = board?.recentMoves[0];
    if (!latest || latest.hidden) return null;
    return { fromHex: latest.fromHex, toHex: latest.toHex };
  }, [activeReplayFrame, board?.recentMoves]);

  const replayChartSeries = useMemo(() => {
    if (replayFrames.length === 0) return null;
    const p1Name = replayData?.players.find((p) => p.seat === 1)?.name ?? "Crimson";
    const p2Name = replayData?.players.find((p) => p.seat === 2)?.name ?? "Cobalt";
    return {
      labels: replayFrames.map((f) => f.label),
      series: [
        { name: p1Name, values: replayFrames.map((f) => f.seat1Units), color: "var(--hex-p1)" },
        { name: p2Name, values: replayFrames.map((f) => f.seat2Units), color: "var(--hex-p2)" },
      ],
    };
  }, [replayData?.players, replayFrames]);

  const visibleJoinCode = board?.game.joinCode ?? activeSession?.joinCode ?? null;

  return (
    <AppShell width="wide">
      <PageHeader
        eyebrow="Authoritative SQLite strategy"
        title="HexClash"
        subtitle="Turn-based hex warfare with server-enforced fog of war and deterministic replay."
        actions={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button
              id="open-resume-btn"
              variant="secondary"
              onClick={() => {
                setResumeError(null);
                setResumeOpen(true);
              }}
            >
              Resume seat
            </Button>
            <Button
              id="open-join-btn"
              variant="secondary"
              onClick={() => setJoinOpen(true)}
            >
              Join by code
            </Button>
            <Button
              id="open-create-btn"
              variant="secondary"
              onClick={() => setCreateOpen(true)}
            >
              Create match
            </Button>
            <Button
              id="start-demo-btn"
              variant="primary"
              loading={startDemo.pending}
              onClick={handleStartDemo}
            >
              {startDemo.uncertain ? "Retry demo match" : "Start 2-Player Demo Match"}
            </Button>
          </div>
        }
      />

      <Stack gap={16}>
        {gamesQuery.error ? (
          <Callout
            tone="danger"
            title="Could not load matches"
            action={
              <Button size="sm" onClick={gamesQuery.reload}>
                Try again
              </Button>
            }
          >
            {gamesQuery.error.message}
          </Callout>
        ) : null}
        {startDemo.error || startDemo.uncertain ? (
          <Callout
            tone="danger"
            title={startDemo.uncertain ? "Demo match status is uncertain" : "Could not start demo match"}
            action={
              startDemo.uncertain ? (
                <Stack direction="horizontal" gap={6}>
                  <Button
                    id="retry-demo-btn"
                    size="sm"
                    loading={startDemo.pending}
                    onClick={() => void handleStartDemo()}
                  >
                    Try again
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={startDemo.pending}
                    onClick={startDemo.discardPending}
                  >
                    Discard
                  </Button>
                </Stack>
              ) : undefined
            }
          >
            {startDemo.uncertain
              ? "The previous request may have already created a demo match. Try again to recover its seats, or discard to start a new one."
              : startDemo.error?.message}
          </Callout>
        ) : null}
        {createGame.uncertain && !createOpen ? (
          <Callout
            tone="danger"
            title="Match creation status is uncertain"
            action={
              <Stack direction="horizontal" gap={6}>
                <Button
                  id="retry-create-banner-btn"
                  size="sm"
                  loading={createGame.pending}
                  onClick={() => void handleRetryCreate()}
                >
                  Try again
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={createGame.pending}
                  onClick={createGame.discardPending}
                >
                  Discard
                </Button>
              </Stack>
            }
          >
            The previous match creation may have already succeeded. Try again to recover Seat 1 and
            your join code, or discard to abandon it.
          </Callout>
        ) : null}
        {joinGame.uncertain && !joinOpen ? (
          <Callout
            tone="danger"
            title="Seat 2 join status is uncertain"
            action={
              <Stack direction="horizontal" gap={6}>
                <Button
                  id="retry-join-banner-btn"
                  size="sm"
                  loading={joinGame.pending}
                  onClick={() => void handleRetryJoin()}
                >
                  Try again
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={joinGame.pending}
                  onClick={joinGame.discardPending}
                >
                  Discard
                </Button>
              </Stack>
            }
          >
            Your previous join request may have already claimed Seat 2. Try again to recover your
            seat key before trying another code.
          </Callout>
        ) : null}
        {boardQuery.error ? (
          <Callout
            tone="danger"
            title="Could not load board state"
            action={
              <Button size="sm" onClick={boardQuery.reload}>
                Try again
              </Button>
            }
          >
            {boardQuery.error.message}
          </Callout>
        ) : null}
        {submitMove.error || submitMove.uncertain ? (
          <Callout
            tone="danger"
            title={submitMove.uncertain ? "Move status is uncertain" : "Move refused"}
            action={
              submitMove.uncertain ? (
                <Stack direction="horizontal" gap={6}>
                  <Button
                    id="retry-move-btn"
                    size="sm"
                    loading={submitMove.pending}
                    onClick={() => void handleRetryMove()}
                  >
                    Try again
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={submitMove.pending}
                    onClick={submitMove.discardPending}
                  >
                    Discard
                  </Button>
                </Stack>
              ) : undefined
            }
          >
            {submitMove.uncertain
              ? "The previous order may have already committed. Try again with the same request, or discard."
              : submitMove.error?.message}
          </Callout>
        ) : null}
        {replayError ? (
          <Callout tone="danger" title="Replay unavailable">
            {replayError}
          </Callout>
        ) : null}
        {notice ? (
          <Callout tone="success" title="Match update">
            <span id="board-status">{notice}</span>
          </Callout>
        ) : null}

        {board ? (
          <Stack gap={14}>
            <div className="hc-banner" data-testid="turn-banner">
              <Stack direction="horizontal" gap={12} align="center" wrap>
                <span className="hc-seat-pill">
                  <span
                    className={`hc-seat-dot ${
                      board.game.activeSeat === 1 ? "hc-seat-dot-1" : "hc-seat-dot-2"
                    }`}
                  />
                  {board.game.title}
                </span>
                <Badge
                  tone={
                    board.game.status === "finished"
                      ? "success"
                      : board.game.status === "waiting"
                        ? "warning"
                        : "neutral"
                  }
                >
                  {board.game.status === "finished"
                    ? `Winner: Seat ${board.game.winnerSeat} (${formatWinReason(board.game.winReason)})`
                    : board.game.status === "waiting"
                      ? "Waiting for Seat 2"
                      : `Turn ${board.game.turnNumber} · Seat ${board.game.activeSeat} to act`}
                </Badge>
                {visibleJoinCode ? (
                  <>
                    <span className="hc-join-code" title="Share this code privately with Seat 2">
                      {visibleJoinCode}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleCopyJoinCode(visibleJoinCode)}
                    >
                      {copiedCodeValue === visibleJoinCode ? "Copied" : "Copy code"}
                    </Button>
                  </>
                ) : null}
              </Stack>

              <Stack direction="horizontal" gap={8} align="center" wrap>
                {activeSession && activeSession.seats.length === 2 ? (
                  <>
                    <Button
                      id="seat-switch-1"
                      size="sm"
                      variant={
                        !replayOpen && !spectatorMode && activeSession.activeSeat === 1
                          ? "primary"
                          : "secondary"
                      }
                      onClick={() => switchSeat(1)}
                    >
                      Seat 1 (Crimson)
                    </Button>
                    <Button
                      id="seat-switch-2"
                      size="sm"
                      variant={
                        !replayOpen && !spectatorMode && activeSession.activeSeat === 2
                          ? "primary"
                          : "secondary"
                      }
                      onClick={() => switchSeat(2)}
                    >
                      Seat 2 (Cobalt)
                    </Button>
                  </>
                ) : null}
                {activeSeatKey ? (
                  <Button
                    id="open-seat-key-btn"
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setSeatKeyFeedback(null);
                      setSeatKeyOpen(true);
                    }}
                  >
                    Seat key
                  </Button>
                ) : null}
                {board.game.status === "finished" ? (
                  <Button
                    id="replay-toggle-btn"
                    size="sm"
                    variant={replayOpen ? "primary" : "secondary"}
                    loading={replayLoading}
                    onClick={() => {
                      if (replayOpen) {
                        cancelPendingReplay();
                        setReplayOpen(false);
                      } else {
                        void openReplay(board.game.id);
                      }
                    }}
                  >
                    {replayOpen ? "Exit replay" : "Replay match"}
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={boardQuery.reload}>
                  Refresh
                </Button>
              </Stack>
            </div>

            <Grid cols={4}>
              <StatCard
                label="Visible hexes"
                value={
                  replayOpen
                    ? `${displayedTiles.length} / ${displayedTiles.length}`
                    : `${board.viewer.visibleTiles} / ${board.tiles.length}`
                }
                hint={
                  replayOpen
                    ? "Full post-game visibility"
                    : `${board.viewer.foggedTiles} stripped by server fog`
                }
              />
              <StatCard
                label={
                  replayOpen
                    ? "Treasury (P1 / P2)"
                    : currentPlayer
                      ? `${currentPlayer.name} gold`
                      : "Match turn"
                }
                value={
                  replayOpen && activeReplayFrame
                    ? `${activeReplayFrame.seat1Gold}g / ${activeReplayFrame.seat2Gold}g`
                    : currentPlayer
                      ? `${currentPlayer.gold ?? 0}g`
                      : `Turn ${board.game.turnNumber}`
                }
                hint="Fortify 3g · Reinforce 2g/unit"
              />
              <StatCard
                label={currentPlayer ? `${currentPlayer.name} forces` : "Crimson forces"}
                value={
                  replayOpen && activeReplayFrame
                    ? `${activeReplayFrame.seat1Units}u · ${activeReplayFrame.seat1Tiles} hex`
                    : currentPlayer
                      ? `${currentPlayer.unitCount ?? 0}u · ${currentPlayer.tileCount ?? 0} hex`
                      : "—"
                }
                hint="Capital + gold mines spawn +1u/turn"
              />
              <StatCard
                label="Map seed"
                value={
                  replayOpen && replayData
                    ? `#${replayData.game.seed}`
                    : board.game.seed !== null
                      ? `#${board.game.seed}`
                      : "Hidden"
                }
                hint={
                  replayOpen || board.game.seed !== null
                    ? `Radius ${board.game.radius} · ${board.tiles.length} hexes`
                    : "Revealed after match finishes"
                }
              />
            </Grid>

            {replayOpen && activeReplayFrame ? (
              <div className="hc-replay-bar" data-testid="replay-controls">
                <div className="hc-inline-row">
                  <Stack direction="horizontal" gap={8} align="center" wrap>
                    <Badge tone="success">Replay</Badge>
                    <strong>
                      {activeReplayFrame.label} of {replayFrames.length - 1}
                    </strong>
                    <span className="hc-meta-text">
                      {activeReplayFrame.move
                        ? activeReplayFrame.move.outcome.summary
                        : "Opening map positions before Turn 1."}
                    </span>
                  </Stack>
                  <Stack direction="horizontal" gap={6}>
                    <Button
                      size="sm"
                      disabled={replayStep <= 0}
                      onClick={() => {
                        setReplayPlaying(false);
                        setReplayStep((s) => Math.max(0, s - 1));
                      }}
                    >
                      Prev
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        if (replayStep >= replayFrames.length - 1) setReplayStep(0);
                        setReplayPlaying((p) => !p);
                      }}
                    >
                      {replayPlaying ? "Pause" : "Play"}
                    </Button>
                    <Button
                      size="sm"
                      disabled={replayStep >= replayFrames.length - 1}
                      onClick={() => {
                        setReplayPlaying(false);
                        setReplayStep((s) => Math.min(replayFrames.length - 1, s + 1));
                      }}
                    >
                      Next
                    </Button>
                  </Stack>
                </div>
                <input
                  id="replay-slider"
                  className="hc-range"
                  type="range"
                  min={0}
                  max={Math.max(0, replayFrames.length - 1)}
                  value={replayStep}
                  aria-label="Replay turn scrubber"
                  onChange={(event) => {
                    setReplayPlaying(false);
                    setReplayStep(Number(event.target.value));
                  }}
                />
              </div>
            ) : null}

            <div className="hc-workbench">
              <HexBoard
                tiles={displayedTiles}
                viewerSeat={viewerSeat}
                canAct={isMyTurn}
                selectedHex={selectedHex}
                targetHex={targetHex}
                validTargets={validTargets}
                lastMove={lastMoveForBoard}
                onSelectHex={handleSelectHex}
              />

              <Stack gap={14}>
                <Card
                  title={
                    replayOpen
                      ? "Replay inspector"
                      : isMyTurn
                        ? `Orders for ${currentPlayer?.name ?? `Seat ${viewerSeat}`}`
                        : board.game.status === "finished"
                          ? "Match finished"
                          : "Waiting for opponent"
                  }
                  subtitle={
                    replayOpen
                      ? "Deterministic state reconstructed from Turn 0 and immutable move log."
                      : isMyTurn
                        ? "Select one of your hexes, then click a highlighted neighbor to march or attack."
                        : board.game.status === "waiting"
                          ? visibleJoinCode
                            ? `Share join code ${visibleJoinCode} privately so Seat 2 can join.`
                            : "Waiting for Seat 2 to join."
                          : board.game.status === "finished"
                            ? "Inspect the final board or scrub the turn-by-turn replay."
                            : `It is Seat ${board.game.activeSeat}'s turn.`
                  }
                >
                  {replayOpen && activeReplayFrame ? (
                    <Stack gap={10}>
                      <div className="hc-combat-preview">
                        <div>
                          <strong>Crimson:</strong> {activeReplayFrame.seat1Units} units across{" "}
                          {activeReplayFrame.seat1Tiles} hexes ({activeReplayFrame.seat1Gold}g)
                        </div>
                        <div>
                          <strong>Cobalt:</strong> {activeReplayFrame.seat2Units} units across{" "}
                          {activeReplayFrame.seat2Tiles} hexes ({activeReplayFrame.seat2Gold}g)
                        </div>
                      </div>
                      {replayChartSeries ? (
                        <LineChart
                          labels={replayChartSeries.labels}
                          series={replayChartSeries.series}
                          height={180}
                          ariaLabel="Force strength over turns"
                        />
                      ) : null}
                    </Stack>
                  ) : isMyTurn ? (
                    <div className="hc-order-grid">
                      {selectedTile ? (
                        <Stack gap={10}>
                          <div className="hc-inline-row">
                            <Badge>
                              Origin ({selectedTile.q}, {selectedTile.r}) · {selectedTile.terrain}
                            </Badge>
                            <span className="hc-meta-text">
                              {selectedTile.units} unit{selectedTile.units === 1 ? "" : "s"}
                              {selectedTile.fortified ? " · Fortified" : ""}
                            </span>
                          </div>

                          {targetTile ? (
                            <div className="hc-combat-preview">
                              <div>
                                <strong>
                                  {targetTile.ownerSeat === viewerSeat ? "Transfer" : "Attack"} to (
                                  {targetTile.q}, {targetTile.r})
                                </strong>{" "}
                                ({targetTile.terrain}, {targetTile.units ?? 0} unit
                                {targetTile.units === 1 ? "" : "s"}
                                {targetTile.fortified ? ", fortified" : ""})
                              </div>
                              {combatEstimate ? (
                                <span className="hc-meta-text">
                                  Defense power {combatEstimate.defensePower}
                                  {combatEstimate.terrainBonus > 0
                                    ? ` (+${combatEstimate.terrainBonus} terrain)`
                                    : ""}
                                  {combatEstimate.fortifyBonus > 0
                                    ? ` (+${combatEstimate.fortifyBonus} fortify)`
                                    : ""}
                                  {" · "}
                                  {combatEstimate.willCapture
                                    ? "Attacker captures hex"
                                    : "Defender holds"}
                                </span>
                              ) : null}
                              <div className="hc-inline-row" style={{ marginTop: 4 }}>
                                <div className="hc-stepper">
                                  <Button
                                    size="sm"
                                    disabled={marchUnits <= 1}
                                    onClick={() => setMarchUnits((u) => Math.max(1, u - 1))}
                                  >
                                    -
                                  </Button>
                                  <span className="hc-stepper-value">{marchUnits}u</span>
                                  <Button
                                    size="sm"
                                    disabled={marchUnits >= maxMovable}
                                    onClick={() =>
                                      setMarchUnits((u) => Math.min(maxMovable, u + 1))
                                    }
                                  >
                                    +
                                  </Button>
                                </div>
                                <Button
                                  id="order-march-btn"
                                  size="sm"
                                  variant="primary"
                                  loading={submitMove.pending}
                                  disabled={maxMovable < 1 || submitMove.uncertain}
                                  onClick={() => void executeOrder("march")}
                                >
                                  {targetTile.ownerSeat === viewerSeat
                                    ? `Move ${marchUnits}`
                                    : `Attack with ${marchUnits}`}
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <span className="hc-meta-text">
                              {maxMovable >= 1
                                ? `Click a highlighted neighbor to march up to ${maxMovable} unit${maxMovable === 1 ? "" : "s"}.`
                                : "Need at least 2 units on this hex to march."}
                            </span>
                          )}

                          <div className="hc-inline-row">
                            <Button
                              id="order-fortify-btn"
                              size="sm"
                              variant="secondary"
                              loading={submitMove.pending}
                              disabled={
                                selectedTile.fortified ||
                                (currentPlayer?.gold ?? 0) < 3 ||
                                submitMove.uncertain
                              }
                              onClick={() => void executeOrder("fortify")}
                            >
                              Fortify (3g)
                            </Button>

                            <div className="hc-stepper">
                              <Button
                                size="sm"
                                disabled={reinforceUnits <= 1}
                                onClick={() => setReinforceUnits((u) => Math.max(1, u - 1))}
                              >
                                -
                              </Button>
                              <span className="hc-stepper-value">+{reinforceUnits}u</span>
                              <Button
                                size="sm"
                                disabled={reinforceUnits >= Math.max(1, maxReinforce)}
                                onClick={() =>
                                  setReinforceUnits((u) =>
                                    Math.min(Math.max(1, maxReinforce), u + 1),
                                  )
                                }
                              >
                                +
                              </Button>
                              <Button
                                id="order-reinforce-btn"
                                size="sm"
                                variant="secondary"
                                loading={submitMove.pending}
                                disabled={
                                  maxReinforce < 1 ||
                                  reinforceUnits > maxReinforce ||
                                  submitMove.uncertain
                                }
                                onClick={() => void executeOrder("reinforce")}
                              >
                                Reinforce ({reinforceUnits * 2}g)
                              </Button>
                            </div>
                          </div>
                        </Stack>
                      ) : (
                        <span className="hc-meta-text">
                          Click any hex you control to march, fortify, or deploy reinforcements.
                        </span>
                      )}

                      <div className="hc-inline-row" style={{ paddingTop: 6, borderTop: "1px solid var(--kit-line)" }}>
                        <Button
                          id="order-pass-btn"
                          size="sm"
                          variant="secondary"
                          loading={submitMove.pending}
                          disabled={submitMove.uncertain}
                          onClick={() => void executeOrder("pass")}
                        >
                          Pass turn
                        </Button>
                        <Button
                          id="order-resign-btn"
                          size="sm"
                          variant="danger"
                          disabled={submitMove.pending || submitMove.uncertain}
                          onClick={() => setResignOpen(true)}
                        >
                          Resign match
                        </Button>
                      </div>
                    </div>
                  ) : board.game.status === "finished" ? (
                    <Stack gap={10}>
                      <span className="hc-meta-text">
                        Seat {board.game.winnerSeat} won ({formatWinReason(board.game.winReason)}).
                      </span>
                      <Button
                        variant="primary"
                        loading={replayLoading}
                        onClick={() => void openReplay(board.game.id)}
                      >
                        Open turn-by-turn replay
                      </Button>
                    </Stack>
                  ) : (
                    <Stack gap={8}>
                      <span className="hc-meta-text">
                        Board refreshes automatically every 4 seconds while waiting.
                      </span>
                      {activeSeatCredential && board.game.status === "active" ? (
                        <Button
                          id="order-resign-btn"
                          size="sm"
                          variant="danger"
                          disabled={submitMove.pending || submitMove.uncertain}
                          onClick={() => setResignOpen(true)}
                        >
                          Resign match
                        </Button>
                      ) : null}
                    </Stack>
                  )}
                </Card>

                <Card
                  title="Turn log"
                  subtitle={
                    replayOpen
                      ? "Click any turn to jump the replay scrubber."
                      : "Out-of-vision enemy moves are redacted on the server."
                  }
                >
                  {replayOpen && replayData ? (
                    replayData.moves.length === 0 ? (
                      <span className="hc-meta-text">No moves recorded.</span>
                    ) : (
                      <ul className="hc-move-list">
                        {replayData.moves.map((move, index) => (
                          <li key={move.turnNumber}>
                            <button
                              type="button"
                              className={`hc-move-btn ${
                                replayStep === index + 1 ? "hc-move-btn-active" : ""
                              }`}
                              aria-pressed={replayStep === index + 1}
                              onClick={() => {
                                setReplayPlaying(false);
                                setReplayStep(index + 1);
                              }}
                            >
                              <span>{move.outcome.summary}</span>
                              <span className="hc-move-turn">T{move.turnNumber}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )
                  ) : board.recentMoves.length === 0 ? (
                    <span className="hc-meta-text">No moves yet. Seat 1 acts first.</span>
                  ) : (
                    <ul className="hc-move-list">
                      {board.recentMoves.map((move) => (
                        <li key={move.turnNumber} className="hc-move-row">
                          <span>{move.outcome.summary}</span>
                          <span className="hc-move-turn">T{move.turnNumber}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </Stack>
            </div>
          </Stack>
        ) : (
          <Card>
            <EmptyState
              title="Ready for battle"
              description="Start a 2-player demo match to test server-enforced fog of war immediately, create a match and share its private join code, or resume a saved seat key."
              action={
                <Stack direction="horizontal" gap={8} justify="center" wrap>
                  <Button
                    variant="primary"
                    loading={startDemo.pending}
                    onClick={handleStartDemo}
                  >
                    {startDemo.uncertain ? "Retry demo match" : "Start 2-Player Demo Match"}
                  </Button>
                  <Button variant="secondary" onClick={() => setJoinOpen(true)}>
                    Join by code
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setResumeError(null);
                      setResumeOpen(true);
                    }}
                  >
                    Resume seat
                  </Button>
                </Stack>
              }
            />
          </Card>
        )}

        <Card
          title="Matches"
          subtitle="Join codes and seat keys stay private to seated players."
        >
          <DataTable
            rows={games}
            rowKey={(row) => row.id}
            loading={gamesQuery.loading && games.length === 0}
            emptyTitle="No matches yet"
            emptyDescription="Start a demo match or create a new match above."
            columns={[
              { key: "title", header: "Match", render: (row) => row.title },
              {
                key: "status",
                header: "Status",
                render: (row) => (
                  <Badge
                    tone={
                      row.status === "finished"
                        ? "success"
                        : row.status === "waiting"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {row.status === "finished"
                      ? `Seat ${row.winnerSeat} won`
                      : row.status === "waiting"
                        ? "Waiting"
                        : `Turn ${row.turnNumber}`}
                  </Badge>
                ),
              },
              {
                key: "players",
                header: "Players",
                render: (row) =>
                  (row.players ?? []).map((p) => p.name).join(" vs ") || "Open",
              },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (row) => {
                  const hasCred = Boolean(sessions[row.id]);
                  return (
                    <Stack direction="horizontal" gap={6} justify="flex-end">
                      {hasCred ? (
                        <Button
                          size="sm"
                          variant={activeGameId === row.id ? "primary" : "secondary"}
                          onClick={() => {
                            cancelPendingReplay();
                            setActiveGameId(row.id);
                            setSpectatorMode(false);
                            setReplayOpen(false);
                            setReplayData(null);
                            setResignOpen(false);
                            setSelectedHex(null);
                            setTargetHex(null);
                          }}
                        >
                          Open
                        </Button>
                      ) : row.status === "waiting" ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            if (!joinGame.uncertain) setJoinCodeInput("");
                            setJoinOpen(true);
                          }}
                        >
                          Enter code
                        </Button>
                      ) : null}
                      {row.status === "finished" || (row.status === "active" && canSpectateActive) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setActiveGameId(row.id);
                            setSpectatorMode(true);
                            setReplayOpen(false);
                            setReplayData(null);
                            setResignOpen(false);
                            void openReplay(row.id);
                          }}
                        >
                          Replay
                        </Button>
                      ) : null}
                    </Stack>
                  );
                },
              },
            ]}
          />
        </Card>
      </Stack>

      <Modal
        open={createOpen}
        title="Create match"
        onClose={() => {
          if (!createGame.pending) setCreateOpen(false);
        }}
      >
        <form onSubmit={handleCreateGame}>
          <fieldset
            disabled={createGame.pending}
            style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 12 }}
          >
            {createGame.error || createGame.uncertain ? (
              <Callout
                tone="danger"
                title={
                  createGame.uncertain
                    ? "Previous match creation may have succeeded"
                    : "Could not create match"
                }
                action={
                  createGame.uncertain ? (
                    <Button
                      id="discard-create-btn"
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={createGame.pending}
                      onClick={createGame.discardPending}
                    >
                      Discard
                    </Button>
                  ) : undefined
                }
              >
                {createGame.uncertain
                  ? "Retry the original request to recover your seat key and join code, or discard to start over."
                  : createGame.error?.message}
              </Callout>
            ) : null}
            <Field label="Your callsign" htmlFor="create-name">
              <Input
                id="create-name"
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                placeholder="Crimson"
                disabled={createGame.uncertain}
                required
              />
            </Field>
            <Field label="Match title" htmlFor="create-title">
              <Input
                id="create-title"
                value={createTitle}
                onChange={(event) => setCreateTitle(event.target.value)}
                placeholder="Friday skirmish"
                disabled={createGame.uncertain}
              />
            </Field>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button
                type="button"
                variant="secondary"
                disabled={createGame.pending}
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button
                id="submit-create-btn"
                type="submit"
                variant="primary"
                loading={createGame.pending}
              >
                {createGame.uncertain ? "Retry create match" : "Create match"}
              </Button>
            </div>
          </fieldset>
        </form>
      </Modal>

      <Modal
        open={joinOpen}
        title="Join match"
        onClose={() => {
          if (!joinGame.pending) setJoinOpen(false);
        }}
      >
        <form onSubmit={handleJoinGame}>
          <fieldset
            disabled={joinGame.pending}
            style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 12 }}
          >
            {joinGame.error || joinGame.uncertain ? (
              <Callout
                tone="danger"
                title={
                  joinGame.uncertain ? "Previous join may have claimed Seat 2" : "Could not join match"
                }
                action={
                  joinGame.uncertain ? (
                    <Button
                      id="discard-join-btn"
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={joinGame.pending}
                      onClick={joinGame.discardPending}
                    >
                      Discard
                    </Button>
                  ) : undefined
                }
              >
                {joinGame.uncertain
                  ? "Retry the original join request to recover your seat key, or discard to enter a different join code."
                  : joinGame.error?.message}
              </Callout>
            ) : null}
            <Field label="Join code" htmlFor="join-code-input">
              <Input
                id="join-code-input"
                value={joinCodeInput}
                onChange={(event) => setJoinCodeInput(event.target.value.toUpperCase())}
                placeholder="AB12CD"
                maxLength={6}
                disabled={joinGame.uncertain}
                required
              />
            </Field>
            <Field label="Your callsign" htmlFor="join-name-input">
              <Input
                id="join-name-input"
                value={joinName}
                onChange={(event) => setJoinName(event.target.value)}
                placeholder="Cobalt"
                disabled={joinGame.uncertain}
                required
              />
            </Field>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button
                type="button"
                variant="secondary"
                disabled={joinGame.pending}
                onClick={() => setJoinOpen(false)}
              >
                Cancel
              </Button>
              <Button id="submit-join-btn" type="submit" variant="primary" loading={joinGame.pending}>
                {joinGame.uncertain ? "Retry join" : "Join Seat 2"}
              </Button>
            </div>
          </fieldset>
        </form>
      </Modal>

      <Modal
        open={resumeOpen}
        title="Resume seat"
        onClose={() => {
          if (!resumePending) setResumeOpen(false);
        }}
      >
        <form onSubmit={handleResumeSeat}>
          <fieldset
            disabled={resumePending}
            style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 12 }}
          >
            {resumeError ? (
              <Callout tone="danger" title="Could not resume seat">
                {resumeError}
              </Callout>
            ) : null}
            <Field
              label="Private seat key"
              htmlFor="resume-key-input"
              hint="Paste the HC1:... key you saved before reloading."
            >
              <Input
                id="resume-key-input"
                value={resumeKeyInput}
                onChange={(event) => setResumeKeyInput(event.target.value)}
                placeholder="HC1:g_...:..."
                required
              />
            </Field>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button
                type="button"
                variant="secondary"
                disabled={resumePending}
                onClick={() => setResumeOpen(false)}
              >
                Cancel
              </Button>
              <Button id="submit-resume-btn" type="submit" variant="primary" loading={resumePending}>
                Resume seat
              </Button>
            </div>
          </fieldset>
        </form>
      </Modal>

      <Modal
        open={seatKeyOpen}
        title="Private seat key"
        onClose={() => setSeatKeyOpen(false)}
      >
        <Stack gap={12}>
          <span className="hc-meta-text">
            Keep this key private. Use Resume seat after reloading the app to reconnect to{" "}
            {activeSeatCredential?.name ?? "your seat"}.
          </span>
          <Field label="Seat key" htmlFor="seat-key-value">
            <Input
              id="seat-key-value"
              value={activeSeatKey ?? ""}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
          </Field>
          {seatKeyFeedback ? (
            <span id="seat-key-feedback" className="hc-meta-text" role="status">
              {seatKeyFeedback}
            </span>
          ) : null}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button variant="secondary" onClick={() => setSeatKeyOpen(false)}>
              Done
            </Button>
            {activeSeatKey ? (
              <Button
                id="copy-seat-key-btn"
                variant="primary"
                onClick={() => void handleCopySeatKey(activeSeatKey)}
              >
                Copy key
              </Button>
            ) : null}
          </div>
        </Stack>
      </Modal>
      <Modal
        open={resignOpen && board?.game.status === "active"}
        title="Resign match?"
        onClose={() => {
          if (!submitMove.pending) setResignOpen(false);
        }}
      >
        <Stack gap={12}>
          <span className="hc-meta-text">
            Resigning immediately ends {board?.game.title ?? "this match"} and awards victory to
            your opponent. This cannot be undone.
          </span>
          {submitMove.error || submitMove.uncertain ? (
            <Callout
              tone="danger"
              title={submitMove.uncertain ? "Resign status is uncertain" : "Could not resign"}
              action={
                submitMove.uncertain ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={submitMove.pending}
                    onClick={submitMove.discardPending}
                  >
                    Discard
                  </Button>
                ) : undefined
              }
            >
              {submitMove.uncertain
                ? "The previous resign request may have already completed. Retry to confirm the result."
                : submitMove.error?.message}
            </Callout>
          ) : null}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button
              id="cancel-resign-btn"
              variant="secondary"
              disabled={submitMove.pending}
              onClick={() => setResignOpen(false)}
            >
              Keep playing
            </Button>
            <Button
              id="confirm-resign-btn"
              variant="danger"
              loading={submitMove.pending}
              onClick={() =>
                void (submitMove.uncertain ? handleRetryMove() : executeOrder("resign"))
              }
            >
              {submitMove.uncertain ? "Retry resign" : "Resign match"}
            </Button>
          </div>
        </Stack>
      </Modal>
    </AppShell>
  );
}

const mount = document.getElementById("root");
if (mount) {
  createRoot(mount).render(
    <AppProvider>
      <HexClashApp />
    </AppProvider>,
  );
}
