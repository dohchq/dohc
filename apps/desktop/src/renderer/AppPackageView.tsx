import {
  CheckCircle2,
  LayoutGrid,
  Play,
  RefreshCcw,
  Share2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  AppPackageResult,
  AppRuntimeResult,
  AppRuntimeRpcRequest,
} from "../ipc/bridgeContract";
import { rendererMarks } from "../performance/rendererMarks";
import { bridge } from "./bridge";

type AppInfo = NonNullable<AppPackageResult>;
type RuntimeMessage =
  | ({ type: "dohc:runtime-rpc"; token: string } & Extract<
      AppRuntimeRpcRequest,
      { op: "collection.list" }
    >)
  | ({ type: "dohc:runtime-rpc"; token: string } & Extract<
      AppRuntimeRpcRequest,
      { op: "collection.insert" }
    >);

const READINESS_LABEL: Record<AppInfo["readiness"], string> = {
  "needs-testing": "Needs testing",
  failed: "AppTester failed",
  ready: "Ready",
};

// The app package surface: the app's source is visible/editable in the tree;
// this pane shows what the app declares (manifest), its trust requirement, and
// its AppTester readiness — an app must pass AppTester before it can be a
// trusted, broadly-writing app.
export function AppPackageView(props: {
  workspaceId: string;
  path: string;
  onSharePath?: (path: string) => void;
}) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  // A path under .apps/ that doesn't belong to a discovered package (no
  // app.json yet, or a stray file directly under .apps/) is a real, reachable
  // state — it must render guidance, never an eternal "Loading…".
  const [missing, setMissing] = useState(false);
  const [running, setRunning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const result = await bridge().getAppPackage({
        workspaceId: props.workspaceId,
        path: props.path,
      });
      setInfo(result);
      setMissing(result === null);
      setActionError(null);
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

  const sharePath = info?.root ?? props.path;
  const onShare = props.onSharePath
    ? () => props.onSharePath?.(sharePath)
    : undefined;

  if (missing) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
        <AppHeader icon={<LayoutGrid size={13} aria-hidden />} path={props.path} onShare={onShare} />
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
    setActionError(null);
    try {
      await bridge().runAppTester({ workspaceId: props.workspaceId, appRoot: info.root });
      await reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "AppTester failed.");
    } finally {
      setRunning(false);
    }
  }

  async function trust() {
    if (!info) return;
    setActionError(null);
    try {
      await bridge().grantAppTrust({ workspaceId: props.workspaceId, appRoot: info.root });
      await reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not trust this app.");
    }
  }

  if (!info) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
        <AppHeader icon={<LayoutGrid size={13} aria-hidden />} path={props.path} onShare={onShare} />
        <div className="flex flex-1 items-center justify-center text-sm text-subtle">
          Loading app…
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg" data-testid="file-inspector">
      <AppHeader icon={<LayoutGrid size={13} aria-hidden />} path={info.root} onShare={onShare} />

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
        {actionError ? (
          <div data-testid="app-action-error" className="mt-2 text-[12px] text-danger">
            {actionError}
          </div>
        ) : null}

        {info.readiness === "ready" && (!info.requiresTrust || info.trusted) ? (
          <AppRuntimeFrame
            workspaceId={props.workspaceId}
            appRoot={info.root}
          />
        ) : null}

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

export function isRuntimeMessage(value: unknown, token: string): value is RuntimeMessage {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<RuntimeMessage>;
  const args = data.args as Record<string, unknown> | undefined;
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  if (typeof args.name !== "string") return false;
  return (
    data.type === "dohc:runtime-rpc" &&
    data.token === token &&
    typeof data.id === "string" &&
    (data.op === "collection.list" ||
      (data.op === "collection.insert" &&
        Boolean(args.record) &&
        typeof args.record === "object" &&
        !Array.isArray(args.record)))
  );
}

