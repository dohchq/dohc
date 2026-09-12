import * as React from "react";
import { CollectionError, type CollectionClient, type Fields, type Page } from "./broker.ts";

type Submission = { idempotencyKey: string; fields: Fields };
export function Poll({ client }: { client: CollectionClient }) {
  const [rows, setRows] = React.useState<Page["records"]>([]);
  const [nextPath, setNextPath] = React.useState<string | null>(null);
  const [name, setName] = React.useState(""), [destination, setDestination] = React.useState("Tokyo");
  const [loading, setLoading] = React.useState(true), [saving, setSaving] = React.useState(false);
  const [loadError, setLoadError] = React.useState(""), [message, setMessage] = React.useState("");
  const [uncertain, setUncertain] = React.useState<Submission | null>(null);
  const [refusal, setRefusal] = React.useState<"quota" | "conflict" | null>(null);
  const generation = React.useRef(0), alive = React.useRef(true), busy = React.useRef(false);
  const load = async (afterPath?: string) => {
    const token = ++generation.current; setLoading(true); setLoadError("");
    try {
      const page = await client.list({ limit: 50, ...(afterPath ? { afterPath } : {}) });
      if (!alive.current || token !== generation.current) return;
      setRows(previous => afterPath ? [...previous, ...page.records.filter(row => !previous.some(old => old.path === row.path))] : page.records);
      setNextPath(page.nextPath);
    } catch (error) {
      if (!alive.current || token !== generation.current) return;
      setLoadError(error instanceof CollectionError && error.status === 404
        ? "This poll is unavailable. Ask its owner for a current link."
        : "Responses could not load. Try again.");
    } finally { if (alive.current && token === generation.current) setLoading(false); }
  };
  React.useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; generation.current++; };
  }, [client]);
  const send = async (submission: Submission) => {
    if (busy.current) return;
    busy.current = true; setSaving(true); setMessage(""); setUncertain(submission);
    try {
      await client.create(submission);
      if (!alive.current) return;
      setUncertain(null); setMessage("Response saved."); await load();
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof CollectionError && error.status === 400) {
        setUncertain(null); setMessage("Your response was refused. Check your name and destination, then send it again."); return;
      }
      if (error instanceof CollectionError && error.status === 413) {
        setUncertain(null); setRefusal("quota"); setMessage("This poll cannot accept more responses. Ask its owner for help."); return;
      }
      if (error instanceof CollectionError && error.status === 409) {
        setRefusal("conflict"); setMessage("This response cannot be retried because the poll or its saved response changed. Ask its owner for help."); return;
      }
      if (error instanceof CollectionError && error.status === 429) {
        setMessage("Too many requests. Wait before retrying this response."); return;
      }
      setMessage(error instanceof CollectionError && error.status === 404
        ? "This poll is unavailable. Keep this page open and ask its owner for help."
        : "Your response may have been saved. Retry the same response to check.");
    } finally { busy.current = false; if (alive.current) setSaving(false); }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (refusal) return;
    if (uncertain) { void send(uncertain); return; }
    void send({ idempotencyKey: crypto.randomUUID(), fields: { destination, ...(name.trim() ? { name: name.trim() } : {}) } });
  };
  return <main aria-labelledby="poll-title">
    <p className="eyebrow">Plan a trip</p><h1 id="poll-title">Where should we go?</h1>
    <p>Choose a destination. Everyone with this link can see the responses.</p>
    <form onSubmit={submit} aria-busy={saving}>
      <fieldset disabled={saving || uncertain !== null}><legend>Your response</legend>
        <label htmlFor="name">Name (optional)</label><input id="name" autoComplete="name" maxLength={80} value={name} onChange={event => setName(event.target.value)} />
        <label htmlFor="destination">Destination</label><select id="destination" value={destination} onChange={event => setDestination(event.target.value)}><option>Tokyo</option><option>Manila</option></select>
      </fieldset>
      <button type="submit" disabled={saving || loading || refusal !== null}>{saving ? "Saving response…" : uncertain ? "Retry response" : "Send response"}</button>
      <p role="status" aria-live="polite">{message}</p>
      {uncertain && !saving && <div>
        <p>The earlier response may already be saved. Discarding this pending response does not delete a saved response.</p>
        <button type="button" onClick={() => { setUncertain(null); setRefusal(null); setMessage("Pending response discarded. Check shared responses before sending another."); }}>Discard pending response</button>
      </div>}
    </form>
    <section aria-labelledby="responses-title" aria-busy={loading}>
      <div className="section-heading"><h2 id="responses-title">Shared responses</h2><button type="button" onClick={() => void load()} disabled={loading}>Refresh</button></div>
      <p role="status">{loading ? "Loading responses…" : ""}</p>
      {loadError && <p role="alert">{loadError}</p>}
      {!loading && !loadError && rows.length === 0 && <p>No responses yet. Send yours above.</p>}
      <ul>{rows.map(row => <li key={row.path}><span>{row.fields.name || "Someone"}</span><strong>{row.fields.destination || "No destination"}</strong></li>)}</ul>
      {nextPath && <button type="button" disabled={loading} onClick={() => void load(nextPath)}>Show more responses</button>}
    </section>
  </main>;
}
