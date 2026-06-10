import { CheckCircle2, LayoutGrid, ShieldCheck, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AppPackageResult } from "../ipc/bridgeContract";
import { rendererMarks } from "../performance/rendererMarks";
import { bridge } from "./bridge";

type AppInfo = NonNullable<AppPackageResult>;

const READINESS_LABEL: Record<AppInfo["readiness"], string> = {
  "needs-testing": "Needs testing",
  failed: "AppTester failed",
  ready: "Ready",
};

// The app package surface: the app's source is visible/editable in the tree;
// this pane shows what the app declares (manifest), its trust requirement, and
// its AppTester readiness — an app must pass AppTester before it can be a
// trusted, broadly-writing app.
export function AppPackageView(props: { workspaceId: string; path: string }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  // A path under .apps/ that doesn't belong to a discovered package (no
  // app.json yet, or a stray file directly under .apps/) is a real, reachable
  // state — it must render guidance, never an eternal "Loading…".
  const [missing, setMissing] = useState(false);
  const [running, setRunning] = useState(false);

  const reload = useCallback(async () => {
    try {
      const result = await bridge().getAppPackage({
        workspaceId: props.workspaceId,
        path: props.path,
      });
      setInfo(result);
      setMissing(result === null);
    } catch {
      setInfo(null);
      setMissing(true);
    }
  }, [props.workspaceId, props.path]);

  useEffect(() => {
    setInfo(null);
    setMissing(false);
    void reload();
  }, [reload]);

  // Performance mark: the app PACKAGE surface opened (manifest + readiness
  // rendered). The in-app RUNTIME open is Phase 7b — measured there.
  useEffect(() => {
    if (info) {
      rendererMarks.measureSince("app-package-open", "file-open-start");
      // Last-wins: readers poll this epoch for freshness (see FileInspector).
      rendererMarks.mark("app-package-opened");
    }
  }, [info]);

  if (missing) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
        <header className="flex items-center gap-1.5 border-b border-line px-4 py-2 text-[13px]">
          <LayoutGrid size={13} aria-hidden />
          <span className="font-mono text-ink">{props.path}</span>
          <span className="ml-auto text-[11px] uppercase tracking-wide text-subtle">app</span>
        </header>
        <div
          data-testid="view-app"
          className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
        >
          <span className="text-sm text-ink">Not an app package yet</span>
          <span className="max-w-md text-xs text-muted">
            An app lives in .apps/&lt;name&gt; with an app.json manifest next to its
            source. Add app.json to make this folder a runnable app.
          </span>
        </div>
      </div>
    );
  }

  async function runTester() {
    if (!info || running) return;
    setRunning(true);
    try {
      await bridge().runAppTester({ workspaceId: props.workspaceId, appRoot: info.root });
      await reload();
    } finally {
      setRunning(false);
    }
  }

  async function trust() {
    if (!info) return;
    await bridge().grantAppTrust({ workspaceId: props.workspaceId, appRoot: info.root });
    await reload();
  }

  if (!info) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
        <div className="flex flex-1 items-center justify-center text-sm text-subtle">
          Loading app…
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
      <header className="flex items-center gap-1.5 border-b border-line px-4 py-2 text-[13px]">
        <LayoutGrid size={13} aria-hidden />
        <span className="font-mono text-ink">{info.root}</span>
        <span className="ml-auto text-[11px] uppercase tracking-wide text-subtle">app</span>
      </header>

      <div
        data-testid="view-app"
        className="min-h-0 flex-1 overflow-auto p-5"
      >
        <div className="flex items-center gap-2">
          <h2 className="m-0 text-lg font-semibold text-ink">
            {info.manifest.title ?? info.name}
          </h2>
          <span
            data-testid="app-readiness"
            data-readiness={info.readiness}
            className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${
              info.readiness === "ready"
                ? "text-success"
                : info.readiness === "failed"
                  ? "text-danger"
                  : "text-subtle"
            }`}
          >
            {info.readiness === "ready" ? (
              <CheckCircle2 size={12} aria-hidden />
            ) : info.readiness === "failed" ? (
              <XCircle size={12} aria-hidden />
            ) : null}
            {READINESS_LABEL[info.readiness]}
          </span>
        </div>

        <dl className="mt-4 grid grid-cols-[8rem_1fr] gap-y-1.5 text-[13px]">
          <dt className="text-subtle">Entry</dt>
          <dd className="m-0 font-mono text-ink">{info.manifest.entry}</dd>
          <dt className="text-subtle">Reads</dt>
          <dd className="m-0 font-mono text-ink">{info.manifest.read.join(", ") || "—"}</dd>
          <dt className="text-subtle">Writes</dt>
          <dd className="m-0 font-mono text-ink">
            {info.manifest.write.join(", ") || "none (read-only)"}
          </dd>
          <dt className="text-subtle">Trust</dt>
          <dd className="m-0 text-ink">
            {info.requiresTrust ? (
              <span className="flex items-center gap-1">
                <ShieldCheck size={12} aria-hidden />
                {info.trusted ? "Trusted" : "Requires trust for broad writes"}
              </span>
            ) : (
              "Read-only — no trust needed"
            )}
          </dd>
        </dl>

        <div className="mt-5 flex items-center gap-2">
          <button
            type="button"
            data-testid="run-app-tester"
            disabled={running}
            onClick={() => void runTester()}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:opacity-90 disabled:opacity-50"
          >
            {running ? "Testing…" : "Run AppTester"}
          </button>
          {info.requiresTrust && !info.trusted && info.readiness === "ready" ? (
            <button
              type="button"
              data-testid="trust-app"
              onClick={() => void trust()}
              className="rounded border border-line bg-panel-2 px-3 py-1.5 text-xs text-muted hover:text-ink"
            >
              Trust this app
            </button>
          ) : null}
        </div>

        {info.lastTestChecks.length > 0 ? (
          <ul className="mt-4 m-0 list-none p-0" data-testid="app-test-checks">
            {info.lastTestChecks.map((check) => (
              <li key={check.name} className="flex items-center gap-1.5 py-0.5 text-[12px]">
                {check.status === "ok" ? (
                  <CheckCircle2 size={12} aria-hidden className="text-success" />
                ) : (
                  <XCircle size={12} aria-hidden className="text-danger" />
                )}
                <span className="text-ink">{check.name}</span>
                {check.message ? (
                  <span className="text-subtle">— {check.message}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-5">
          <span className="text-[11px] uppercase tracking-wide text-subtle">Source</span>
          <ul className="mt-1 m-0 list-none p-0">
            {info.sourceFiles.map((file) => (
              <li key={file} className="py-0.5 font-mono text-[12px] text-muted">
                {file.slice(info.root.length + 1)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
