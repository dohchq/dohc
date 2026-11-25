import { CircleHelp, Flag, List, LoaderCircle, Menu, Share2 } from "dohc/icons";
import { CoinGlyph, FactionCrest, HexGlyph, HexLogo, SwapGlyph, UnitGlyph } from "./board-art";
import { FORTIFY_COST, REINFORCE_UNIT_COST, factionName, playerName } from "./rules";
import type { SeatCredential, VisibleBoardState } from "./types";

export interface HudProps {
  readonly board: VisibleBoardState | null;
  readonly replayOpen: boolean;
  readonly yourMove: boolean;
  readonly viewerSeat: 1 | 2 | null;
  readonly seatSwitch: {
    readonly seats: readonly SeatCredential[];
    readonly pressed: 1 | 2 | null;
    readonly disabled: boolean;
  } | null;
  readonly canInvite: boolean;
  readonly canResign: boolean;
  readonly resignDisabled: boolean;
  readonly logOpen: boolean;
  readonly onMenu: () => void;
  readonly onSwitchSeat: (seat: 1 | 2) => void;
  readonly onInvite: () => void;
  readonly onToggleLog: () => void;
  readonly onRules: () => void;
  readonly onResign: () => void;
}

export function Hud({
  board,
  replayOpen,
  yourMove,
  viewerSeat,
  seatSwitch,
  canInvite,
  canResign,
  resignDisabled,
  logOpen,
  onMenu,
  onSwitchSeat,
  onInvite,
  onToggleLog,
  onRules,
  onResign,
}: HudProps) {
  const status = board?.game.status;
  const viewer = viewerSeat === null ? null : (board?.players.find((p) => p.seat === viewerSeat) ?? null);
  return (
    <header className="hc-hud">
      <div className="hc-hud-group hc-hud-left">
        <button type="button" id="open-lobby-btn" className="hc-icon-btn" aria-label="Game menu" title="Game menu" onClick={onMenu}>
          <Menu size={17} aria-hidden="true" />
        </button>
        <HexLogo size={24} />
        <span className="hc-hud-title" title={board?.game.title}>
          {board?.game.title ?? "Loading match"}
        </span>
      </div>

      <div className="hc-hud-group hc-hud-center" aria-live="polite">
        {board ? <TurnStatus board={board} replayOpen={replayOpen} yourMove={yourMove} /> : null}
      </div>

      <div className="hc-hud-group hc-hud-right">
        {viewer && !replayOpen && status !== "finished" ? (
          <span className="hc-stats">
            <span className="hc-stat" title={`Gold. Recruits cost ${REINFORCE_UNIT_COST} each, a fort costs ${FORTIFY_COST}.`}>
              <CoinGlyph size={16} />
              <span className="hc-num" id="hud-gold">
                {viewer.gold ?? 0}
              </span>
              <span className="hc-sr">gold</span>
            </span>
            <span className="hc-stat" title="Units you command">
              <UnitGlyph seat={viewerSeat} size={15} />
              <span className="hc-num">{viewer.unitCount ?? 0}</span>
              <span className="hc-sr">units</span>
            </span>
            <span className="hc-stat" title="Hexes you hold">
              <HexGlyph seat={viewerSeat} size={15} />
              <span className="hc-num">{viewer.tileCount ?? 0}</span>
              <span className="hc-sr">hexes</span>
            </span>
          </span>
        ) : null}
        {seatSwitch ? (
          <div className="hc-seats" role="group" aria-label="Seat on this device">
            {([1, 2] as const).map((seat) => (
              <button
                key={seat}
                type="button"
                id={`seat-switch-${seat}`}
                className="hc-seat"
                aria-pressed={seatSwitch.pressed === seat}
                disabled={seatSwitch.disabled}
                title={`View as ${factionName(seat)} (${seat})`}
                onClick={() => onSwitchSeat(seat)}
              >
                <SwapGlyph />
                <FactionCrest seat={seat} size={14} />
                <span className="hc-seat-name">{playerName(seatSwitch.seats, seat)}</span>
              </button>
            ))}
          </div>
        ) : null}
        {canInvite ? (
          <button type="button" id="open-seat-key-btn" className="hc-icon-btn" aria-label="Invite and seat key" title="Invite and seat key" onClick={onInvite}>
            <Share2 size={16} aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          id="log-toggle-btn"
          className="hc-icon-btn"
          aria-label="Battle log"
          aria-expanded={logOpen}
          title="Battle log (R)"
          onClick={onToggleLog}
        >
          <List size={16} aria-hidden="true" />
        </button>
        <button type="button" id="rules-btn" className="hc-icon-btn" aria-label="Rules and keys" title="Rules and keys (?)" onClick={onRules}>
          <CircleHelp size={16} aria-hidden="true" />
        </button>
        {canResign ? (
          <button
            type="button"
            id="order-resign-btn"
            className="hc-icon-btn"
            aria-label="Resign match"
            title="Resign match"
            disabled={resignDisabled}
            onClick={onResign}
          >
            <Flag size={16} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </header>
  );
}

function TurnStatus({ board, replayOpen, yourMove }: { readonly board: VisibleBoardState; readonly replayOpen: boolean; readonly yourMove: boolean }) {
  const { status, turnNumber, activeSeat } = board.game;
  if (replayOpen) return <span className="hc-turn-chip hc-turn-chip-replay">Replay</span>;
  if (status === "finished") {
    return (
      <span className="hc-turn-chip">
        <span className="hc-turn-label">Final turn</span>
        <span className="hc-num">{turnNumber}</span>
      </span>
    );
  }
  if (status === "waiting") {
    return (
      <span className="hc-turn-chip">
        <LoaderCircle size={13} className="hc-spin" aria-hidden="true" />
        Waiting for player 2
      </span>
    );
  }
  const name = playerName(board.players, activeSeat);
  return (
    <>
      <span className="hc-turn-chip" title="Turn">
        <span className="hc-turn-label">Turn</span>
        <span className="hc-num">{turnNumber}</span>
      </span>
      <span className={`hc-faction-banner hc-faction-banner-${activeSeat}`} id="turn-indicator" title={yourMove ? undefined : `${name} to move`}>
        <FactionCrest seat={activeSeat} size={16} />
        {yourMove ? (
          "Your move"
        ) : (
          <span className="hc-name-line">
            <span className="hc-name">{name}</span>
            <span className="hc-name-fixed"> to move</span>
          </span>
        )}
      </span>
    </>
  );
}
