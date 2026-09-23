import { useEffect, useRef, useState } from "react";

export type AppLaunch = {discriminator: string; publicationId: string} | {workspaceId: string; publicationId: string};
/** The launch endpoint answered with a non-200 status: 404 refuses the caller, 503 means the relay is unavailable. */
export class AppLaunchError extends Error {constructor(readonly status: number) {super(`Launch refused with status ${status}`);}}

/** Issues a launch for `launch` and hands the browser to the approved app origin. Resolves after the form submits. */
export async function launchSharedApp(launch: AppLaunch, signal: AbortSignal): Promise<void> {
  const response = await fetch("/api/apps/launch", {method: "POST", credentials: "same-origin", signal,
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
    {state === "failed" && <p role="status">Could not open the app. Try again or ask the owner for a new link.</p>}
  </section>;
}
