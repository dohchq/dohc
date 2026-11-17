import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

// The desktop's FADING_TOAST_MS.
const FADES_AFTER_MS = 6000;

/**
 * A member page's toast: what failed, the one thing to do, a copy control beside the text, Try again and Dismiss.
 * A `warning` says what dohc is still fixing by itself, as the desktop's warning notice does.
 * A toast with no `onRetry` reports a change, such as a new level, not a failure, so it has neither Try again nor a copy control.
 * A `success` fades as the desktop's does,
 * but not while the pointer or focus is on it. A warning or a failure stays until it is dismissed.
 */
export function Toast({
  title,
  body,
  tone,
  onRetry,
  onDismiss,
}: {
  title: string;
  body?: string;
  tone?: "warning" | "success";
  onRetry?(): void;
  onDismiss(): void;
}) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const [pointer, setPointer] = useState(false),
    [focus, setFocus] = useState(false);
  const fades = tone === "success" && !pointer && !focus;
  useEffect(() => {
    if (!fades) return;
    const timer = setTimeout(() => dismiss.current(), FADES_AFTER_MS);
    return () => clearTimeout(timer);
  }, [fades, title]);
  return (
    <div
      className={`edit-notice workspace-toast${body || onRetry ? "" : " title-only"}`}
      role={tone ? "status" : "alert"}
      onPointerEnter={() => setPointer(true)}
      onPointerLeave={() => setPointer(false)}
      onFocus={() => setFocus(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocus(false);
      }}
    >
      {tone === "success" ? (
        <span className="tile">
          <Icon name="check" />
        </span>
      ) : tone ? (
        <span className="tile warn">
          <Icon name="triangle-alert" />
        </span>
      ) : (
        <span className="tile bad">
          <Icon name="alert" />
        </span>
      )}
      <div>
        <div className="toast-text">
          <div>
            <p className="edit-notice-title">{title}</p>
            {body && <p>{body}</p>}
          </div>
          {onRetry && <CopyMessage text={body ? `${title}\n${body}` : title} />}
        </div>
        {onRetry && (
          <div className="edit-notice-actions">
            <button className="handoff-button secondary" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}
      </div>
      <button
        className="icon-button toast-close"
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={onDismiss}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

/** Copies exactly what the toast says, and shows that it did for 2 s. */
function CopyMessage({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    let next: "copied" | "failed" = "copied";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      next = "failed";
    }
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };
  const label =
    state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : "Copy message";
  return (
    <button
      className="icon-button toast-copy"
      type="button"
      aria-label={label}
      title={label}
      onClick={() => void copy()}
    >
      <Icon name={state === "copied" ? "check" : "copy"} />
    </button>
  );
}
