import { Bug, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { bridge } from "./bridge";
import { rendererMarks } from "../performance/rendererMarks";
import { toggleTheme } from "./theme";
import { IconButton } from "./ui/controls";

// Debug panel for working on the UI. Present only when main launched with
// DOHC_DEV_TOOLS=1 in an unpackaged build: the preload reports the flag and
// every action's channel is gated again in main. Toggle with Ctrl+Shift+D or
// the bug button in the corner. Nothing here is product; it is a bench.

function useDevPanelOpen(): [boolean, (next: boolean | ((open: boolean) => boolean)) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const meta = event.ctrlKey || event.metaKey;
      if (meta && event.shiftKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return [open, setOpen];
}

function Row(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-muted">{props.label}</span>
      <div className="flex shrink-0 items-center gap-1">{props.children}</div>
    </div>
  );
}

function Act(props: { onClick: () => void; children: ReactNode; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`h-7 rounded-md border border-line px-2.5 text-[11px] transition-colors hover:bg-line/50 ${
        props.danger ? "text-danger hover:text-danger" : "text-muted hover:text-ink"
      }`}
    >
      {props.children}
    </button>
  );
}

export function DevPanel(props: { workspaceId?: string }) {
  const [open, setOpen] = useDevPanelOpen();
  const [status, setStatus] = useState<string | null>(null);
  const [marks, setMarks] = useState<string | null>(null);

  if (!bridge().devTools) return null;

  function run(label: string, action: () => Promise<unknown>) {
    setStatus(null);
    void action()
      .then(() => setStatus(`${label}: done`))
      .catch((error: unknown) =>
        setStatus(`${label}: ${error instanceof Error ? error.message : String(error)}`),
      );
  }

  function setAppearance(patch: { themeMode?: "light" | "dark" | "system"; density?: "comfortable" | "compact"; reduceMotion?: boolean }) {
    run("Appearance", async () => {
      const result = await bridge().getUserSettings();
      await bridge().setUserSettings({
        settings: { ...result.settings, appearance: { ...result.settings.appearance, ...patch } },
      });
    });
  }

  function showMarks() {
    const snapshot = rendererMarks.snapshot();
    const lines = Object.entries(snapshot.measures)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 12)
      .map(([name, ms]) => `${ms.toFixed(0).padStart(6)}ms  ${name}`);
    setMarks(lines.length > 0 ? lines.join("\n") : "No measures yet.");
  }

  return (
    <>
      {open ? (
        <div
          role="dialog"
          aria-label="Dev tools"
          className="dohc-popover dohc-pop-in fixed bottom-[4.5rem] right-3 z-50 flex w-80 flex-col gap-3 rounded-xl border border-line bg-panel p-3 text-ink"
        >
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[12px] font-semibold">
              <Bug size={13} strokeWidth={1.9} aria-hidden className="text-subtle" />
              Dev tools
              <kbd className="rounded border border-line bg-bg px-1 font-mono text-[10px] text-subtle">
                Ctrl Shift D
              </kbd>
            </span>
            <IconButton aria-label="Close dev tools" onClick={() => setOpen(false)}>
              <X size={13} aria-hidden />
            </IconButton>
          </div>

          <Row label="Theme">
            <Act onClick={() => setAppearance({ themeMode: "light" })}>Light</Act>
            <Act onClick={() => setAppearance({ themeMode: "dark" })}>Dark</Act>
            <Act onClick={toggleTheme}>Flip</Act>
          </Row>
          <Row label="Density">
            <Act onClick={() => setAppearance({ density: "comfortable" })}>Comfortable</Act>
            <Act onClick={() => setAppearance({ density: "compact" })}>Compact</Act>
          </Row>
          <Row label="Motion">
            <Act onClick={() => setAppearance({ reduceMotion: false })}>Normal</Act>
            <Act onClick={() => setAppearance({ reduceMotion: true })}>Reduced</Act>
          </Row>

          <div className="h-px bg-line" />

          <Row label="Renderer">
            <Act onClick={() => run("Reload", () => bridge().reloadRenderer())}>Reload</Act>
            <Act onClick={() => run("Relaunch", () => bridge().devRelaunch())}>Relaunch app</Act>
          </Row>
          <Row label="Reveal">
            {props.workspaceId ? (
              <Act
                onClick={() =>
                  run("Reveal", () =>
                    bridge().devRevealPath({ target: "workspace", workspaceId: props.workspaceId }),
                  )
                }
              >
                Workspace
              </Act>
            ) : null}
            <Act onClick={() => run("Reveal", () => bridge().devRevealPath({ target: "state-dir" }))}>
              App data
            </Act>
          </Row>
          <Row label="Reset">
            <Act onClick={() => run("Reset settings", () => bridge().resetUserSettings())}>
              Settings
            </Act>
            <Act danger onClick={() => run("Forget workspaces", () => bridge().devForgetWorkspaces())}>
              Forget all workspaces
            </Act>
          </Row>
          <Row label="Perf">
            <Act onClick={showMarks}>Show measures</Act>
            {marks ? <Act onClick={() => setMarks(null)}>Hide</Act> : null}
          </Row>
          {marks ? (
            <pre className="m-0 max-h-40 overflow-auto rounded-md bg-bg p-2 font-mono text-[10px] leading-4 text-muted">
              {marks}
            </pre>
          ) : null}
          {status ? <p className="m-0 text-[11px] text-subtle">{status}</p> : null}
        </div>
      ) : null}

      <button
        type="button"
        aria-label="Dev tools"
        title="Dev tools (Ctrl+Shift+D)"
        onClick={() => setOpen((current) => !current)}
        className={`fixed bottom-9 right-3 z-50 grid size-7 place-items-center rounded-full border border-line transition-colors ${
          open ? "bg-ink text-bg" : "bg-panel text-subtle hover:text-ink"
        }`}
      >
        <Bug size={13} strokeWidth={1.9} aria-hidden />
      </button>
    </>
  );
}
