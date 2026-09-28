import { useEffect, useRef, useState } from "react";
import { OpenSharedApp } from "./OpenSharedApp";
import {LINK_REFUSALS, parseLinkRefusal} from "@dohc/security-contract/link-refusal";

interface Publication {publicationId: string; name: string}
function parsePage(value: unknown): {publications: Publication[]; nextCursor: string | null} {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.publications) || page.publications.length > 25 ||
      (page.nextCursor !== null && (typeof page.nextCursor !== "string" || !/^[a-f0-9]{64}$/.test(page.nextCursor)))) throw new Error();
  for (const item of page.publications) if (!item || typeof item !== "object" ||
    typeof item.publicationId !== "string" || !/^[a-f0-9]{64}$/.test(item.publicationId) ||
    typeof item.name !== "string" || !item.name || item.name.length > 128) throw new Error();
  return page as unknown as {publications: Publication[]; nextCursor: string | null};
}

export function PublishedApps({session}: {session: string}) {return <PublicationList key={session} session={session}/>;}
function PublicationList({session}: {session: string}) {
  const [publications, setPublications] = useState<Publication[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [error, setError] = useState("Could not load apps.");
  const active = useRef<AbortController | null>(null);
  async function load(after: string | null) {
    active.current?.abort();const controller = new AbortController();active.current = controller;setStatus("loading");
    try {
      const response = await fetch(`/api/apps?session=${encodeURIComponent(session)}${after ? `&cursor=${after}` : ""}`, {
        credentials: "same-origin", signal: controller.signal,
      });
      if (!response.ok) {
        const code = parseLinkRefusal(await response.json().catch(() => null), response.status);
        if (controller.signal.aborted || active.current !== controller) return;
        setError(code ? LINK_REFUSALS[code].error : "Could not load apps.");
        setStatus("failed");
        return;
      }
      const page = parsePage(await response.json());
      if (after !== null && page.nextCursor !== null && page.nextCursor <= after) throw new Error();
      if (controller.signal.aborted || active.current !== controller) return;
      setPublications(current => [...new Map([...current, ...page.publications].map(item => [item.publicationId, item])).values()]);
      setCursor(page.nextCursor);setStatus("ready");
    } catch {if (!controller.signal.aborted && active.current === controller) {setError("Could not load apps.");setStatus("failed");}}
  }
  useEffect(() => {void load(null);return () => active.current?.abort();}, []);
  return <section aria-label="Shared apps">
    <h2>Apps</h2>
    {publications.length > 0 && <p>Apps can use external services. Their authors decide where they send data.</p>}
    <ul>{publications.map(item => <li key={item.publicationId}><h3>{item.name}</h3><OpenSharedApp session={session} publicationId={item.publicationId} showNotice={false}/></li>)}</ul>
    {status === "loading" && <p role="status">Loading apps</p>}
    {status === "failed" && <><p role="status">{error}</p><button className="handoff-button" onClick={() => void load(cursor)}>Retry</button></>}
    {status === "ready" && publications.length === 0 && cursor === null && <p>No apps are available on this link. Ask the owner to publish one.</p>}
    {status === "ready" && cursor !== null && <button className="handoff-button" onClick={() => void load(cursor)}>Load more apps</button>}
  </section>;
}
