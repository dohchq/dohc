import "./styles.css";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useApp, useDatasetMutation, useDatasetQuery } from "dohc/app";
import { Button, Modal } from "dohc/ui";
import { CircleHelp, Copy, Flag, List, LoaderCircle, Menu, Share2, TriangleAlert } from "dohc/icons";
import { CoinGlyph, FactionCrest, HexGlyph, HexLogo, SwapGlyph, UnitGlyph } from "./board-art";
import { HexBoard, axialDistance, hexKeyOf, type BoardFlash, type BoardForecast, type TargetKind } from "./hex-board";
import { Lobby, type LobbyPanel } from "./lobby";
import {
  CombatPreview,
  Kbd,
  LogDrawer,
  ReplayDock,
  RulesSheet,
  TacticalCard,
  TurnBanner,
  HandoffCover,
  factionName,
} from "./panels";
import { NO_SELECTION, selectionReducer } from "./selection";
import { useReplay } from "./use-replay";
import { REINFORCE_UNIT_COST, flashKindForMove, forecastMarch, isClaim, maxReinforce as maxReinforceFor } from "./rules";
import type {
  ActionType,
  CreateGameReply,
  GameSummary,
  JoinGameReply,
  SeatCredential,
  StartDemoReply,
  SubmitMoveReply,
  VisibleBoardState,
  VisibleTile,
} from "./types";
import { type StoredMatchSession, withJoinedSeat } from "./sessions";

interface MovePayload {
  gameId: string;
  playerToken: string;
  actionType: ActionType;
  expectedTurn?: number;
  fromQ?: number;
  fromR?: number;
  toQ?: number;
  toR?: number;
  units?: number;
}

interface Toast {
  readonly id: number;
  readonly text: string;
}

const REMOTE_POLL_MS = 4000;
function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

function observeHeight(property: string) {
  return (element: HTMLElement | null) => {
    const host = element?.parentElement;
    if (!element || !host) return;
    const observer = new ResizeObserver(() => host.style.setProperty(property, `${element.offsetHeight}px`));
    observer.observe(element);
    return () => observer.disconnect();
  };
}
const observeDock = observeHeight("--hc-dock-h");
const observeToasts = observeHeight("--hc-toasts-h");

function useBoardQuery(gameId: string | null, playerToken: string | undefined, spectator: boolean) {
  const input = useMemo(() => {
    if (!gameId) return undefined;
    if (spectator) return { gameId, spectator: true };
    return playerToken ? { gameId, playerToken } : undefined;
  }, [gameId, playerToken, spectator]);
  return useDatasetQuery<VisibleBoardState>("getVisibleState", input, { enabled: Boolean(input) });
}

function formatSeatKey(gameId: string, playerToken: string): string {
  return `HC1:${gameId}:${playerToken}`;
}

function parseSeatKey(raw: string): { gameId: string; playerToken: string } | null {
  const match = /^HC1:([A-Za-z0-9_-]{3,128}):([a-f0-9]{64})$/.exec(raw.trim());
  if (!match) return null;
  return { gameId: match[1]!, playerToken: match[2]! };
}

function formatWinReason(reason: GameSummary["winReason"], loserName: string): string {
  return reason === "capital_captured" ? `${loserName}'s capital fell` : reason === "resignation" ? `${loserName} resigned` : "Match over";
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function liveFlashScope(board: VisibleBoardState): string {
  return `${board.game.id}:${board.viewer.seat ?? "spectator"}`;
}

async function copyText(text: string, fallbackInputId: string | null): Promise<boolean> {
  if (window.origin !== "null" && typeof navigator.clipboard?.writeText === "function") {
    const copied = await navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
    if (copied) return true;
  }
  const input = fallbackInputId ? document.getElementById(fallbackInputId) : null;
  if (input instanceof HTMLInputElement) {
    input.focus();
    input.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    }
  }
  return false;
}

