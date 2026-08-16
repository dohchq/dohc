import { AlertTriangle, Blocks, ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PluginStatusRecord } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { IncrementalMarkdownDocument } from "./markdown/IncrementalMarkdownDocument";
import { MARKDOWN_COMPONENTS } from "./markdown/markdownComponents";
import { parseFrontmatter } from "./markdown/frontmatter";
import { Overlay } from "./Overlay";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import {
  actionLabel,
  canApprove,
  canDisable,
  canEnable,
  canInstall,
  canOpenWebApps,
  canRetryInstall,
  isInstalled,
  isPipelineBusy,
  statusText,
  statusTone,
  usePluginCatalog,
  webAppKey,
} from "./workbench/pluginCatalog";

// One plugin's page, opened as an editor tab from the plugins list. VS Code's
// extension page is the model: identity and every action at the top, then
// what the plugin says about itself. The list stays a list — it shows what a
// plugin IS and offers only Install; everything a plugin can DO lives here.

const dangerButton =
  "rounded-lg border border-danger/40 bg-transparent px-3 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10 disabled:opacity-50";

// The page title is the document's one h1, so the README's own headings shift
// down a level. A README almost always opens by repeating the plugin's name,
// and two competing h1s leave the page with no outline.
const README_COMPONENTS = {
  ...MARKDOWN_COMPONENTS,
  h1: MARKDOWN_COMPONENTS.h2,
  h2: MARKDOWN_COMPONENTS.h3,
};

type ReadmeState =
  | { status: "loading" }
  | { status: "ready"; body: string }
  | { status: "absent" }
  | { status: "error"; message: string };

// Electron wraps a rejected handler's error; the workspace surfaces strip the
// wrapper before showing the reason (WorkspaceVersions precedent).
function readableReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  const stripped = raw.replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    "",
  );
  return stripped.length > 0 ? stripped : "Try again.";
}

// ENOENT is the file system's own answer to "is it there", carried out on the
// only channel a renderer gets. A plugin with no README is the ordinary case
// and must not read as a failure, so absence keeps its own quiet state.
function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && /\bENOENT\b/.test(error.message);
}

export function readmePath(directoryName: string): string {
  return `plugins/${directoryName}/README.md`;
}

function useReadme(workspaceId: string, directoryName: string): ReadmeState {
  const [state, setState] = useState<ReadmeState>({ status: "loading" });
  // The request token is the whole guard: this effect re-runs for every
  // workspace or folder change and its cleanup raises the token, so a read
  // for the folder the plugin no longer has can never repaint this one.
  const requestToken = useRef(0);

  useEffect(() => {
    const request = ++requestToken.current;
    setState({ status: "loading" });
    void bridge()
      .readWorkspaceText({
        workspaceId,
        relativePath: readmePath(directoryName),
      })
      .then((result) => {
        if (request !== requestToken.current) return;
        const body = parseFrontmatter(result.text).body.trim();
        setState(
          body.length > 0 ? { status: "ready", body } : { status: "absent" },
        );
      })
      .catch((error: unknown) => {
        if (request !== requestToken.current) return;
        setState(
          isMissingFileError(error)
            ? { status: "absent" }
            : { status: "error", message: readableReason(error) },
        );
      });
    return () => {
      requestToken.current += 1;
    };
  }, [workspaceId, directoryName]);

  return state;
}

function PluginReadme(props: { workspaceId: string; directoryName: string }) {
  const readme = useReadme(props.workspaceId, props.directoryName);

  if (readme.status === "loading") {
    return (
      <p data-testid="plugin-readme-loading" className="m-0 text-xs text-subtle">
        Loading the README…
      </p>
    );
  }
  if (readme.status === "absent") {
    return (
      <p data-testid="plugin-readme-absent" className="m-0 text-xs text-subtle">
        This plugin has no README.
      </p>
    );
  }
  if (readme.status === "error") {
    return (
      <p
        data-testid="plugin-readme-error"
        role="alert"
        className="m-0 text-xs text-danger"
      >
        {`dohc could not read ${readmePath(props.directoryName)}. ${readme.message}`}
      </p>
    );
  }
  return (
    <div
      data-testid="plugin-readme"
      className="dohc-readable-text max-w-3xl text-[15px]"
    >
      {/* Workspace links are left unwired: a README's relative links point
          inside the plugin folder, not at pages the user opened this tab to
          reach. External links still route through the audited open path. */}
      <IncrementalMarkdownDocument
        body={readme.body}
        components={README_COMPONENTS}
      />
    </div>
  );
}

