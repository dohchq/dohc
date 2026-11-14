import {useEffect, useRef, useState} from "react";

/**
 * Copies the person's own text. The button says Copied for 2 s. When the
 * browser refuses, a line says so in place and stays, and the text stays.
 */
export function CopyWork({text, label, failure}: {text: string; label: string; failure: string}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    clearTimeout(timer.current);
    try {
      if (!navigator.clipboard) throw new Error("No clipboard");
      await navigator.clipboard.writeText(text);
    } catch {setState("failed"); return;}
    setState("copied"); timer.current = setTimeout(() => setState("idle"), 2000);
  };
  return <>
    <button type="button" className="handoff-button secondary" aria-label={label} onClick={() => void copy()}>{state === "copied" ? "Copied" : "Copy"}</button>
    {state === "failed" && <p className="copy-failed" role="alert">{failure}</p>}
  </>;
}