export function HexClashApp() {
  const client = useApp();
  const compact = useMediaQuery("(max-width: 899px), (max-height: 520px)");
  const gamesQuery = useDatasetQuery<{ games: GameSummary[] }>("listGames", {});
  const startDemo = useDatasetMutation<{ player1Name?: string; player2Name?: string; seed?: number }, StartDemoReply>(
    "startDemoMatch",
  );
  const createGame = useDatasetMutation<{ title?: string; playerName?: string }, CreateGameReply>("createGame");
  const joinGame = useDatasetMutation<{ joinCode: string; playerName?: string }, JoinGameReply>("joinGame");
  const submitMove = useDatasetMutation<MovePayload, SubmitMoveReply>("submitMove");
  const discardPendingOrder = submitMove.discardPending;

  const [sessions, setSessions] = useState<Record<string, StoredMatchSession>>({});
  const [activeGameId, setActiveGameId] = useState<string | null>(null);
  const activeGameIdRef = useRef<string | null>(null);
  const lockedAt = useRef(0);
  activeGameIdRef.current = activeGameId;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [spectatorMode, setSpectatorMode] = useState(false);
  const [settledPhase, setSettledPhase] = useState("loading");

  const [selection, dispatchSelection] = useReducer(selectionReducer, NO_SELECTION);
  const { selectedHex, targetHex, hoverHex, cursorHex, marchUnits, reinforceUnits } = selection;
  const [toast, setToast] = useState<Toast | null>(null);
  const toastSeq = useRef(0);

  const [lobbyOpen, setLobbyOpen] = useState(false);
  const [lobbyPanel, setLobbyPanel] = useState<LobbyPanel>(null);
  const [resumePending, setResumePending] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [seatKeyFeedback, setSeatKeyFeedback] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [resignOpen, setResignOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const replay = useReplay(client);
  const { open: replayOpen, data: replayData, step: replayStep, frames: replayFrames, activeFrame: activeReplayFrame } = replay;
  const { reset: resetReplay, close: closeReplay } = replay;
  const resumeRequestSeq = useRef(0);
  const navigationSeq = useRef(0);
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined);

  const [liveEvents, setLiveEvents] = useState(false);
  const [banner, setBanner] = useState<{ seat: 1 | 2 | null; turn: number; label: string; token: number } | null>(null);
  const [handoff, setHandoff] = useState<{ gameId: string; seat: 1 | 2; turn: number } | null>(null);
  const [logPreviewTurn, setLogPreviewTurn] = useState<number | null>(null);
  const [logPinnedTurn, setLogPinnedTurn] = useState<number | null>(null);
  const [flash, setFlash] = useState<BoardFlash | null>(null);
  const lastTurnKeyRef = useRef<string | null>(null);
  const lastMoveTurnRef = useRef<string | null>(null);

  useEffect(() => client.subscribe?.(() => setLiveEvents(true)), [client]);

  const showToast = useCallback((text: string) => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast((current) => (current?.id === toast.id ? null : current)), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const cancelPendingResume = useCallback(() => {
    resumeRequestSeq.current += 1;
    setResumePending(false);
  }, []);

  const activeSession = activeGameId ? (sessions[activeGameId] ?? null) : null;
  const activeSeatCredential = useMemo(() => {
    if (!activeSession) return null;
    return activeSession.seats.find((s) => s.seat === activeSession.activeSeat) ?? activeSession.seats[0] ?? null;
  }, [activeSession]);
  const isPassAndPlay = (activeSession?.seats.length ?? 0) === 2;

  const seatToken = (seat: 1 | 2) => (spectatorMode ? undefined : activeSession?.seats.find((s) => s.seat === seat)?.playerToken);
  const seatOneQuery = useBoardQuery(activeGameId, seatToken(1), false);
  const seatTwoQuery = useBoardQuery(activeGameId, seatToken(2), false);
  const spectatorQuery = useBoardQuery(activeGameId, undefined, spectatorMode);
  const boardQuery = spectatorMode ? spectatorQuery : activeSeatCredential?.seat === 2 ? seatTwoQuery : seatOneQuery;
  const boardData = boardQuery.data;
  const board =
    boardData &&
    boardData.game.id === activeGameId &&
    (spectatorMode ? boardData.viewer.spectator : boardData.viewer.seat === (activeSeatCredential?.seat ?? null))
      ? boardData
      : null;
  const canSwitchSeat = isPassAndPlay && !replayOpen && board?.game.status !== "finished";
  const games = gamesQuery.data?.games ?? [];
  const reloadSeatOne = seatOneQuery.reload;
  const reloadSeatTwo = seatTwoQuery.reload;
  const reloadSpectator = spectatorQuery.reload;
  const reloadBoard = useCallback(() => {
    reloadSeatOne();
    reloadSeatTwo();
    reloadSpectator();
  }, [reloadSeatOne, reloadSeatTwo, reloadSpectator]);
  const reloadGames = gamesQuery.reload;

  const resetBoardView = useCallback(() => {
    dispatchSelection({ type: "reset" });
    setFlash(null);
    setLogPinnedTurn(null);
    setLogPreviewTurn(null);
    setResignOpen(false);
  }, []);

  const updateSession = useCallback((session: StoredMatchSession) => {
    setSessions((prev) => ({ ...prev, [session.gameId]: session }));
  }, []);

  const enterGame = useCallback(
    (gameId: string, spectator: boolean) => {
      navigationSeq.current += 1;
      if (gameId !== activeGameIdRef.current) {
        discardPendingOrder();
        setDrawerOpen(false);
        setCodeCopied(false);
      }
      resetBoardView();
      resetReplay();
      cancelPendingResume();
      setActiveGameId(gameId);
      setSpectatorMode(spectator);
      setLobbyOpen(false);
      setLobbyPanel(null);
    },
    [cancelPendingResume, discardPendingOrder, resetBoardView, resetReplay],
  );

  const switchSeat = useCallback(
    (seat: 1 | 2) => {
      if (!activeSession || !canSwitchSeat) return;
      closeReplay();
      updateSession({ ...activeSession, activeSeat: seat });
      resetBoardView();
      setSpectatorMode(false);
    },
    [activeSession, canSwitchSeat, closeReplay, resetBoardView, updateSession],
  );

  const pollRemote =
    !liveEvents &&
    Boolean(board) &&
    !replayOpen &&
    board?.game.status !== "finished" &&
    (board?.game.status === "waiting" || !isPassAndPlay);
  useEffect(() => {
    if (!pollRemote) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") reloadBoard();
    }, REMOTE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [pollRemote, reloadBoard]);

  const lobbyVisible = lobbyOpen || !activeGameId;
  useEffect(() => {
    if (liveEvents || !lobbyVisible) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") reloadGames();
    }, REMOTE_POLL_MS * 2);
    return () => window.clearInterval(timer);
  }, [liveEvents, lobbyVisible, reloadGames]);

  const displayedTiles = activeReplayFrame ? activeReplayFrame.tiles : (board?.tiles ?? []);
  const tileByKey = useMemo(() => {
    const map = new Map<string, VisibleTile>();
    for (const tile of displayedTiles) map.set(hexKeyOf(tile.q, tile.r), tile);
    return map;
  }, [displayedTiles]);

  const viewerSeat = replayOpen ? null : (board?.viewer.seat ?? null);
  const isMyTurn = Boolean(
    !replayOpen && board && board.game.status === "active" && viewerSeat !== null && board.game.activeSeat === viewerSeat && activeSeatCredential,
  );
  const selectedTile = selectedHex ? (tileByKey.get(selectedHex) ?? null) : null;
  const currentPlayer = board && viewerSeat !== null ? (board.players.find((p) => p.seat === viewerSeat) ?? null) : null;
  const gold = currentPlayer?.gold ?? 0;

  const targets = useMemo(() => {
    const map = new Map<string, TargetKind>();
    if (!isMyTurn || !selectedTile || selectedTile.ownerSeat !== viewerSeat || (selectedTile.units ?? 0) <= 1) return map;
    for (const tile of displayedTiles) {
      if (!tile.visible || tile.terrain === "mountain") continue;
      if (axialDistance(selectedTile.q, selectedTile.r, tile.q, tile.r) !== 1) continue;
      map.set(hexKeyOf(tile.q, tile.r), tile.ownerSeat === viewerSeat ? "move" : isClaim(tile) ? "claim" : "attack");
    }
    return map;
  }, [displayedTiles, isMyTurn, selectedTile, viewerSeat]);

  const activeTargetHex = targetHex && targets.has(targetHex) ? targetHex : null;
  const targetTile = activeTargetHex ? (tileByKey.get(activeTargetHex) ?? null) : null;
  const maxMovable = selectedTile ? Math.max(0, (selectedTile.units ?? 0) - 1) : 0;
  const maxReinforce = maxReinforceFor(gold);

  const previewHex =
    activeTargetHex ?? (hoverHex && targets.has(hoverHex) ? hoverHex : cursorHex && targets.has(cursorHex) ? cursorHex : null);
  const previewTile = previewHex ? (tileByKey.get(previewHex) ?? null) : null;
  const previewUnits = previewHex === activeTargetHex ? Math.min(marchUnits, maxMovable) : maxMovable;
  const previewForecast =
    previewTile && viewerSeat !== null && previewUnits > 0 ? forecastMarch(previewUnits, previewTile, viewerSeat) : null;
  const targetForecast =
    targetTile && viewerSeat !== null && maxMovable > 0 ? forecastMarch(Math.min(marchUnits, maxMovable), targetTile, viewerSeat) : null;

  const boardForecast: BoardForecast | null =
    previewForecast && previewHex && selectedHex && (!compact || previewHex === activeTargetHex)
      ? {
          fromHex: selectedHex,
          toHex: previewHex,
          tone: previewForecast.kind === "transfer" ? "move" : targets.get(previewHex) === "claim" ? "claim" : previewForecast.kind,
          label:
            previewForecast.kind === "transfer"
              ? `+${previewForecast.attackerUnits}`
              : targets.get(previewHex) === "claim"
                ? "CLAIM"
                : previewForecast.kind === "capture"
                  ? previewForecast.capitalCaptured
                    ? "WIN"
                    : "CAPTURE"
                  : "REPELLED",
          leaving: previewForecast.attackerUnits,
          defenderLoss: previewForecast.kind === "transfer" ? 0 : previewForecast.defenderLosses,
          gain: previewForecast.kind === "transfer" ? previewForecast.attackerUnits : 0,
        }
      : null;

  const previewCard =
    previewForecast && previewTile && viewerSeat !== null && (!compact || previewHex === activeTargetHex) ? (
      <CombatPreview
        forecast={previewForecast}
        attackerSeat={viewerSeat}
        target={previewTile}
        onClose={compact ? () => dispatchSelection({ type: "deselect" }) : undefined}
      />
    ) : null;

  const boardInteractive = !replayOpen && !(compact && board?.game.status === "finished");
  const hoverInspectable =
    hoverHex && !compact && !replayOpen && board?.game.status !== "finished" && tileByKey.get(hoverHex)?.visible ? hoverHex : null;
  const inspectHex = selectedHex ?? hoverInspectable;
  const inspectTile = inspectHex ? (tileByKey.get(inspectHex) ?? null) : null;

  const latestMove = board?.recentMoves[0] ?? null;
  const lastMoveForBoard = useMemo(() => {
    if (activeReplayFrame) {
      const move = activeReplayFrame.move;
      return move ? { fromHex: move.fromHex, toHex: move.toHex, seat: move.actorSeat, token: move.turnNumber } : null;
    }
    if (!latestMove || latestMove.hidden) return null;
    return { fromHex: latestMove.fromHex, toHex: latestMove.toHex, seat: latestMove.actorSeat, token: latestMove.turnNumber };
  }, [activeReplayFrame, latestMove]);

  useEffect(() => {
    if (!board) return;
    const key = `${board.game.id}:${board.game.status}:${board.game.turnNumber}`;
    if (lastTurnKeyRef.current === key) return;
    const previous = lastTurnKeyRef.current;
    lastTurnKeyRef.current = key;
    if (board.game.status !== "active") return;
    const seat = board.game.activeSeat;
    if (isPassAndPlay && previous?.startsWith(`${board.game.id}:`)) return;
    const name = board.players.find((p) => p.seat === seat)?.name ?? factionName(seat);
    const label = !isPassAndPlay && viewerSeat === seat ? "Your turn" : name;
    setBanner({ seat, turn: board.game.turnNumber, label, token: Date.now() });
  }, [board, isPassAndPlay, viewerSeat]);

  const handoffActive = handoff !== null && handoff.gameId === activeGameId && board?.game.status !== "finished" && !replayOpen;
  const handoffReady =
    handoffActive && board !== null && board.viewer.seat === handoff.seat && board.game.turnNumber >= handoff.turn;
  const handoffName = handoff ? (board?.players.find((p) => p.seat === handoff.seat)?.name ?? factionName(handoff.seat)) : "";
  const dismissHandoff = () => {
    dispatchSelection({ type: "hover", hex: null });
    setHandoff(null);
  };

  const shownLogTurn = logPreviewTurn ?? logPinnedTurn;
  const shownLogPreview =
    drawerOpen && !replayOpen && shownLogTurn !== null
      ? (board?.recentMoves.find((move) => move.turnNumber === shownLogTurn && !move.hidden) ?? null)
      : null;

  useEffect(() => {
    if (!banner) return;
    const timer = window.setTimeout(() => setBanner(null), 1500);
    return () => window.clearTimeout(timer);
  }, [banner]);

  useEffect(() => {
    if (!board) return;
    const move = board.recentMoves[0];
    const key = move ? `${board.game.id}:${move.turnNumber}` : `${board.game.id}:none`;
    const previous = lastMoveTurnRef.current;
    lastMoveTurnRef.current = key;
    if (!move || previous === null || previous === key || !previous.startsWith(`${board.game.id}:`)) return;
    const kind = flashKindForMove(move);
    const hex = move.toHex ?? move.fromHex;
    if (kind && hex) setFlash({ hex, kind, token: move.turnNumber, scope: liveFlashScope(board) });
  }, [board]);

  useEffect(() => {
    if (!replayOpen || !activeReplayFrame?.move) return;
    const move = activeReplayFrame.move;
    const kind = flashKindForMove(move);
    const hex = move.toHex ?? move.fromHex;
    if (kind && hex) setFlash({ hex, kind, token: move.turnNumber, scope: `replay:${activeGameId}` });
  }, [activeReplayFrame, activeGameId, replayOpen]);

  const activeSeatKey =
    activeGameId && activeSeatCredential ? formatSeatKey(activeGameId, activeSeatCredential.playerToken) : null;
  const visibleJoinCode = board?.game.joinCode ?? activeSession?.joinCode ?? null;

  const applyDemoResult = (data: StartDemoReply, navigation: number) => {
    updateSession({ gameId: data.gameId, joinCode: data.joinCode, seats: data.seats, activeSeat: 1 });
    reloadGames();
    if (navigationSeq.current === navigation) enterGame(data.gameId, false);
    else showToast("Your demo match is ready in the Game menu.");
  };

  const applyCreateResult = (data: CreateGameReply, navigation: number) => {
    updateSession({
      gameId: data.gameId,
      joinCode: data.joinCode,
      seats: [{ seat: 1, playerId: data.playerId, name: data.playerName, color: "crimson", playerToken: data.playerToken }],
      activeSeat: 1,
    });
    reloadGames();
    if (navigationSeq.current !== navigation) {
      showToast("Your new match is ready in the Game menu.");
      return;
    }
    enterGame(data.gameId, false);
    setSeatKeyFeedback(null);
    setInviteOpen(true);
  };

  const applyJoinResult = (data: JoinGameReply, navigation: number) => {
    const stillHere = navigationSeq.current === navigation;
    setSessions((prev) => ({ ...prev, [data.gameId]: withJoinedSeat(prev[data.gameId], data, stillHere) }));
    reloadGames();
    if (!stillHere) {
      showToast(`Joined as ${data.playerName}. The match is ready in the Game menu.`);
      return;
    }
    enterGame(data.gameId, false);
    showToast(`Joined as ${data.playerName}. Save your seat key to come back later.`);
  };

  const applyMoveResult = (result: SubmitMoveReply) => {
    if (result.state.game.status === "active") {
      setSessions((prev) => {
        const current = prev[result.state.game.id];
        if (!current || current.seats.length !== 2) return prev;
        return { ...prev, [result.state.game.id]: { ...current, activeSeat: result.state.game.activeSeat } };
      });
    }
    if (activeGameIdRef.current === result.state.game.id) {
      const passAndPlay = sessionsRef.current[result.state.game.id]?.seats.length === 2;
      resetBoardView();
      if (passAndPlay && result.state.game.status === "active") {
        setBanner(null);
        setHandoff({ gameId: result.state.game.id, seat: result.state.game.activeSeat, turn: result.state.game.turnNumber });
      }
      if (result.state.game.status !== "finished" && !passAndPlay) showToast(result.outcome.summary);
      reloadBoard();
    }
    reloadGames();
  };

  const handleStartDemo = async () => {
    const navigation = navigationSeq.current;
    try {
      const reply = startDemo.uncertain ? await startDemo.retry() : await startDemo.mutate({});
      if (reply) applyDemoResult(reply.result, navigation);
    } catch {
      return;
    }
  };

  const handleCreateGame = async ({ name, title }: { name: string; title: string }) => {
    const navigation = navigationSeq.current;
    try {
      const reply = createGame.uncertain
        ? await createGame.retry()
        : await createGame.mutate({ title: title.trim() || undefined, playerName: name.trim() || "Crimson" });
      if (reply) applyCreateResult(reply.result, navigation);
    } catch {
      return;
    }
  };

  const handleJoinGame = async ({ code, name }: { code: string; name: string }) => {
    const navigation = navigationSeq.current;
    try {
      const reply = joinGame.uncertain
        ? await joinGame.retry()
        : await joinGame.mutate({ joinCode: code.trim().toUpperCase(), playerName: name.trim() || "Cobalt" });
      if (reply) applyJoinResult(reply.result, navigation);
    } catch {
      return;
    }
  };

  const handleRetry = async (kind: "demo" | "create" | "join" | "move") => {
    const navigation = navigationSeq.current;
    try {
      if (kind === "demo") {
        const reply = await startDemo.retry();
        if (reply) applyDemoResult(reply.result, navigation);
      } else if (kind === "create") {
        const reply = await createGame.retry();
        if (reply) applyCreateResult(reply.result, navigation);
      } else if (kind === "join") {
        const reply = await joinGame.retry();
        if (reply) applyJoinResult(reply.result, navigation);
      } else {
        const reply = await submitMove.retry();
        if (reply) applyMoveResult(reply.result);
      }
    } catch {
      return;
    }
  };

  const handleResumeSeat = async (seatKey: string) => {
    setResumeError(null);
    const parsed = parseSeatKey(seatKey);
    if (!parsed) {
      setResumeError("A seat key starts with HC1: and has three parts.");
      return;
    }
    const requestId = ++resumeRequestSeq.current;
    setResumePending(true);
    try {
      const state = await client.read<VisibleBoardState>("getVisibleState", {
        gameId: parsed.gameId,
        playerToken: parsed.playerToken,
      });
      if (resumeRequestSeq.current !== requestId) return;
      if (state.viewer.seat === null) {
        setResumeError("That seat key does not match a seat in this match.");
        return;
      }
      const seat = state.viewer.seat;
      const playerInfo = state.players.find((p) => p.seat === seat);
      const restored: SeatCredential = {
        seat,
        playerId: playerInfo?.id ?? `p${seat}_${parsed.gameId}`,
        name: playerInfo?.name ?? factionName(seat),
        color: seat === 1 ? "crimson" : "cobalt",
        playerToken: parsed.playerToken,
      };
      setSessions((prev) => {
        const existing = prev[parsed.gameId];
        const seats = existing ? [...existing.seats.filter((s) => s.seat !== seat), restored] : [restored];
        return {
          ...prev,
          [parsed.gameId]: { gameId: parsed.gameId, joinCode: state.game.joinCode ?? null, seats, activeSeat: seat },
        };
      });
      enterGame(parsed.gameId, false);
      showToast(`Back in ${state.game.title} as ${restored.name}`);
      reloadGames();
    } catch (caught) {
      if (resumeRequestSeq.current !== requestId) return;
      setResumeError(caught instanceof Error ? caught.message : "dohc could not resume that seat key.");
    } finally {
      if (resumeRequestSeq.current === requestId) setResumePending(false);
    }
  };

  const executeOrder = async (actionType: ActionType) => {
    if (!activeGameId || !activeSeatCredential || submitMove.pending || submitMove.uncertain) return;
    const submittedGameId = activeGameId;
    const payload: MovePayload = {
      gameId: submittedGameId,
      playerToken: activeSeatCredential.playerToken,
      actionType,
      ...(actionType !== "resign" && board ? { expectedTurn: board.game.turnNumber } : {}),
    };
    if (actionType === "march") {
      if (!selectedTile || !targetTile) return;
      Object.assign(payload, {
        fromQ: selectedTile.q,
        fromR: selectedTile.r,
        toQ: targetTile.q,
        toR: targetTile.r,
        units: Math.min(marchUnits, maxMovable),
      });
    } else if (actionType === "fortify" || actionType === "reinforce") {
      if (!selectedTile) return;
      Object.assign(payload, { fromQ: selectedTile.q, fromR: selectedTile.r });
      if (actionType === "reinforce") payload.units = Math.min(reinforceUnits, maxReinforce);
    }
    try {
      const reply = await submitMove.mutate(payload);
      applyMoveResult(reply.result);
    } catch {
      if (activeGameIdRef.current === submittedGameId) reloadBoard();
      reloadGames();
    }
  };

  const openReplay = async (gameId: string) => {
    if (!(await replay.load(gameId))) return;
    dispatchSelection({ type: "deselect" });
    if (!compact) setDrawerOpen(true);
  };

  const handleActivate = (tile: VisibleTile, via: "pointer" | "enter" | "space") => {
    if (!boardInteractive) return;
    const key = hexKeyOf(tile.q, tile.r);
    const forecastHidden = drawerOpen;
    if (forecastHidden) setDrawerOpen(false);
    dispatchSelection({ type: "cursor", hex: key });
    if (forecastHidden && via !== "pointer") return;
    if (selectedTile && targets.has(key)) {
      if (activeTargetHex !== key) {
        lockedAt.current = performance.now();
        dispatchSelection({ type: "target", hex: key, movable: maxMovable });
      } else if (!forecastHidden && (via === "enter" || (via === "pointer" && performance.now() - lockedAt.current >= 400))) {
        void executeOrder("march");
      }
      return;
    }
    dispatchSelection(selectedHex === key ? { type: "deselect" } : { type: "select", hex: key, units: tile.units ?? 1 });
  };

  const handleCopySeatKey = async (keyText: string) => {
    const ok = await copyText(keyText, "seat-key-value");
    setSeatKeyFeedback(ok ? "Copied to clipboard" : "Selected. Press Ctrl+C or Cmd+C to copy.");
  };

  const handleCopyJoinCode = async (code: string, fallbackInputId: string) => {
    const ok = await copyText(code, fallbackInputId);
    setCodeCopied(ok);
    if (!ok) showToast(`Selected. Press Ctrl+C or Cmd+C to copy the join code ${code}.`);
  };

  const modalOpen = inviteOpen || rulesOpen || resignOpen;
  const blocked = submitMove.uncertain;
  const canEndTurn = isMyTurn && !blocked;
  const dockCardVisible = !replayOpen && inspectTile !== null && !drawerOpen && !(compact && board?.game.status === "finished");

  useEffect(() => {
    keyHandlerRef.current = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (modalOpen || lobbyVisible || handoffActive || isTypingTarget(event.target)) return;
      const onControl = event.target instanceof HTMLElement && event.target.closest("button, [role='button'], input, a");
      const key = event.key;
      if (event.repeat && key !== "ArrowLeft" && key !== "ArrowRight") return;
      if (key === "Escape") {
        if (drawerOpen) setDrawerOpen(false);
        else if (activeTargetHex) dispatchSelection({ type: "untarget" });
        else if (selectedHex) dispatchSelection({ type: "deselect" });
        else return;
        event.preventDefault();
        return;
      }
      if (replayOpen) {
        if (key === "ArrowLeft" || key === "ArrowRight") {
          if (event.target instanceof HTMLInputElement) return;
          event.preventDefault();
          replay.goTo(replayStep + (key === "ArrowLeft" ? -1 : 1));
          return;
        }
        if (key === " " && !onControl) {
          event.preventDefault();
          replay.togglePlay();
          return;
        }
      }
      if ((key === "e" || key === "E") && canEndTurn && !submitMove.pending && !activeTargetHex) {
        event.preventDefault();
        void executeOrder("pass");
        return;
      }
      if (key === "r" || key === "R") {
        event.preventDefault();
        setDrawerOpen((open) => !open);
        return;
      }
      if (key === "?") {
        event.preventDefault();
        setRulesOpen(true);
        return;
      }
      if ((key === "1" || key === "2") && canSwitchSeat) {
        event.preventDefault();
        switchSeat(key === "1" ? 1 : 2);
      }
    };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => keyHandlerRef.current(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const winnerName = board?.game.winnerSeat
    ? (board.players.find((p) => p.seat === board.game.winnerSeat)?.name ?? factionName(board.game.winnerSeat))
    : null;
  const replayChart = useMemo(() => {
    if (replayFrames.length === 0) return null;
    const p1 = replayData?.players.find((p) => p.seat === 1)?.name ?? "Crimson";
    const p2 = replayData?.players.find((p) => p.seat === 2)?.name ?? "Cobalt";
    return {
      labels: replayFrames.map((f) => (f.move ? String(f.move.turnNumber) : "0")),
      series: [
        { name: p1, values: replayFrames.map((f) => f.seat1Units), color: "var(--hc-p1)" },
        { name: p2, values: replayFrames.map((f) => f.seat2Units), color: "var(--hc-p2)" },
      ],
    };
  }, [replayData?.players, replayFrames]);

  const errorToast = (() => {
    if (startDemo.uncertain && !lobbyVisible)
      return { title: "dohc could not confirm the demo match", id: "retry-demo-btn", retry: () => handleRetry("demo"), discard: startDemo.discardPending, pending: startDemo.pending };
    if (createGame.uncertain && !lobbyVisible)
      return { title: "dohc could not confirm the new match", id: "retry-create-banner-btn", retry: () => handleRetry("create"), discard: createGame.discardPending, pending: createGame.pending };
    if (joinGame.uncertain && !lobbyVisible)
      return { title: "dohc could not confirm your seat", id: "retry-join-banner-btn", retry: () => handleRetry("join"), discard: joinGame.discardPending, pending: joinGame.pending };
    if (submitMove.uncertain)
      return { title: "dohc could not confirm your order", id: "retry-move-btn", retry: () => handleRetry("move"), discard: submitMove.discardPending, pending: submitMove.pending };
    if (submitMove.error) return { title: "Order refused", detail: submitMove.error.message };
    if (boardQuery.error && activeGameId) return { title: "dohc could not load the board", detail: boardQuery.error.message, id: "reload-board-btn", retry: reloadBoard };
    if (replay.error) return { title: "dohc could not load the replay", detail: replay.error };
    return null;
  })();

  const turnSeat = board?.game.status === "active" ? board.game.activeSeat : null;
  const turnName = turnSeat ? (board?.players.find((p) => p.seat === turnSeat)?.name ?? factionName(turnSeat)) : null;
  const phase = !board
    ? "loading"
    : replayOpen
      ? "replay"
      : board.game.status === "finished"
        ? "finished"
        : board.game.status === "waiting"
          ? "waiting"
          : isMyTurn
            ? "my-turn"
            : "their-turn";
  if (phase !== "loading" && phase !== settledPhase) setSettledPhase(phase);

  return (
    <div className="hc-app" data-phase={phase === "loading" ? settledPhase : phase} data-turn-seat={turnSeat ?? 0}>
      {activeGameId ? (
        <div className="hc-game" inert={lobbyVisible || handoffActive}>
          <header className="hc-hud" data-testid="turn-banner">
            <div className="hc-hud-group hc-hud-left">
              <button
                type="button"
                id="open-lobby-btn"
                className="hc-icon-btn"
                aria-label="Game menu"
                title="Game menu"
                onClick={() => {
                  setLobbyPanel(null);
                  setLobbyOpen(true);
                }}
              >
                <Menu size={17} aria-hidden="true" />
              </button>
              <HexLogo size={24} />
              <span className="hc-hud-title" title={board?.game.title}>
                {board?.game.title ?? "Loading match"}
              </span>
            </div>

            <div className="hc-hud-group hc-hud-center" aria-live="polite">
              {board ? (
                replayOpen ? (
                  <span className="hc-turn-chip hc-turn-chip-replay">Replay</span>
                ) : board.game.status === "finished" ? (
                  <span className="hc-turn-chip">
                    <span className="hc-turn-label">Final turn</span>
                    <span className="hc-num">{board.game.turnNumber}</span>
                  </span>
                ) : board.game.status === "waiting" ? (
                  <span className="hc-turn-chip">
                    <LoaderCircle size={13} className="hc-spin" aria-hidden="true" />
                    Waiting for player 2
                  </span>
                ) : (
                  <>
                    <span className="hc-turn-chip" title="Turn">
                      <span className="hc-turn-label">Turn</span>
                      <span className="hc-num">{board.game.turnNumber}</span>
                    </span>
                    <span
                      className={`hc-faction-banner hc-faction-banner-${turnSeat}`}
                      id="turn-indicator"
                      title={isMyTurn && !isPassAndPlay ? undefined : `${turnName} to move`}
                    >
                      <FactionCrest seat={turnSeat} size={16} />
                      {isMyTurn && !isPassAndPlay ? (
                        "Your move"
                      ) : (
                        <span className="hc-name-line">
                          <span className="hc-name">{turnName}</span>
                          <span className="hc-name-fixed"> to move</span>
                        </span>
                      )}
                    </span>
                  </>
                )
              ) : null}
            </div>

            <div className="hc-hud-group hc-hud-right">
              {currentPlayer && !replayOpen && board?.game.status !== "finished" ? (
                <span className="hc-stats">
                  <span className="hc-stat" title={`Gold. Recruits cost ${REINFORCE_UNIT_COST} each, a fort costs 3.`}>
                    <CoinGlyph size={16} />
                    <span className="hc-num" id="hud-gold">
                      {gold}
                    </span>
                    <span className="hc-sr">gold</span>
                  </span>
                  <span className="hc-stat" title="Units you command">
                    <UnitGlyph seat={viewerSeat} size={15} />
                    <span className="hc-num">{currentPlayer.unitCount ?? 0}</span>
                    <span className="hc-sr">units</span>
                  </span>
                  <span className="hc-stat" title="Hexes you hold">
                    <HexGlyph seat={viewerSeat} size={15} />
                    <span className="hc-num">{currentPlayer.tileCount ?? 0}</span>
                    <span className="hc-sr">hexes</span>
                  </span>
                </span>
              ) : null}
              {canSwitchSeat && activeSession ? (
                <div className="hc-seats" role="group" aria-label="Seat on this device">
                  {([1, 2] as const).map((seat) => {
                    const pressed = !replayOpen && !spectatorMode && activeSession.activeSeat === seat;
                    return (
                      <button
                        key={seat}
                        type="button"
                        id={`seat-switch-${seat}`}
                        className="hc-seat"
                        aria-pressed={pressed}
                        title={`View as ${factionName(seat)} (${seat})`}
                        onClick={() => switchSeat(seat)}
                      >
                        <SwapGlyph />
                        <FactionCrest seat={seat} size={14} />
                        <span className="hc-seat-name">{activeSession.seats.find((s) => s.seat === seat)?.name ?? factionName(seat)}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {activeSeatKey && board?.game.status !== "finished" ? (
                <button
                  type="button"
                  id="open-seat-key-btn"
                  className="hc-icon-btn"
                  aria-label="Invite and seat key"
                  title="Invite and seat key"
                  onClick={() => {
                    setSeatKeyFeedback(null);
                    setCodeCopied(false);
                    setInviteOpen(true);
                  }}
                >
                  <Share2 size={16} aria-hidden="true" />
                </button>
              ) : null}
              <button
                type="button"
                id="log-toggle-btn"
                className="hc-icon-btn"
                aria-label="Battle log"
                aria-expanded={drawerOpen}
                title="Battle log (R)"
                onClick={() => setDrawerOpen((open) => !open)}
              >
                <List size={16} aria-hidden="true" />
              </button>
              <button type="button" id="rules-btn" className="hc-icon-btn" aria-label="Rules and keys" title="Rules and keys (?)" onClick={() => setRulesOpen(true)}>
                <CircleHelp size={16} aria-hidden="true" />
              </button>
              {activeSeatCredential && board?.game.status === "active" && !replayOpen ? (
                <button
                  type="button"
                  id="order-resign-btn"
                  className="hc-icon-btn"
                  aria-label="Resign match"
                  title="Resign match"
                  disabled={submitMove.pending || blocked}
                  onClick={() => setResignOpen(true)}
                >
                  <Flag size={16} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </header>

          <main className="hc-stage" data-drawer={drawerOpen ? "open" : "closed"}>
            {board ? (
              <HexBoard
                tiles={displayedTiles}
                viewerSeat={viewerSeat}
                interactive={boardInteractive}
                canAct={isMyTurn}
                selectedHex={selectedHex}
                targetHex={activeTargetHex}
                cursorHex={cursorHex}
                targets={targets}
                lastMove={
                  shownLogPreview
                    ? {
                        fromHex: shownLogPreview.fromHex,
                        toHex: shownLogPreview.toHex,
                        seat: shownLogPreview.actorSeat,
                        token: -shownLogPreview.turnNumber,
                      }
                    : lastMoveForBoard
                }
                highlightHexes={shownLogPreview ? [shownLogPreview.fromHex, shownLogPreview.toHex].filter((hex) => hex !== null) : []}
                forecast={boardForecast}
                flash={flash && flash.scope === (replayOpen ? `replay:${activeGameId}` : liveFlashScope(board)) ? flash : null}
                onActivate={handleActivate}
                onHover={(hex) => dispatchSelection({ type: "hover", hex })}
                onCursor={(hex) => dispatchSelection({ type: "focus", hex })}
              />
            ) : boardQuery.error ? null : (
              <div className="hc-board-loading" aria-busy="true" aria-label="Loading board">
                <HexLogo size={48} />
              </div>
            )}

            {banner ? <TurnBanner seat={banner.seat} turn={banner.turn} label={banner.label} token={banner.token} /> : null}

            {board && board.game.status === "waiting" && visibleJoinCode ? (
              <div className="hc-waiting" role="status">
                <span className="hc-section-label">Join code</span>
                <span className="hc-code">
                  <input
                    id="waiting-code-value"
                    className="hc-code-text"
                    value={visibleJoinCode}
                    style={{ width: `calc(${visibleJoinCode.length} * (1ch + 0.18em))` }}
                    readOnly
                    aria-label="Join code"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <button
                    type="button"
                    className="hc-icon-btn"
                    id="waiting-code-btn"
                    aria-label="Copy join code"
                    title="Copy join code"
                    onClick={() => void handleCopyJoinCode(visibleJoinCode, "waiting-code-value")}
                  >
                    <Copy size={15} aria-hidden="true" />
                  </button>
                </span>
                <span className="hc-waiting-sub">{codeCopied ? "Copied. Send it to player 2." : "Player 2 enters this code under Join with a code."}</span>
              </div>
            ) : null}
          </main>

          <footer className="hc-dock" ref={observeDock}>
            <div className="hc-dock-left">
              {replayOpen && replayFrames.length > 0 ? (
                <ReplayDock
                  frames={replayFrames}
                  step={replayStep}
                  playing={replay.playing}
                  onStep={replay.goTo}
                  onTogglePlay={replay.togglePlay}
                  onExit={closeReplay}
                />
              ) : dockCardVisible ? (
                <div className="hc-dock-stack">
                {previewCard}
                <TacticalCard
                  tile={inspectTile}
                  viewerSeat={viewerSeat}
                  canOrder={isMyTurn && inspectHex === selectedHex}
                  gold={gold}
                  pending={submitMove.pending}
                  blocked={blocked}
                  target={targetTile}
                  forecast={targetForecast}
                  marchUnits={Math.min(marchUnits, Math.max(1, maxMovable))}
                  maxMovable={maxMovable}
                  reinforceUnits={reinforceUnits}
                  maxReinforce={maxReinforce}
                  onMarchUnits={(units) => dispatchSelection({ type: "marchUnits", units })}
                  onReinforceUnits={(units) => dispatchSelection({ type: "reinforceUnits", units })}
                  onMarch={() => void executeOrder("march")}
                  onFortify={() => void executeOrder("fortify")}
                  onReinforce={() => void executeOrder("reinforce")}
                  onClose={inspectHex === selectedHex ? () => dispatchSelection({ type: "deselect" }) : undefined}
                />
                </div>
              ) : null}
            </div>
            <div className="hc-dock-right">
              {board?.game.status === "active" && !replayOpen && activeSeatCredential ? (
                <button
                  type="button"
                  id="end-turn-btn"
                  className="hc-end-turn"
                  data-ready={canEndTurn ? "true" : "false"}
                  data-quiet={canEndTurn && activeTargetHex ? "true" : undefined}
                  disabled={!canEndTurn || submitMove.pending || activeTargetHex !== null}
                  aria-keyshortcuts={canEndTurn && !activeTargetHex && !submitMove.pending ? "E" : undefined}
                  onClick={() => void executeOrder("pass")}
                >
                  {canEndTurn ? (
                    <>
                      <span className="hc-end-turn-label">{submitMove.pending ? "Sending" : "End turn"}</span>
                      <span className="hc-end-turn-sub">
                        <span className="hc-order-dot" aria-hidden="true" />
                        {activeTargetHex ? "Send or cancel the order" : submitMove.pending ? "1 order left" : <>1 order left <Kbd>E</Kbd></>}
                      </span>
                    </>
                  ) : isMyTurn ? (
                    <>
                      <span className="hc-end-turn-label">
                        <TriangleAlert size={15} aria-hidden="true" />
                        Order unconfirmed
                      </span>
                      <span className="hc-end-turn-sub">Try again or discard it in the notice</span>
                    </>
                  ) : (
                    <>
                      <span className="hc-end-turn-label">
                        <LoaderCircle size={15} className="hc-spin" aria-hidden="true" />
                        <span className="hc-name-line" title={`Waiting for ${turnName}`}>
                          <span className="hc-name-fixed">Waiting for </span>
                          <span className="hc-name">{turnName}</span>
                        </span>
                      </span>
                      <span className="hc-end-turn-sub">Their turn</span>
                    </>
                  )}
                </button>
              ) : board && board.game.status === "finished" && !replayOpen ? (
                <div className="hc-victory" role="status">
                  <FactionCrest seat={board.game.winnerSeat} size={34} />
                  <div className="hc-victory-text">
                    <strong>{winnerName} wins</strong>
                    <span>
                      {formatWinReason(
                        board.game.winReason,
                        board.players.find((p) => p.seat !== board.game.winnerSeat)?.name ?? factionName(board.game.winnerSeat === 1 ? 2 : 1),
                      )}{" "}
                      on turn {board.game.turnNumber}
                    </span>
                  </div>
                  <div className="hc-victory-actions">
                    <Button id="replay-toggle-btn" variant="primary" loading={replay.loading} onClick={() => void openReplay(board.game.id)}>
                      Watch replay
                    </Button>
                    <Button
                      onClick={() => {
                        setLobbyPanel(null);
                        setLobbyOpen(true);
                      }}
                    >
                      New match
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </footer>

          <LogDrawer
            open={drawerOpen}
            compact={compact}
            moves={board?.recentMoves ?? []}
            replay={
              replayOpen && replayFrames.length > 0
                ? {
                    frames: replayFrames,
                    step: replayStep,
                    onStep: replay.goTo,
                    chart: replayChart,
                    names: [
                      replayData?.players.find((p) => p.seat === 1)?.name ?? "Crimson",
                      replayData?.players.find((p) => p.seat === 2)?.name ?? "Cobalt",
                    ],
                  }
                : null
            }
            replayLocked={board?.game.status !== "finished"}
            onClose={() => setDrawerOpen(false)}
            onPreviewMove={setLogPreviewTurn}
            pinnedTurn={logPinnedTurn}
            onPinMove={setLogPinnedTurn}
          />
        </div>
      ) : null}

      {handoffActive && handoff ? (
        <HandoffCover
          seat={handoff.seat}
          turn={handoff.turn}
          name={handoffName}
          previousName={board?.players.find((p) => p.seat !== handoff.seat)?.name ?? factionName(handoff.seat === 1 ? 2 : 1)}
          ready={handoffReady}
          onReady={dismissHandoff}
        />
      ) : null}

      {lobbyVisible ? (
        <Lobby
          overlay={Boolean(activeGameId)}
          onClose={() => {
            navigationSeq.current += 1;
            cancelPendingResume();
            setLobbyOpen(false);
          }}
          panel={lobbyPanel}
          onPanel={(panel) => {
            if (panel !== "resume") cancelPendingResume();
            setLobbyPanel(panel);
            if (panel === "resume") setResumeError(null);
          }}
          demo={{
            pending: startDemo.pending,
            uncertain: startDemo.uncertain,
            error: startDemo.error,
            discard: startDemo.discardPending,
            start: () => void handleStartDemo(),
          }}
          create={{
            pending: createGame.pending,
            uncertain: createGame.uncertain,
            error: createGame.error,
            discard: createGame.discardPending,
            submit: (values) => void handleCreateGame(values),
          }}
          join={{
            pending: joinGame.pending,
            uncertain: joinGame.uncertain,
            error: joinGame.error,
            discard: joinGame.discardPending,
            submit: (values) => void handleJoinGame(values),
          }}
          resume={{
            pending: resumePending,
            error: resumeError,
            submit: (seatKey) => void handleResumeSeat(seatKey),
          }}
          games={games}
          gamesLoading={gamesQuery.loading}
          gamesError={gamesQuery.error?.message ?? null}
          reloadGames={reloadGames}
          seatedGameIds={new Set(Object.keys(sessions))}
          activeGameId={activeGameId}
          onOpenGame={(gameId) => enterGame(gameId, false)}
          onWatchGame={(gameId) => {
            enterGame(gameId, !sessions[gameId]);
            void openReplay(gameId);
          }}
        />
      ) : null}

      <div className="hc-toasts" aria-live="polite" ref={observeToasts}>
        {errorToast ? (
          <div className="hc-toast hc-toast-error" role="alert">
            <TriangleAlert size={16} aria-hidden="true" />
            <div className="hc-toast-body">
              <strong>{errorToast.title}</strong>
              {"detail" in errorToast && errorToast.detail ? <span>{errorToast.detail}</span> : null}
            </div>
            {"retry" in errorToast && errorToast.retry ? (
              <Button id={errorToast.id} size="sm" loading={"pending" in errorToast ? errorToast.pending : false} onClick={() => void errorToast.retry()}>
                Try again
              </Button>
            ) : null}
            {"discard" in errorToast && errorToast.discard ? (
              <Button size="sm" variant="ghost" disabled={errorToast.pending} onClick={errorToast.discard}>
                Discard
              </Button>
            ) : null}
          </div>
        ) : null}
        {toast && !errorToast ? (
          <div key={toast.id} className="hc-toast" id="board-status">
            {toast.text}
          </div>
        ) : null}
      </div>

      <Modal open={inviteOpen} title={board?.game.status === "waiting" ? "Invite player 2" : "Seat key"} onClose={() => setInviteOpen(false)}>
        <div className="hc-invite">
          {visibleJoinCode && board?.game.status === "waiting" ? (
            <div className="hc-invite-block">
              <span className="hc-section-label">Join code</span>
              <div className="hc-copy-row">
                <input id="join-code-value" className="hc-code-field" value={visibleJoinCode} readOnly aria-label="Join code" onFocus={(event) => event.currentTarget.select()} />
                <Button id="copy-join-code-btn" onClick={() => void handleCopyJoinCode(visibleJoinCode, "join-code-value")}>
                  <Copy size={14} aria-hidden="true" />
                  {codeCopied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          ) : null}
          <div className="hc-invite-block">
            <span className="hc-section-label">
              Your seat key{activeSeatCredential ? `, ${activeSeatCredential.name}` : ""}
            </span>
            <div className="hc-copy-row">
              <input
                id="seat-key-value"
                className="kit-input hc-mono"
                value={activeSeatKey ?? ""}
                readOnly
                aria-label="Seat key"
                onFocus={(event) => event.currentTarget.select()}
              />
              {activeSeatKey ? (
                <Button id="copy-seat-key-btn" variant="primary" onClick={() => void handleCopySeatKey(activeSeatKey)}>
                  <Copy size={14} aria-hidden="true" />
                  Copy
                </Button>
              ) : null}
            </div>
            <p className="hc-invite-note" id="seat-key-feedback" role="status">
              {seatKeyFeedback ?? "Anyone with this key can play your seat. Use it to come back after closing the app."}
            </p>
          </div>
        </div>
      </Modal>

      <Modal open={rulesOpen} title="How to play" onClose={() => setRulesOpen(false)}>
        <RulesSheet />
      </Modal>

      <Modal
        open={resignOpen && board?.game.status === "active"}
        title={`Resign as ${board?.players.find((p) => p.seat === viewerSeat)?.name ?? factionName(viewerSeat)}?`}
        onClose={() => {
          if (!submitMove.pending) setResignOpen(false);
        }}
      >
        <p className="hc-modal-text">{board?.players.find((p) => p.seat !== viewerSeat)?.name ?? "Your opponent"} wins right away. This cannot be undone.</p>
        {submitMove.error || submitMove.uncertain ? (
          <p className="hc-field-error" role="alert">
            {submitMove.uncertain ? "dohc could not confirm the resignation. Try again to check." : submitMove.error?.message}
          </p>
        ) : null}
        <div className="hc-modal-actions">
          <Button id="cancel-resign-btn" disabled={submitMove.pending} onClick={() => setResignOpen(false)}>
            Keep playing
          </Button>
          <Button
            id="confirm-resign-btn"
            variant="danger"
            loading={submitMove.pending}
            onClick={() => void (submitMove.uncertain ? handleRetry("move") : executeOrder("resign"))}
          >
            {submitMove.uncertain ? "Try again" : "Resign"}
          </Button>
        </div>
      </Modal>
    </div>
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