export function PluginDetailsPage(props: {
  workspaceId: string;
  pluginId: string;
}) {
  const catalog = usePluginCatalog(props.workspaceId);
  const plugin =
    catalog.load.status === "ready"
      ? (catalog.load.plugins.find((entry) => entry.id === props.pluginId) ?? null)
      : null;

  if (catalog.load.status === "loading") {
    return (
      <div
        data-testid="plugin-details-loading"
        className="flex min-h-0 flex-1 items-center justify-center bg-bg text-sm text-subtle"
      >
        Loading this plugin…
      </div>
    );
  }

  if (catalog.load.status === "error") {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-bg px-6 text-center">
        <AlertTriangle size={20} aria-hidden className="text-warning" />
        <p
          data-testid="plugin-details-load-error"
          role="alert"
          className="m-0 text-sm text-danger"
        >
          {catalog.load.message}
        </p>
        <SecondaryButton onClick={catalog.reload}>Retry</SecondaryButton>
      </div>
    );
  }

  if (!plugin) {
    return (
      <div
        data-testid="plugin-details-missing"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-bg px-6 text-center"
      >
        <Blocks size={22} aria-hidden className="text-line" />
        <p className="m-0 text-sm text-muted">
          {`${props.pluginId} is not in this workspace.`}
        </p>
        <p className="m-0 text-[11px] text-subtle">Close this tab to go back.</p>
      </div>
    );
  }

  return (
    <div
      data-testid="plugin-details-page"
      data-plugin-id={plugin.id}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg"
    >
      <PluginDetailsHeader
        plugin={plugin}
        catalog={catalog}
        workspaceId={props.workspaceId}
      />
      <section className="border-t border-line px-6 py-5">
        <PluginReadme
          workspaceId={props.workspaceId}
          directoryName={plugin.directoryName}
        />
      </section>
      {catalog.confirmation ? (
        <PluginUninstallDialog catalog={catalog} />
      ) : null}
    </div>
  );
}

function PluginDetailsHeader(props: {
  plugin: PluginStatusRecord;
  catalog: ReturnType<typeof usePluginCatalog>;
  workspaceId: string;
}) {
  const { plugin, catalog } = props;
  const busyAction = catalog.busy[plugin.id];
  const disabled = busyAction !== undefined || isPipelineBusy(plugin);
  const actionError = catalog.errors[plugin.id];

  return (
    <header className="px-6 pb-5 pt-6">
      <div className="flex items-start gap-4">
        <span className="grid size-14 shrink-0 place-items-center rounded-xl border border-line bg-panel text-subtle">
          <Blocks size={26} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="m-0 truncate text-xl font-semibold tracking-tight text-ink">
            {plugin.id}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <span
              data-testid="plugin-status"
              data-status={plugin.status}
              className={statusTone(plugin)}
            >
              {statusText(plugin)}
            </span>
            <span aria-hidden className="text-line">
              ·
            </span>
            {/* The list row hides this when the folder repeats the id, because
                a dense row cannot spend a line on it. A reference page always
                answers where the plugin lives. */}
            <span className="truncate font-mono text-subtle">
              {`plugins/${plugin.directoryName}`}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {canInstall(plugin) ? (
          <PrimaryButton
            data-testid="plugin-install"
            disabled={disabled}
            onClick={() => catalog.runAction(plugin, "install")}
          >
            {actionLabel("install", busyAction === "install")}
          </PrimaryButton>
        ) : null}
        {canRetryInstall(plugin) ? (
          <PrimaryButton
            data-testid="plugin-retry-install"
            disabled={disabled}
            onClick={() => catalog.runAction(plugin, "install")}
          >
            {busyAction === "install" ? "Retrying install" : "Retry install"}
          </PrimaryButton>
        ) : null}
        {canOpenWebApps(plugin)
          ? plugin.webApps.map((webApp) => {
              const key = webAppKey(plugin.id, webApp.id);
              return (
                <SecondaryButton
                  key={webApp.id}
                  data-testid="plugin-open-web-app"
                  data-web-app-id={webApp.id}
                  disabled={disabled || catalog.openingWebApp !== null}
                  onClick={() => catalog.openWebApp(plugin, webApp.id)}
                >
                  {catalog.openingWebApp === key
                    ? `Opening ${webApp.title}`
                    : `Open ${webApp.title}`}
                </SecondaryButton>
              );
            })
          : null}
        {canEnable(plugin) ? (
          <SecondaryButton
            data-testid="plugin-enable"
            disabled={disabled}
            onClick={() => catalog.runAction(plugin, "enable")}
          >
            {actionLabel("enable", busyAction === "enable")}
          </SecondaryButton>
        ) : null}
        {canApprove(plugin) ? (
          <SecondaryButton
            data-testid="plugin-approve"
            disabled={disabled}
            onClick={() => catalog.runAction(plugin, "approve")}
          >
            {actionLabel("approve", busyAction === "approve")}
          </SecondaryButton>
        ) : null}
        {canDisable(plugin) ? (
          <SecondaryButton
            data-testid="plugin-disable"
            disabled={disabled}
            onClick={() => catalog.runAction(plugin, "disable")}
          >
            {actionLabel("disable", busyAction === "disable")}
          </SecondaryButton>
        ) : null}
        {isInstalled(plugin) ? (
          <button
            type="button"
            data-testid="plugin-uninstall"
            disabled={disabled}
            onClick={() => catalog.prepareUninstall(plugin)}
            className={dangerButton}
          >
            {actionLabel("preflight", busyAction === "preflight")}
          </button>
        ) : null}
      </div>

      {actionError ? (
        <p
          data-testid="plugin-action-error"
          role="alert"
          className="m-0 mt-3 text-xs text-danger"
        >
          {actionError}
        </p>
      ) : null}
      {plugin.error ? (
        <p
          data-testid="plugin-pipeline-error"
          className="m-0 mt-3 text-xs text-danger"
        >
          {plugin.error.message}
        </p>
      ) : null}
      {plugin.warnings.length > 0 ? (
        <PluginSkippedHooks warnings={plugin.warnings} />
      ) : null}
    </header>
  );
}

