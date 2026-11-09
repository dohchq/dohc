import { ArrowUp, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

// A send still in flight after this long shows the ring. A quicker send
// changes nothing on screen, so an ordinary message does not flicker.
const SLOW_SEND_MS = 1000;

function useSlowSend(sending: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!sending) return;
    const timer = window.setTimeout(() => setSlow(true), SLOW_SEND_MS);
    return () => {
      window.clearTimeout(timer);
      setSlow(false);
    };
  }, [sending]);
  return sending && slow;
}

// The submit control every chat composer shares, in three looks: the accent
// fill when there is something to send, an empty outline with a faint mark
// when there is not, and a quiet fill with a full-strength ring once a send
// is slow, so a send in progress never reads as either. It is disabled while
// a send is in flight; a quicker send keeps the ready look. The busy control
// is busy to assistive tech and a polite status says so. The control keeps
// its size and accessible name in every look.
const LOOK = {
  ready: "border-transparent bg-accent text-bg cursor-pointer hover:opacity-90",
  off: "border-line text-subtle cursor-not-allowed",
  busy: "border-transparent bg-panel-2 text-ink cursor-progress",
} as const;

export function ComposerSendButton(props: {
  testId: string;
  label: string;
  sending: boolean;
  disabled: boolean;
  // A chat's box sends from a 28px square; a new post sends from a worded
  // button.
  shape: "post" | "box";
}) {
  const slow = useSlowSend(props.sending);
  const hidden = slow ? "invisible" : undefined;
  const look = slow ? "busy" : props.disabled && !props.sending ? "off" : "ready";
  return (
    <>
      <button
        type="submit"
        data-testid={props.testId}
        aria-label={props.label}
        title={props.label}
        aria-busy={slow || undefined}
        data-look={look}
        disabled={props.sending || props.disabled}
        className={`relative shrink-0 rounded-md border ${LOOK[look]} ${
          props.shape === "box" ? "grid size-7 place-items-center" : "h-7 px-3 text-[12px] font-medium"
        }`}
      >
        {props.shape === "box" ? <ArrowUp size={15} strokeWidth={2} aria-hidden className={hidden} />
          : <span className={hidden}>Post</span>}
        {slow ? (
          <LoaderCircle
            data-testid={`${props.testId}-pending`}
            size={13}
            strokeWidth={1.9}
            aria-hidden
            className="absolute inset-0 m-auto motion-safe:animate-spin"
          />
        ) : null}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {slow ? "Sending…" : ""}
      </span>
    </>
  );
}
