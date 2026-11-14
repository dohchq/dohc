import {useEffect, useRef, useState} from "react";
import {Icon} from "./icons";

/**
 * A member page's toast: what failed, the one thing to do, a copy control beside the text, Try again and Dismiss.
 * A `warning` says what dohc is still fixing by itself, as the desktop's warning notice does.
 */
export function Toast({title, body, tone, onRetry, onDismiss}: {title: string; body: string; tone?: "warning"; onRetry(): void; onDismiss(): void}) {
  return <div className="edit-notice workspace-toast" role={tone ? "status" : "alert"}>
    {tone ? <span className="tile warn"><Icon name="triangle-alert"/></span> : <span className="tile bad"><Icon name="alert"/></span>}
    <div>
      <div className="toast-text">
        <div><p className="edit-notice-title">{title}</p><p>{body}</p></div>
        <CopyMessage text={`${title}\n${body}`}/>
      </div>
      <div className="edit-notice-actions"><button className="handoff-button secondary" onClick={onRetry}>Try again</button></div>
    </div>
    <button className="icon-button toast-close" type="button" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}><Icon name="x"/></button>
  </div>;
}

/** Copies exactly what the toast says, and shows that it did for 2 s. */
function CopyMessage({text}: {text: string}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    let next: "copied" | "failed" = "copied";
    try {await navigator.clipboard.writeText(text);} catch {next = "failed";}
    setState(next); clearTimeout(timer.current); timer.current = setTimeout(() => setState("idle"), 2000);
  };
  const label = state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : "Copy message";
  return <button className="icon-button toast-copy" type="button" aria-label={label} title={label} onClick={() => void copy()}>
    <Icon name={state === "copied" ? "check" : "copy"}/>
  </button>;
}
