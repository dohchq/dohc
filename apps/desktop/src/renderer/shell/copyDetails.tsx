import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SecondaryButton } from "../ui/controls";

// One plain-text block a person can paste into a chat or an issue: one
// "label: value" line per fact, facts without a value left out. A few
// lines, never a log: a log can carry paths a person should not paste in
// public.
export function errorDetails(
  fields: ReadonlyArray<readonly [label: string, value: string | null | undefined]>,
): string {
  return fields
    .filter((field): field is readonly [string, string] => Boolean(field[1]))
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
}

// Copies and says so for two seconds, the way the sync-code copy in Cloud
// settings does. The caller decides what to copy and what to do on failure.
export function useCopied(onError?: (error: unknown) => void) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2000);
      } catch (error) {
        onError?.(error);
      }
    },
    [onError],
  );
  return { copied, copy };
}

export function CopyDetailsButton(props: {
  details: () => string;
  label?: string;
  "data-testid"?: string;
  onError?: (error: unknown) => void;
}) {
  const { copied, copy } = useCopied(props.onError);
  const label = props.label ?? "Copy details";
  const { details } = props;
  return (
    <SecondaryButton
      type="button"
      data-testid={props["data-testid"]}
      aria-label={label}
      onClick={() => void copy(details())}
    >
      {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      {copied ? "Copied" : label}
    </SecondaryButton>
  );
}