function AppRuntimeFrame({
  workspaceId,
  appRoot,
}: {
  workspaceId: string;
  appRoot: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const frameLoadedRef = useRef(false);
  const [runtime, setRuntime] = useState<AppRuntimeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    frameLoadedRef.current = false;
  }, [runtime?.token, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    bridge()
      .getAppRuntime({ workspaceId, appRoot })
      .then((result) => {
        if (cancelled) return;
        setRuntime(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setRuntime(null);
        setError(err instanceof Error ? err.message : "Couldn't run this app.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, appRoot, reloadKey]);

  useEffect(() => {
    if (!runtime) return;
    const token = runtime.token;
    const targetOrigin = new URL(runtime.src).origin;
    function onMessage(event: MessageEvent) {
      const frame = iframeRef.current?.contentWindow;
      if (
        !frame ||
        event.source !== frame ||
        event.origin !== targetOrigin ||
        !isRuntimeMessage(event.data, token)
      ) {
        return;
      }
      const request = event.data;
      const rpcRequest: AppRuntimeRpcRequest =
        request.op === "collection.list"
          ? { id: request.id, op: "collection.list", args: request.args }
          : { id: request.id, op: "collection.insert", args: request.args };
      function postRuntimeMessage(message: Record<string, unknown>) {
        const currentFrame = iframeRef.current?.contentWindow;
        if (!currentFrame || currentFrame !== frame) return;
        try {
          currentFrame.postMessage(message, targetOrigin);
        } catch {
          // The app frame can disappear while an async RPC is in flight.
        }
      }
      bridge()
        .runAppRuntimeRpc({ workspaceId, appRoot, request: rpcRequest })
        .then((result) => {
          postRuntimeMessage({
            type: "dohc:runtime-rpc-result",
            token,
            id: request.id,
            ok: true,
            value: result.value,
          });
        })
        .catch((err) => {
          postRuntimeMessage({
            type: "dohc:runtime-rpc-result",
            token,
            id: request.id,
            ok: false,
            error: err instanceof Error ? err.message : "App request failed.",
          });
        });
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [runtime, workspaceId, appRoot]);

  return (
    <section className="mt-5 border-t border-line pt-4" data-testid="app-runtime">
      <div className="mb-2 flex items-center gap-2">
        <Play size={13} aria-hidden className="text-success" />
        <h3 className="m-0 text-[13px] font-medium text-ink">Runtime</h3>
        <button
          type="button"
          data-testid="app-runtime-reload"
          aria-label="Reload app runtime"
          title="Reload app runtime"
          onClick={() => setReloadKey((key) => key + 1)}
          className="ml-auto grid size-7 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
        >
          <RefreshCcw size={13} aria-hidden />
        </button>
      </div>
      {loading ? (
        <div className="grid h-64 place-items-center rounded border border-line bg-panel-2 text-[12px] text-subtle">
          Loading runtime…
        </div>
      ) : error ? (
        <div
          data-testid="app-runtime-error"
          className="rounded border border-line bg-panel-2 px-3 py-2 text-[12px] text-danger"
        >
          {error}
        </div>
      ) : runtime ? (
        <iframe
          ref={iframeRef}
          key={`${runtime.root}:${reloadKey}`}
          data-testid="app-runtime-frame"
          title={runtime.title}
          src={runtime.src}
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          onLoad={() => {
            if (frameLoadedRef.current) {
              setRuntime(null);
              setError("App runtime navigation was blocked.");
              return;
            }
            frameLoadedRef.current = true;
          }}
          className="h-[360px] w-full rounded border border-line bg-bg"
        />
      ) : null}
    </section>
  );
}

function AppHeader(props: {
  icon: ReactNode;
  path: string;
  onShare?: () => void;
}) {
  return (
    <header className="flex items-center gap-1.5 border-b border-line px-4 py-2 text-[13px]">
      {props.icon}
      <span className="font-mono text-ink">{props.path}</span>
      <span className="ml-auto text-[11px] uppercase tracking-wide text-subtle">app</span>
      {props.onShare ? (
        <button
          type="button"
          data-testid="file-share"
          aria-label="Share file"
          title="Share file"
          onClick={props.onShare}
          className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
        >
          <Share2 size={13} aria-hidden />
        </button>
      ) : null}
    </header>
  );
}
