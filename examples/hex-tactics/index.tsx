import "./styles.css";
import { useCallback, useEffect, useEffectEvent, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, copyText, useApp, useDatasetMutation, useDatasetQuery } from "dohc/app";
import { Modal } from "dohc/ui";
import { Copy } from "dohc/icons";
import { HexLogo } from "./board-art";
import { InviteDialog, Notices, ResignDialog, type Notice } from "./dialogs";
import { EndTurnButton, VictoryCard } from "./dock";
import { axialDistance, hexKeyOf } from "./geometry";
import { HexBoard, type BoardFlash, type BoardForecast, type TargetKind } from "./hex-board";
import { Hud } from "./hud";
import { Lobby, type LobbyPanel } from "./lobby";
import { CombatPreview, HandoffCover, LogDrawer, ReplayDock, RulesSheet, TacticalCard, TurnBanner } from "./panels";
import { flashKindForMove, forecastLabel, forecastMarch, isClaim, maxReinforce as maxReinforceFor, otherSeat, playerName } from "./rules";
import { NO_SELECTION, selectionReducer } from "./selection";
import { type StoredMatchSession, withJoinedSeat } from "./sessions";
import type {
  ActionType,
  CreateGameReply,
  GameSummary,
  JoinGameReply,
  MoveRecord,
  SeatCredential,
  StartDemoReply,
  SubmitMoveReply,
  VisibleBoardState,
  VisibleTile,
} from "./types";
import { useReplay } from "./use-replay";

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

type Settled<T> = { readonly result: T } | null;

const REMOTE_POLL_MS = 4000;
const SECOND_TAP_GUARD_MS = 400;
const COMPACT_QUERY = "(max-width: 899px), (max-height: 520px)";

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

