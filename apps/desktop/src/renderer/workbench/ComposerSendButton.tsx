import { ArrowUp, LoaderCircle, Send } from "lucide-react";
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

// The submit control every chat composer shares. It is disabled while a send
// is in flight; once that send is slow, a ring takes the mark's place, the
// control is busy, and a polite status says so. The control keeps its size
// and accessible name. A busy control keeps full strength: at the disabled
// 40% the ring measures under 3:1 on its fill, and it is the only sign.
export function ComposerSendButton(props: {
  testId: string;
  label: string;
  sending: boolean;
  disabled: boolean;
  // A chat's box sends from a 28px square that fills with the accent once
  // there's something to send.
  shape: "icon" | "post" | "box";
}) {
  const slow = useSlowSend(props.sending);
  const hidden = slow ? "invisible" : undefined;
  return (
    <>
      <button
        type="submit"
        data-testid={props.testId}
        aria-label={props.label}
        title={props.label}
        aria-busy={slow || undefined}
        disabled={props.sending || props.disabled}
        className={`relative shrink-0 rounded-md ${
          props.shape === "box"
            ? `grid size-7 place-items-center ${props.disabled && !props.sending ? "bg-panel-2 text-subtle" : "bg-accent text-bg"}`
            : `bg-accent text-bg ${props.shape === "icon" ? "grid size-8 place-items-center" : "h-7 px-3 text-[12px] font-medium"}`
        } ${slow ? "cursor-progress" : `cursor-pointer hover:opacity-90 disabled:cursor-not-allowed ${props.shape === "box" ? "" : "disabled:opacity-40"}`}`}
      >
        {props.shape === "box" ? <ArrowUp size={15} strokeWidth={2} aria-hidden className={hidden} />
          : props.shape === "icon" ? <Send size={13} aria-hidden className={hidden} /> : <span className={hidden}>Post</span>}
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
