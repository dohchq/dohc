import { Button } from "dohc/ui";
import { LoaderCircle, TriangleAlert } from "dohc/icons";
import { FactionCrest } from "./board-art";
import { Kbd } from "./panels";
import { otherSeat, playerName } from "./rules";
import type { VisibleBoardState } from "./types";

export interface EndTurnButtonProps {
  readonly turn: "yours" | "unconfirmed" | "theirs";
  readonly waitingFor: string;
  readonly sending: boolean;
  readonly targetLocked: boolean;
  readonly onEndTurn: () => void;
}

export function EndTurnButton({
  turn,
  waitingFor,
  sending,
  targetLocked,
  onEndTurn,
}: EndTurnButtonProps) {
  const ready = turn === "yours";
  const acts = ready && !sending && !targetLocked;
  return (
    <button
      type="button"
      id="end-turn-btn"
      className="hc-end-turn"
      data-ready={ready ? "true" : "false"}
      data-quiet={ready && targetLocked ? "true" : undefined}
      disabled={!acts}
      aria-keyshortcuts={acts ? "E" : undefined}
      onClick={onEndTurn}
    >
      {turn === "yours" ? (
        <>
          <span className="hc-end-turn-label">{sending ? "Sending" : "End turn"}</span>
          <span className="hc-end-turn-sub">
            <span className="hc-order-dot" aria-hidden="true" />
            {targetLocked ? (
              "Send or cancel the order"
            ) : sending ? (
              "1 order left"
            ) : (
              <>
                1 order left <Kbd>E</Kbd>
              </>
            )}
          </span>
        </>
      ) : turn === "unconfirmed" ? (
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
            <span className="hc-name-line" title={`Waiting for ${waitingFor}`}>
              <span className="hc-name-fixed">Waiting for </span>
              <span className="hc-name">{waitingFor}</span>
            </span>
          </span>
          <span className="hc-end-turn-sub">Their turn</span>
        </>
      )}
    </button>
  );
}

export interface VictoryCardProps {
  readonly board: VisibleBoardState;
  readonly replayLoading: boolean;
  readonly onReplay: () => void;
  readonly onNewMatch: () => void;
}

export function VictoryCard({ board, replayLoading, onReplay, onNewMatch }: VictoryCardProps) {
  const { winnerSeat, winReason, turnNumber } = board.game;
  const loser = playerName(board.players, winnerSeat === null ? null : otherSeat(winnerSeat));
  const reason =
    winReason === "capital_captured"
      ? `${loser}'s capital fell`
      : winReason === "resignation"
        ? `${loser} resigned`
        : "Match over";
  return (
    <div className="hc-victory" role="status">
      <FactionCrest seat={winnerSeat} size={34} />
      <div className="hc-victory-text">
        <strong>{playerName(board.players, winnerSeat)} wins</strong>
        <span>
          {reason} on turn {turnNumber}
        </span>
      </div>
      <div className="hc-victory-actions">
        <Button id="replay-toggle-btn" variant="primary" loading={replayLoading} onClick={onReplay}>
          Watch replay
        </Button>
        <Button onClick={onNewMatch}>New match</Button>
      </div>
    </div>
  );
}