function useBoardQuery(gameId: string | null, playerToken: string | undefined, spectator: boolean) {
  const input = useMemo(() => {
    if (!gameId) return undefined;
    if (spectator) return { gameId, spectator: true };
    return playerToken ? { gameId, playerToken } : undefined;
  }, [gameId, playerToken, spectator]);
  return useDatasetQuery<VisibleBoardState>("getVisibleState", input, { enabled: Boolean(input) });
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
const observeNotices = observeHeight("--hc-toasts-h");

function formatSeatKey(gameId: string, playerToken: string): string {
  return `HC1:${gameId}:${playerToken}`;
}

function parseSeatKey(raw: string): { gameId: string; playerToken: string } | null {
  const match = /^HC1:([A-Za-z0-9_-]{3,128}):([a-f0-9]{64})$/.exec(raw.trim());
  if (!match) return null;
  return { gameId: match[1]!, playerToken: match[2]! };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function liveFlashScope(board: VisibleBoardState): string {
  return `${board.game.id}:${board.viewer.seat ?? "spectator"}`;
}

function flashFor(move: MoveRecord | null | undefined, scope: string): BoardFlash | null {
  const kind = move ? flashKindForMove(move) : null;
  const hex = move ? (move.toHex ?? move.fromHex) : null;
  return move && kind && hex ? { hex, kind, token: move.turnNumber, scope } : null;
}

async function copyOrSelect(text: string, fieldId: string): Promise<boolean> {
  try {
    await copyText(text);
    return true;
  } catch {
    const field = document.getElementById(fieldId);
    if (field instanceof HTMLInputElement) {
      field.focus();
      field.select();
    }
    return false;
  }
}

export function HexClashApp() {
  const client = useApp();
  const compact = useMediaQuery(COMPACT_QUERY);
  const gamesQuery = useDatasetQuery<{ games: GameSummary[] }>("listGames", {});
  const startDemo = useDatasetMutation<{ player1Name?: string; player2Name?: string; seed?: number }, StartDemoReply>("startDemoMatch");
  const createGame = useDatasetMutation<{ title?: string; playerName?: string }, CreateGameReply>("createGame");
  const joinGame = useDatasetMutation<{ joinCode: string; playerName?: string }, JoinGameReply>("joinGame");
  const submitMove = useDatasetMutation<MovePayload, SubmitMoveReply>("submitMove");
  const discardPendingOrder = submitMove.discardPending;

  const [sessions, setSessions] = useState<Record<string, StoredMatchSession>>({});
  const [activeGameId, setActiveGameId] = useState<string | null>(null);
  const activeGameIdRef = useRef<string | null>(null);
  activeGameIdRef.current = activeGameId;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [spectatorMode, setSpectatorMode] = useState(false);
  const [settledPhase, setSettledPhase] = useState("loading");

  const [selection, dispatchSelection] = useReducer(selectionReducer, NO_SELECTION);
  const { selectedHex, targetHex, hoverHex, cursorHex, marchUnits, reinforceUnits } = selection;
  const lockedAt = useRef(0);
  const [toast, setToast] = useState<{ readonly id: number; readonly text: string } | null>(null);
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

  const switchSeat = (seat: 1 | 2) => {
    if (!activeSession || !canSwitchSeat) return;
    closeReplay();
    updateSession({ ...activeSession, activeSeat: seat });
    resetBoardView();
    setSpectatorMode(false);
  };

  const pollRemote =
    !liveEvents && Boolean(board) && !replayOpen && board?.game.status !== "finished" && (board?.game.status === "waiting" || !isPassAndPlay);
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
  const tileByKey = useMemo(() => new Map(displayedTiles.map((tile) => [hexKeyOf(tile.q, tile.r), tile])), [displayedTiles]);

  const viewerSeat = replayOpen ? null : (board?.viewer.seat ?? null);
  const isMyTurn = Boolean(
    !replayOpen && board && board.game.status === "active" && viewerSeat !== null && board.game.activeSeat === viewerSeat && activeSeatCredential,
  );
  const selectedTile = selectedHex ? (tileByKey.get(selectedHex) ?? null) : null;
  const gold = board?.players.find((p) => p.seat === viewerSeat)?.gold ?? 0;

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
  const lockedUnits = Math.min(marchUnits, maxMovable);
  const maxReinforce = maxReinforceFor(gold);

  const previewHex = activeTargetHex ?? [hoverHex, cursorHex].find((hex) => hex !== null && targets.has(hex)) ?? null;
  const previewShown = previewHex !== null && (!compact || previewHex === activeTargetHex);
  const previewTile = previewHex ? (tileByKey.get(previewHex) ?? null) : null;
  const previewUnits = previewHex === activeTargetHex ? lockedUnits : maxMovable;
  const previewForecast = previewTile && viewerSeat !== null && previewUnits > 0 ? forecastMarch(previewUnits, previewTile, viewerSeat) : null;
  const targetForecast = targetTile && viewerSeat !== null && maxMovable > 0 ? forecastMarch(lockedUnits, targetTile, viewerSeat) : null;

  const boardForecast: BoardForecast | null = (() => {
    if (!previewShown || !previewForecast || !previewHex || !selectedHex) return null;
    const claim = targets.get(previewHex) === "claim";
    const transfer = previewForecast.kind === "transfer";
    return {
      fromHex: selectedHex,
      toHex: previewHex,
      tone: transfer ? "move" : claim ? "claim" : previewForecast.kind,
      label: forecastLabel(previewForecast, claim),
      leaving: previewForecast.attackerUnits,
      defenderLoss: transfer ? 0 : previewForecast.defenderLosses,
      gain: transfer ? previewForecast.attackerUnits : 0,
    };
  })();

  const boardInteractive = !replayOpen && !(compact && board?.game.status === "finished");
  const hoverInspectable =
    hoverHex && !compact && !replayOpen && board?.game.status !== "finished" && tileByKey.get(hoverHex)?.visible ? hoverHex : null;
  const inspectHex = selectedHex ?? hoverInspectable;
  const inspectTile = inspectHex ? (tileByKey.get(inspectHex) ?? null) : null;

  const latestMove = board?.recentMoves[0] ?? null;
  const lastMoveForBoard = useMemo(() => {
    const move = activeReplayFrame ? activeReplayFrame.move : latestMove?.hidden ? null : latestMove;
    return move ? { fromHex: move.fromHex, toHex: move.toHex, seat: move.actorSeat, token: move.turnNumber } : null;
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
    const label = !isPassAndPlay && viewerSeat === seat ? "Your turn" : playerName(board.players, seat);
    setBanner({ seat, turn: board.game.turnNumber, label, token: Date.now() });
  }, [board, isPassAndPlay, viewerSeat]);

  useEffect(() => {
    if (!banner) return;
    const timer = window.setTimeout(() => setBanner(null), 1500);
    return () => window.clearTimeout(timer);
  }, [banner]);

  const handoffActive = handoff !== null && handoff.gameId === activeGameId && board?.game.status !== "finished" && !replayOpen;
  const handoffReady = handoffActive && board !== null && board.viewer.seat === handoff.seat && board.game.turnNumber >= handoff.turn;
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
    if (!board) return;
    const move = board.recentMoves[0];
    const key = `${board.game.id}:${move?.turnNumber ?? "none"}`;
    const previous = lastMoveTurnRef.current;
    lastMoveTurnRef.current = key;
    if (previous === null || previous === key || !previous.startsWith(`${board.game.id}:`)) return;
    const next = flashFor(move, liveFlashScope(board));
    if (next) setFlash(next);
  }, [board]);

  useEffect(() => {
    if (!replayOpen) return;
    const next = flashFor(activeReplayFrame?.move, `replay:${activeGameId}`);
    if (next) setFlash(next);
  }, [activeReplayFrame, activeGameId, replayOpen]);

  const activeSeatKey = activeGameId && activeSeatCredential ? formatSeatKey(activeGameId, activeSeatCredential.playerToken) : null;
  const visibleJoinCode = board?.game.joinCode ?? activeSession?.joinCode ?? null;

  const settle = async <T,>(run: () => Promise<Settled<T>>, apply: (result: T, navigation: number) => void) => {
    const navigation = navigationSeq.current;
    try {
      const reply = await run();
      if (reply) apply(reply.result, navigation);
    } catch {
      return;
    }
  };

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
    const { game } = result.state;
    if (game.status === "active") {
      setSessions((prev) => {
        const current = prev[game.id];
        if (!current || current.seats.length !== 2) return prev;
        return { ...prev, [game.id]: { ...current, activeSeat: game.activeSeat } };
      });
    }
    if (activeGameIdRef.current === game.id) {
      const passAndPlay = sessionsRef.current[game.id]?.seats.length === 2;
      resetBoardView();
      if (passAndPlay && game.status === "active") {
        setBanner(null);
        setHandoff({ gameId: game.id, seat: game.activeSeat, turn: game.turnNumber });
      }
      if (game.status !== "finished" && !passAndPlay) showToast(result.outcome.summary);
      reloadBoard();
    }
    reloadGames();
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
      const state = await client.read<VisibleBoardState>("getVisibleState", { gameId: parsed.gameId, playerToken: parsed.playerToken });
      if (resumeRequestSeq.current !== requestId) return;
      const seat = state.viewer.seat;
      if (seat === null) {
        setResumeError("That seat key does not match a seat in this match.");
        return;
      }
      const playerInfo = state.players.find((p) => p.seat === seat);
      const restored: SeatCredential = {
        seat,
        playerId: playerInfo?.id ?? `p${seat}_${parsed.gameId}`,
        name: playerName(state.players, seat),
        color: seat === 1 ? "crimson" : "cobalt",
        playerToken: parsed.playerToken,
      };
      setSessions((prev) => {
        const existing = prev[parsed.gameId];
        const seats = existing ? [...existing.seats.filter((s) => s.seat !== seat), restored] : [restored];
        return { ...prev, [parsed.gameId]: { gameId: parsed.gameId, joinCode: state.game.joinCode ?? null, seats, activeSeat: seat } };
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
      Object.assign(payload, { fromQ: selectedTile.q, fromR: selectedTile.r, toQ: targetTile.q, toR: targetTile.r, units: lockedUnits });
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
  const retryOrder = () => void settle(submitMove.retry, applyMoveResult);

  const openReplay = async (gameId: string) => {
    if (!(await replay.load(gameId))) return;
    dispatchSelection({ type: "deselect" });
    if (!compact) setDrawerOpen(true);
  };

  const openLobby = () => {
    setLobbyPanel(null);
    setLobbyOpen(true);
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
      } else if (!forecastHidden && (via === "enter" || (via === "pointer" && performance.now() - lockedAt.current >= SECOND_TAP_GUARD_MS))) {
        void executeOrder("march");
      }
      return;
    }
    dispatchSelection(selectedHex === key ? { type: "deselect" } : { type: "select", hex: key, units: tile.units ?? 1 });
  };

  const handleCopySeatKey = async (keyText: string) => {
    const ok = await copyOrSelect(keyText, "seat-key-value");
    setSeatKeyFeedback(ok ? "Copied to clipboard" : "Selected. Press Ctrl+C or Cmd+C to copy.");
  };

  const handleCopyJoinCode = async (code: string, fieldId: string) => {
    const ok = await copyOrSelect(code, fieldId);
    setCodeCopied(ok);
    if (!ok) showToast(`Selected. Press Ctrl+C or Cmd+C to copy the join code ${code}.`);
  };

  const modalOpen = inviteOpen || rulesOpen || resignOpen;
  const blocked = submitMove.uncertain;
  const canEndTurn = isMyTurn && !blocked && !submitMove.pending && !activeTargetHex;
  const dockCardVisible = !replayOpen && inspectTile !== null && !drawerOpen && !(compact && board?.game.status === "finished");

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
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
    if ((key === "e" || key === "E") && canEndTurn) {
      event.preventDefault();
      void executeOrder("pass");
    } else if (key === "r" || key === "R") {
      event.preventDefault();
      setDrawerOpen((open) => !open);
    } else if (key === "?") {
      event.preventDefault();
      setRulesOpen(true);
    } else if ((key === "1" || key === "2") && canSwitchSeat) {
      event.preventDefault();
      switchSeat(key === "1" ? 1 : 2);
    }
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const replayNames: readonly [string, string] = [playerName(replayData?.players, 1), playerName(replayData?.players, 2)];
  const replayChart = useMemo(() => {
    if (replayFrames.length === 0) return null;
    return {
      labels: replayFrames.map((f) => (f.move ? String(f.move.turnNumber) : "0")),
      series: [
        { name: replayNames[0], values: replayFrames.map((f) => f.seat1Units), color: "var(--hc-p1)" },
        { name: replayNames[1], values: replayFrames.map((f) => f.seat2Units), color: "var(--hc-p2)" },
      ],
    };
  }, [replayNames[0], replayNames[1], replayFrames]);

  const mutationNotice = <T,>(
    mutation: { readonly retry: () => Promise<Settled<T>>; readonly discardPending: () => void; readonly pending: boolean },
    title: string,
    retryId: string,
    apply: (result: T, navigation: number) => void,
  ): Notice => ({ title, retryId, retry: () => void settle(mutation.retry, apply), discard: mutation.discardPending, pending: mutation.pending });

  const notice: Notice | null = (() => {
    if (startDemo.uncertain && !lobbyVisible) return mutationNotice(startDemo, "dohc could not confirm the demo match", "retry-demo-btn", applyDemoResult);
    if (createGame.uncertain && !lobbyVisible) return mutationNotice(createGame, "dohc could not confirm the new match", "retry-create-banner-btn", applyCreateResult);
    if (joinGame.uncertain && !lobbyVisible) return mutationNotice(joinGame, "dohc could not confirm your seat", "retry-join-banner-btn", applyJoinResult);
    if (submitMove.uncertain) return mutationNotice(submitMove, "dohc could not confirm your order", "retry-move-btn", applyMoveResult);
    if (submitMove.error) return { title: "Order refused", detail: submitMove.error.message };
    if (boardQuery.error && activeGameId) return { title: "dohc could not load the board", detail: boardQuery.error.message, retryId: "reload-board-btn", retry: reloadBoard };
    if (replay.error) return { title: "dohc could not load the replay", detail: replay.error };
    return null;
  })();

  const turnSeat = board?.game.status === "active" ? board.game.activeSeat : null;
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
          <Hud
            board={board}
            replayOpen={replayOpen}
            yourMove={isMyTurn && !isPassAndPlay}
            viewerSeat={viewerSeat}
            seatSwitch={
              canSwitchSeat && activeSession
                ? { seats: activeSession.seats, pressed: replayOpen || spectatorMode ? null : activeSession.activeSeat }
                : null
            }
            canInvite={Boolean(activeSeatKey) && board?.game.status !== "finished"}
            canResign={Boolean(activeSeatCredential) && board?.game.status === "active" && !replayOpen}
            resignDisabled={submitMove.pending || blocked}
            logOpen={drawerOpen}
            onMenu={openLobby}
            onSwitchSeat={switchSeat}
            onInvite={() => {
              setSeatKeyFeedback(null);
              setCodeCopied(false);
              setInviteOpen(true);
            }}
            onToggleLog={() => setDrawerOpen((open) => !open)}
            onRules={() => setRulesOpen(true)}
            onResign={() => setResignOpen(true)}
          />

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
                    ? { fromHex: shownLogPreview.fromHex, toHex: shownLogPreview.toHex, seat: shownLogPreview.actorSeat, token: -shownLogPreview.turnNumber }
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

            {board?.game.status === "waiting" && visibleJoinCode ? (
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
                <ReplayDock frames={replayFrames} step={replayStep} playing={replay.playing} onStep={replay.goTo} onTogglePlay={replay.togglePlay} onExit={closeReplay} />
              ) : dockCardVisible ? (
                <div className="hc-dock-stack">
                  {previewShown && previewForecast && previewTile && viewerSeat !== null ? (
                    <CombatPreview
                      forecast={previewForecast}
                      attackerSeat={viewerSeat}
                      target={previewTile}
                      onClose={compact ? () => dispatchSelection({ type: "deselect" }) : undefined}
                    />
                  ) : null}
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
                <EndTurnButton
                  turn={!isMyTurn ? "theirs" : blocked ? "unconfirmed" : "yours"}
                  waitingFor={playerName(board.players, board.game.activeSeat)}
                  sending={submitMove.pending}
                  targetLocked={activeTargetHex !== null}
                  onEndTurn={() => void executeOrder("pass")}
                />
              ) : board?.game.status === "finished" && !replayOpen ? (
                <VictoryCard board={board} replayLoading={replay.loading} onReplay={() => void openReplay(board.game.id)} onNewMatch={openLobby} />
              ) : null}
            </div>
          </footer>

          <LogDrawer
            open={drawerOpen}
            compact={compact}
            moves={board?.recentMoves ?? []}
            replay={
              replayOpen && replayFrames.length > 0
                ? { frames: replayFrames, step: replayStep, onStep: replay.goTo, chart: replayChart, names: replayNames }
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

      {handoffActive ? (
        <HandoffCover
          seat={handoff.seat}
          turn={handoff.turn}
          name={playerName(board?.players, handoff.seat)}
          previousName={playerName(board?.players, otherSeat(handoff.seat))}
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
            start: () => void settle(() => (startDemo.uncertain ? startDemo.retry() : startDemo.mutate({})), applyDemoResult),
          }}
          create={{
            pending: createGame.pending,
            uncertain: createGame.uncertain,
            error: createGame.error,
            discard: createGame.discardPending,
            submit: ({ name, title }) =>
              void settle(
                () => (createGame.uncertain ? createGame.retry() : createGame.mutate({ title: title.trim() || undefined, playerName: name.trim() || "Crimson" })),
                applyCreateResult,
              ),
          }}
          join={{
            pending: joinGame.pending,
            uncertain: joinGame.uncertain,
            error: joinGame.error,
            discard: joinGame.discardPending,
            submit: ({ code, name }) =>
              void settle(
                () => (joinGame.uncertain ? joinGame.retry() : joinGame.mutate({ joinCode: code.trim().toUpperCase(), playerName: name.trim() || "Cobalt" })),
                applyJoinResult,
              ),
          }}
          resume={{ pending: resumePending, error: resumeError, submit: (seatKey) => void handleResumeSeat(seatKey) }}
          games={gamesQuery.data?.games ?? []}
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

      <Notices notice={notice} toast={notice ? null : toast} measure={observeNotices} />

      <InviteDialog
        open={inviteOpen}
        joinCode={board?.game.status === "waiting" ? visibleJoinCode : null}
        codeCopied={codeCopied}
        seatName={activeSeatCredential?.name ?? null}
        seatKey={activeSeatKey}
        seatKeyFeedback={seatKeyFeedback}
        onCopyJoinCode={(code) => void handleCopyJoinCode(code, "join-code-value")}
        onCopySeatKey={(key) => void handleCopySeatKey(key)}
        onClose={() => setInviteOpen(false)}
      />

      <Modal open={rulesOpen} title="How to play" onClose={() => setRulesOpen(false)}>
        <RulesSheet />
      </Modal>

      <ResignDialog
        open={resignOpen && board?.game.status === "active"}
        playerName={playerName(board?.players, viewerSeat)}
        opponentName={viewerSeat === null ? "Your opponent" : playerName(board?.players, otherSeat(viewerSeat))}
        pending={submitMove.pending}
        uncertain={submitMove.uncertain}
        error={submitMove.error?.message ?? null}
        onResign={() => (submitMove.uncertain ? retryOrder() : void executeOrder("resign"))}
        onClose={() => setResignOpen(false)}
      />
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
