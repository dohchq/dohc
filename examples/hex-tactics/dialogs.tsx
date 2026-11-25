import { Button, Modal } from "dohc/ui";
import { Copy, TriangleAlert } from "dohc/icons";

export interface Notice {
  readonly title: string;
  readonly detail?: string;
  readonly retryId?: string;
  readonly retry?: () => void;
  readonly discard?: () => void;
  readonly pending?: boolean;
}

export interface NoticesProps {
  readonly notice: Notice | null;
  readonly toast: { readonly id: number; readonly text: string } | null;
  readonly measure: (element: HTMLElement | null) => void;
}

export function Notices({ notice, toast, measure }: NoticesProps) {
  return (
    <div className="hc-toasts" aria-live="polite" ref={measure}>
      {notice ? (
        <div className="hc-toast hc-toast-error" role="alert">
          <TriangleAlert size={16} aria-hidden="true" />
          <div className="hc-toast-body">
            <strong>{notice.title}</strong>
            {notice.detail ? <span>{notice.detail}</span> : null}
          </div>
          {notice.retry ? (
            <Button id={notice.retryId} size="sm" loading={notice.pending ?? false} onClick={notice.retry}>
              Try again
            </Button>
          ) : null}
          {notice.discard ? (
            <Button size="sm" variant="ghost" disabled={notice.pending} onClick={notice.discard}>
              Discard
            </Button>
          ) : null}
        </div>
      ) : toast ? (
        <div key={toast.id} className="hc-toast" id="board-status">
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}

function selectOnFocus(event: { readonly currentTarget: HTMLInputElement }) {
  event.currentTarget.select();
}

export interface InviteDialogProps {
  readonly open: boolean;
  readonly joinCode: string | null;
  readonly codeCopied: boolean;
  readonly seatName: string | null;
  readonly seatKey: string | null;
  readonly seatKeyFeedback: string | null;
  readonly onCopyJoinCode: (code: string) => void;
  readonly onCopySeatKey: (key: string) => void;
  readonly onClose: () => void;
}

export function InviteDialog({ open, joinCode, codeCopied, seatName, seatKey, seatKeyFeedback, onCopyJoinCode, onCopySeatKey, onClose }: InviteDialogProps) {
  return (
    <Modal open={open} title={joinCode ? "Invite player 2" : "Seat key"} onClose={onClose}>
      <div className="hc-invite">
        {joinCode ? (
          <div className="hc-invite-block">
            <span className="hc-section-label">Join code</span>
            <div className="hc-copy-row">
              <input id="join-code-value" className="hc-code-field" value={joinCode} readOnly aria-label="Join code" onFocus={selectOnFocus} />
              <Button id="copy-join-code-btn" onClick={() => onCopyJoinCode(joinCode)}>
                <Copy size={14} aria-hidden="true" />
                {codeCopied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        ) : null}
        <div className="hc-invite-block">
          <span className="hc-section-label">Your seat key{seatName ? `, ${seatName}` : ""}</span>
          <div className="hc-copy-row">
            <input id="seat-key-value" className="kit-input hc-mono" value={seatKey ?? ""} readOnly aria-label="Seat key" onFocus={selectOnFocus} />
            {seatKey ? (
              <Button id="copy-seat-key-btn" variant="primary" onClick={() => onCopySeatKey(seatKey)}>
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
  );
}

export interface ResignDialogProps {
  readonly open: boolean;
  readonly playerName: string;
  readonly opponentName: string;
  readonly pending: boolean;
  readonly uncertain: boolean;
  readonly error: string | null;
  readonly onResign: () => void;
  readonly onClose: () => void;
}

export function ResignDialog({ open, playerName, opponentName, pending, uncertain, error, onResign, onClose }: ResignDialogProps) {
  const problem = uncertain ? "dohc could not confirm the resignation. Try again to check." : error;
  return (
    <Modal
      open={open}
      title={`Resign as ${playerName}?`}
      onClose={() => {
        if (!pending) onClose();
      }}
    >
      <p className="hc-modal-text">{opponentName} wins right away. This cannot be undone.</p>
      {problem ? (
        <p className="hc-field-error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="hc-modal-actions">
        <Button id="cancel-resign-btn" disabled={pending} onClick={onClose}>
          Keep playing
        </Button>
        <Button id="confirm-resign-btn" variant="danger" loading={pending} onClick={onResign}>
          {uncertain ? "Try again" : "Resign"}
        </Button>
      </div>
    </Modal>
  );
}
