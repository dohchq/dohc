import {useEffect, useRef, useState} from "react";

// Read by a screen reader and hidden from sight, wherever the button sits.
const HEARD = {position: "absolute", width: 1, height: 1, margin: -1, padding: 0, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap", border: 0} as const;

/**
 * Copies the person's own text. The button says Copied for 2 s. When the
 * browser refuses, a line says so in place and stays, and the text stays.
 * A status region says either result to a screen reader.
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
    {state === "failed" && <p className="copy-failed">{failure}</p>}
    <span className="copy-status" role="status" style={HEARD}>{state === "copied" ? "Copied" : state === "failed" ? failure : ""}</span>
  </>;
}
