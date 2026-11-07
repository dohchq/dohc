import {fetchShareWeb} from "./apiVersion";
import { useEffect, useRef, useState } from "react";

export type AppLaunch = {discriminator: string; publicationId: string} | {workspaceId: string; publicationId: string};
/** The launch endpoint answered with a non-200 status: 404 refuses the caller, 503 means the relay is unavailable. */
export class AppLaunchError extends Error {constructor(readonly status: number) {super(`Launch refused with status ${status}`);}}

/** Issues a launch for `launch` and hands the browser to the approved app origin. Resolves after the form submits. */
export async function launchSharedApp(launch: AppLaunch, signal: AbortSignal): Promise<void> {
  const response = await fetchShareWeb("/api/apps/launch", {method: "POST", credentials: "same-origin", signal,
    headers: {"content-type": "application/json"}, body: JSON.stringify(launch)});
  if (!response.ok) throw new AppLaunchError(response.status);
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).sort().join() !== "action,handoff" || typeof fields.action !== "string" || typeof fields.handoff !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(fields.handoff)) throw new Error();
  const destination = new URL(fields.action);
  if (destination.protocol !== "https:" || destination.pathname !== "/bootstrap" || destination.search || destination.hash || destination.username || destination.password || destination.port || !/^[a-f0-9]{48}\./.test(destination.hostname)) throw new Error();
  signal.throwIfAborted();
  const form = document.createElement("form");form.method = "POST";form.action = destination.href;
  const input = document.createElement("input");input.type = "hidden";input.name = "handoff";input.value = fields.handoff;form.append(input);
  document.body.append(form);form.submit();form.remove();
}

/** A refused or failed Open app. The alert icon and the error tone mark it before a person reads the words. */
export function LaunchFailure({message, role}: {message: string; role: "alert" | "status"}) {
  return <p className="launch-failure" role={role}>
    <svg className="launch-failure-mark" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
    <span>{message}</span>
  </p>;
}

export function OpenSharedApp({session, publicationId, showNotice = true}: {session: string; publicationId: string; showNotice?: boolean}) {
  const [state, setState] = useState<"idle" | "opening" | "failed">("idle");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), [session, publicationId]);
  async function open() {
    active.current?.abort(); const controller = new AbortController(); active.current = controller; setState("opening");
    try { await launchSharedApp({discriminator: session, publicationId}, controller.signal); }
    catch { if (!controller.signal.aborted && active.current === controller) setState("failed"); }
  }
  return <section aria-label="Shared app">
    {showNotice && <p>This app can use external services. Its author decides where it sends data.</p>}
    <button className="handoff-button primary" onClick={() => void open()} disabled={state === "opening"}>{state === "opening" ? "Opening app" : "Open app"}</button>
    {state === "failed" && <LaunchFailure role="status" message="Could not open the app. Try again or ask the owner for a new link."/>}
  </section>;
}
