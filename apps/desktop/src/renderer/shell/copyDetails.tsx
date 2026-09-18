import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SecondaryButton } from "../ui/controls";

// One plain-text block a person can paste into a chat or an issue: one
// "label: value" line per fact, facts without a value left out. A few
// lines, never a log: a log can carry paths a person should not paste in
// public.
export const ERROR_DETAIL_MAX_CHARS = 500;

export function errorDetails(
  fields: ReadonlyArray<readonly [label: string, value: string | null | undefined]>,
): string {
  return fields
    .filter((field): field is readonly [string, string] => Boolean(field[1]))
    .map(([label, value]) => {
      // One line per fact, so a multi-line message cannot smuggle in a
      // stack, and no line longer than a person would paste.
      const line = value.replace(/\s*[\r\n]+\s*/g, " ").trim();
      return `${label}: ${line.length > ERROR_DETAIL_MAX_CHARS ? `${line.slice(0, ERROR_DETAIL_MAX_CHARS - 1)}…` : line}`;
    })
    .join("\n");
}

// Copies and says so for two seconds, the way the sync-code copy in Cloud
// settings does. The caller decides what to copy and what to do on failure.
export function useCopied(onError?: (error: unknown) => void) {
  const [copied, setCopied] = useState(false);
  // What the live region says. It is cleared and set again on every
  // success, in a later task, so a second copy inside the two seconds is
  // announced again instead of leaving the region's text unchanged.
  const [announcement, setAnnouncement] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      if (announce.current !== null) clearTimeout(announce.current);
    },
    [],
  );
  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setAnnouncement("");
        if (announce.current !== null) clearTimeout(announce.current);
        announce.current = setTimeout(() => setAnnouncement("Copied"), 0);
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          setCopied(false);
          setAnnouncement("");
        }, 2000);
      } catch (error) {
        onError?.(error);
      }
    },
    [onError],
  );
  return { copied, announcement, copy };
}

export function CopyDetailsButton(props: {
  details: () => string;
  label?: string;
  // Icon only, with the label as the accessible name and tooltip.
  iconOnly?: boolean;
  "data-testid"?: string;
  onError?: (error: unknown) => void;
}) {
  const { copied, announcement: announced, copy } = useCopied(props.onError);
  const label = props.label ?? "Copy details";
  const { details } = props;
  // The icon and tooltip change is silent to a screen reader; this polite
  // status says "Copied" for both variants, once per success.
  const announcement = (
    <span role="status" aria-live="polite" className="sr-only">
      {announced}
    </span>
  );
  if (props.iconOnly) {
    return (
      <>
        <button
          type="button"
          data-testid={props["data-testid"]}
          aria-label={label}
          title={copied ? "Copied" : label}
          onClick={() => void copy(details())}
          className="grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-line/50 hover:text-ink"
        >
          {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
        </button>
        {announcement}
      </>
    );
  }
  return (
    <>
      <SecondaryButton
        type="button"
        data-testid={props["data-testid"]}
        aria-label={label}
        onClick={() => void copy(details())}
      >
        {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
        {copied ? "Copied" : label}
      </SecondaryButton>
      {announcement}
    </>
  );
}