// The lifecycle scan writes one line per package whose install hook the
// manifest lets dohc skip, so the list grows with the dependency tree. It
// records a protection that held, so it stays a count until the reader asks.
function PluginSkippedHooks(props: { warnings: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const count = props.warnings.length;

  return (
    <div
      data-testid="plugin-warnings"
      className="mt-3 max-w-3xl overflow-hidden rounded-lg border border-line"
    >
      <button
        type="button"
        data-testid="plugin-warnings-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] text-muted transition-colors hover:bg-line/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
      >
        {expanded ? (
          <ChevronDown size={12} aria-hidden className="shrink-0 text-subtle" />
        ) : (
          <ChevronRight size={12} aria-hidden className="shrink-0 text-subtle" />
        )}
        <span className="min-w-0 truncate">
          {`dohc skipped ${count} install hook${count === 1 ? "" : "s"} in this plugin's packages`}
        </span>
      </button>
      {expanded ? (
        <div className="border-t border-line px-2.5 py-2">
          <p className="m-0 text-[11px] text-subtle">
            dohc turns these hooks off during install. None of them ran.
          </p>
          <ul
            data-testid="plugin-warnings-list"
            className="m-0 mt-1.5 max-h-48 list-none space-y-0.5 overflow-y-auto p-0"
          >
            {props.warnings.map((warning) => (
              <li
                key={warning}
                className="break-all font-mono text-[11px] leading-snug text-muted"
              >
                {warning}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function PluginUninstallDialog(props: {
  catalog: ReturnType<typeof usePluginCatalog>;
}) {
  const { catalog } = props;
  const confirmation = catalog.confirmation;
  if (!confirmation) return null;
  const uninstalling = catalog.busy[confirmation.plugin.id] === "uninstall";
  const warning = confirmation.preflight.warning;

  return (
    <Overlay
      onClose={() => {
        if (!uninstalling) catalog.cancelUninstall();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-uninstall-title"
        data-testid="plugin-uninstall-dialog"
        className="dohc-elevated flex max-h-[calc(100vh-32px)] w-[min(520px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-line bg-panel"
      >
        <div className="min-h-0 overflow-auto p-5">
          <h2
            id="plugin-uninstall-title"
            className="m-0 text-sm font-semibold text-ink"
          >
            {`Uninstall ${confirmation.plugin.id}?`}
          </h2>
          <p className="m-0 mt-2 text-xs text-muted">
            This removes the plugin source and build files from this workspace.
          </p>
          {warning ? (
            <div
              data-testid="plugin-uninstall-warning"
              className="mt-4 rounded-lg border border-warning/40 bg-warning/10 p-3"
            >
              <div className="flex items-start gap-2 text-xs text-warning">
                <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />
                <p className="m-0">{warning.summary}</p>
              </div>
              <ul className="mb-0 mt-2 space-y-1 pl-5 text-[11px] text-muted">
                {warning.details.map((detail) => (
                  <li key={detail}>{detail}</li>
                ))}
              </ul>
              {warning.notRecoverablePathSample.length > 0 ? (
                <div className="mt-3">
                  <p className="m-0 text-[11px] font-medium text-danger">
                    dohc cannot confirm history holds these files:
                  </p>
                  <ul
                    data-testid="plugin-uninstall-not-recoverable"
                    className="mb-0 mt-1 list-none space-y-1 p-0"
                  >
                    {warning.notRecoverablePathSample.map((path) => (
                      <li
                        key={path}
                        className="break-all rounded border border-danger/30 bg-bg px-2 py-1 font-mono text-[11px] text-danger"
                      >
                        {path}
                      </li>
                    ))}
                  </ul>
                  {warning.counts.notRecoverableFromHistory >
                  warning.notRecoverablePathSample.length ? (
                    <p
                      data-testid="plugin-uninstall-not-recoverable-more"
                      className="m-0 mt-1 text-[11px] text-danger"
                    >
                      {`and ${
                        warning.counts.notRecoverableFromHistory -
                        warning.notRecoverablePathSample.length
                      } more`}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-line p-3">
          <SecondaryButton
            autoFocus
            disabled={uninstalling}
            onClick={catalog.cancelUninstall}
          >
            Cancel
          </SecondaryButton>
          <button
            type="button"
            data-testid="plugin-uninstall-confirm"
            disabled={uninstalling}
            onClick={catalog.confirmUninstall}
            className="rounded-lg bg-danger px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {actionLabel("uninstall", uninstalling)}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
