import { AlertTriangle, Blocks, ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PluginSizesRecord, PluginStatusRecord } from "../ipc/bridgeContract";
import { formatSize } from "../plugins/pluginFormat";
import {
  isHttpsUrl,
  MAX_SETTING_VALUE_CHARS,
  type PluginSettingDeclaration,
  type PluginSettingValue,
} from "../plugins/pluginManifestSchema";
import { activateReadOnlyLinkHref } from "./editor/linkMenu";
import { SettingRow, SwitchControl } from "./settings/SettingRow";
import { bridge } from "./bridge";
import { IncrementalMarkdownDocument } from "./markdown/IncrementalMarkdownDocument";
import { MARKDOWN_COMPONENTS } from "./markdown/markdownComponents";
import { parseFrontmatter } from "./markdown/frontmatter";
import { Overlay } from "./Overlay";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { PluginIcon } from "./workbench/PluginIcon";
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
  pluginTitle,
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

function readmePath(directoryName: string): string {
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

// A plugin's own settings, declared in its manifest and answered here. The
// controls are dohc's own — the same SettingRow the app's Settings dialog
// uses — so a plugin's settings read like part of dohc rather than a form a
// plugin drew for itself.
//
// A switch or a select commits the moment it changes. Text and number commit
// when the field is left, because every commit writes the workspace file and
// tells the running plugin, and a plugin should not hear from a user's
// keystrokes one at a time.
function PluginSettingsSection(props: {
  workspaceId: string;
  plugin: PluginStatusRecord;
}) {
  const { plugin } = props;
  const [values, setValues] = useState<Record<string, PluginSettingValue> | null>(
    null,
  );
  const [failure, setFailure] = useState<string | null>(null);
  // One token guards every response: the effect re-runs for each workspace or
  // plugin, and its cleanup raises the token, so an answer for the plugin this
  // page no longer shows can never repaint it.
  const requestToken = useRef(0);

  const declaredCount = plugin.settings.length;

  useEffect(() => {
    const request = ++requestToken.current;
    setValues(null);
    setFailure(null);
    // A plugin with no settings has no controls to fill, so main is never
    // asked for values this page would not show.
    if (declaredCount === 0) return;
    void bridge()
      .getPluginSettings({
        workspaceId: props.workspaceId,
        pluginId: plugin.id,
      })
      .then((result) => {
        if (request !== requestToken.current) return;
        if (result.ok) setValues(result.values);
        else setFailure(result.message);
      })
      .catch((error: unknown) => {
        if (request !== requestToken.current) return;
        setFailure(readableReason(error));
      });
    return () => {
      requestToken.current += 1;
    };
  }, [props.workspaceId, plugin.id, declaredCount]);

  const commit = (key: string, value: PluginSettingValue) => {
    // Shown at once so a control never feels stuck, then replaced by whatever
    // main actually stored.
    setValues((current) => (current ? { ...current, [key]: value } : current));
    const request = requestToken.current;
    void bridge()
      .setPluginSettings({
        workspaceId: props.workspaceId,
        pluginId: plugin.id,
        values: { [key]: value },
      })
      .then((result) => {
        if (request !== requestToken.current) return;
        if (result.ok) {
          setValues(result.values);
          setFailure(null);
          return;
        }
        setFailure(result.message);
      })
      .catch((error: unknown) => {
        if (request !== requestToken.current) return;
        setFailure(readableReason(error));
      });
  };

  if (plugin.settings.length === 0) return null;

  return (
    <section
      data-testid="plugin-settings"
      className="border-t border-line px-6 py-5"
    >
      <h2 className="m-0 text-sm font-semibold text-ink">Settings</h2>
      {failure ? (
        <p
          data-testid="plugin-settings-error"
          role="alert"
          className="m-0 mt-2 text-xs text-danger"
        >
          {`dohc could not save this setting. ${failure}`}
        </p>
      ) : null}
      {values === null ? (
        <p
          data-testid="plugin-settings-loading"
          className="m-0 mt-2 text-xs text-subtle"
        >
          Loading settings…
        </p>
      ) : (
        <div className="mt-2 max-w-3xl">
          {plugin.settings.map((setting) => (
            <PluginSettingControl
              key={setting.key}
              setting={setting}
              value={values[setting.key] ?? setting.default}
              onCommit={(value) => commit(setting.key, value)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PluginSettingControl(props: {
  setting: PluginSettingDeclaration;
  value: PluginSettingValue;
  onCommit: (value: PluginSettingValue) => void;
}) {
  const { setting, value } = props;
  return (
    <SettingRow
      title={setting.label}
      description={setting.description}
      testId={`plugin-setting-${setting.key}`}
      modified={value !== setting.default}
      onReset={() => props.onCommit(setting.default)}
    >
      {setting.type === "boolean" ? (
        <SwitchControl
          label={setting.label}
          checked={value === true}
          onChange={props.onCommit}
        />
      ) : setting.type === "select" ? (
        <select
          aria-label={setting.label}
          data-testid={`plugin-setting-input-${setting.key}`}
          value={String(value)}
          onChange={(event) => props.onCommit(event.target.value)}
          className="h-8 w-56 rounded-md border border-line bg-bg px-2 text-[12px] text-ink focus:border-ink"
        >
          {setting.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <PluginSettingTextControl
          setting={setting}
          value={value}
          onCommit={props.onCommit}
        />
      )}
    </SettingRow>
  );
}

// Text and number share one control: both hold what the user is typing and
// hand it over when they leave the field. A number that cannot be read as one
// is not saved — the field returns to the value that is stored, so the reader
// sees what the plugin actually has.
function PluginSettingTextControl(props: {
  setting: PluginSettingDeclaration & { type: "string" | "number" };
  value: PluginSettingValue;
  onCommit: (value: PluginSettingValue) => void;
}) {
  const { setting } = props;
  const stored = String(props.value);
  const [draft, setDraft] = useState(stored);
  const [editing, setEditing] = useState(false);

  const commit = () => {
    setEditing(false);
    if (setting.type === "number") {
      const parsed = Number(draft);
      if (draft.trim() === "" || !Number.isFinite(parsed)) {
        setDraft(stored);
        return;
      }
      props.onCommit(parsed);
      return;
    }
    props.onCommit(draft);
  };

  return (
    <input
      type={setting.type === "number" ? "number" : "text"}
      spellCheck={false}
      aria-label={setting.label}
      data-testid={`plugin-setting-input-${setting.key}`}
      value={editing ? draft : stored}
      maxLength={setting.type === "string" ? MAX_SETTING_VALUE_CHARS : undefined}
      onFocus={() => {
        setDraft(stored);
        setEditing(true);
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(stored);
          setEditing(false);
          event.currentTarget.blur();
        }
      }}
      className="h-7 w-56 rounded-md border border-line bg-bg px-2 text-[12px] text-ink placeholder:text-subtle focus:border-ink"
    />
  );
}

// The right rail: what dohc knows about this plugin as an installation,
// beside the README that says what it does. VS Code's extension page is the
// model, minus every row that needs a marketplace — no ratings, no install
// count, no published or updated date, no categories, because dohc has no
// marketplace to publish through and no taxonomy to sort a plugin into. What
// stands in their place is the one thing dohc knows and a marketplace cannot:
// the content hash the user approved, which is what dohc actually runs.
//
// Every row appears only where its fact exists, and a section with no rows
// does not print its heading. Nothing here is ever blanked or dashed out: a
// reader must never have to work out whether dohc lost a fact or the plugin
// never declared one.

// Enough hash to tell two builds apart by eye. The whole digest is on the
// element for anyone who needs to compare it in full.
const RAIL_HASH_CHARS = 12;

type RailRow = { label: string; testId: string; value: ReactNode };

type SizesState =
  | { status: "loading" }
  | { status: "ready"; sizes: PluginSizesRecord }
  | { status: "unavailable" };

/**
 * Measures on mount, because these are bytes on disk rather than a recorded
 * fact and they change with every build. A failure answers "unavailable" and
 * the rows simply do not appear — a size dohc could not read is not a size
 * worth printing, and this rail has nothing the reader must act on.
 */
function usePluginSizes(workspaceId: string, pluginId: string): SizesState {
  const [state, setState] = useState<SizesState>({ status: "loading" });
  // The same guard the README and the settings section use: the effect
  // re-runs for every workspace or plugin and its cleanup raises the token,
  // so a measurement of the workspace the user just left can never repaint
  // the workspace they are now looking at.
  const requestToken = useRef(0);

  useEffect(() => {
    const request = ++requestToken.current;
    setState({ status: "loading" });
    void bridge()
      .pluginSizes({ workspaceId, pluginId })
      .then((result) => {
        if (request !== requestToken.current) return;
        setState(
          result.ok
            ? { status: "ready", sizes: result.sizes }
            : { status: "unavailable" },
        );
      })
      .catch(() => {
        if (request !== requestToken.current) return;
        setState({ status: "unavailable" });
      });
    return () => {
      requestToken.current += 1;
    };
  }, [workspaceId, pluginId]);

  return state;
}

function RailMono(props: { children: string; title?: string }) {
  return (
    <span
      title={props.title}
      className="block break-all font-mono text-[11px] leading-snug text-muted"
    >
      {props.children}
    </span>
  );
}

/**
 * A link out of dohc. It goes through the same audited path the README's own
 * links take — activateReadOnlyLinkHref preventDefaults and hands the URL to
 * the openExternalUrl IPC, which is the only route from this renderer to the
 * OS browser. Click, middle-click, and Enter all route the same way.
 */
function RailLink(props: { href: string }) {
  const activate = (
    event:
      | React.MouseEvent<HTMLAnchorElement>
      | React.KeyboardEvent<HTMLAnchorElement>,
  ) => activateReadOnlyLinkHref(props.href, event);
  return (
    <a
      href={props.href}
      title={props.href}
      onClick={activate}
      onAuxClick={(event) => {
        if (event.button === 1) activate(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") activate(event);
      }}
      className="block truncate text-[11px] leading-snug text-accent underline"
    >
      {props.href.replace(/^https:\/\//, "")}
    </a>
  );
}

function RailSection(props: { title: string; rows: RailRow[] }) {
  if (props.rows.length === 0) return null;
  return (
    <section className="mt-5 first:mt-0">
      <h2 className="m-0 text-[10px] font-semibold uppercase tracking-wider text-subtle">
        {props.title}
      </h2>
      <dl className="m-0 mt-2">
        {props.rows.map((row) => (
          <div key={row.testId} data-testid={row.testId} className="mt-2 first:mt-0">
            <dt className="text-[11px] leading-snug text-subtle">{row.label}</dt>
            <dd className="m-0 text-[11px] leading-snug text-muted">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function PluginDetailsRail(props: {
  workspaceId: string;
  plugin: PluginStatusRecord;
}) {
  const { plugin } = props;
  const sizes = usePluginSizes(props.workspaceId, plugin.id);

  const installation: RailRow[] = [
    {
      label: "Identifier",
      testId: "plugin-identifier",
      value: <RailMono>{plugin.id}</RailMono>,
    },
  ];
  if (plugin.pluginVersion !== null) {
    installation.push({
      label: "Version",
      testId: "plugin-rail-version",
      value: plugin.pluginVersion,
    });
  }
  if (plugin.approvedHash !== null) {
    installation.push({
      label: "Approved source",
      testId: "plugin-rail-approved-source",
      value: (
        <RailMono title={plugin.approvedHash}>
          {plugin.approvedHash.slice(0, RAIL_HASH_CHARS)}
        </RailMono>
      ),
    });
  }
  // Both size rows read the same measurement and say the same thing while it
  // runs. A size dohc could not read prints nothing at all — see usePluginSizes.
  const measured = sizes.status === "ready" ? sizes.sizes : null;
  const sizeRows: Array<[label: string, testId: string, bytes: number | null]> = [
    ["Installed size", "plugin-rail-installed-size", measured?.installedBytes ?? null],
    ["Stored data", "plugin-rail-stored-data", measured?.dataBytes ?? null],
  ];
  for (const [label, testId, bytes] of sizeRows) {
    if (sizes.status === "loading") {
      installation.push({
        label,
        testId,
        value: <span className="text-subtle">Measuring…</span>,
      });
    } else if (bytes !== null) {
      installation.push({ label, testId, value: formatSize(bytes) });
    }
  }

  const resources: RailRow[] = [];
  if (plugin.repository !== null) {
    resources.push({
      label: "Repository",
      testId: "plugin-rail-repository",
      value: <RailLink href={plugin.repository} />,
    });
  }
  if (plugin.issues !== null) {
    resources.push({
      label: "Issues",
      testId: "plugin-rail-issues",
      value: <RailLink href={plugin.issues} />,
    });
  }
  if (plugin.license !== null) {
    resources.push({
      label: "License",
      testId: "plugin-rail-license",
      value: isHttpsUrl(plugin.license) ? (
        <RailLink href={plugin.license} />
      ) : (
        plugin.license
      ),
    });
  }

  return (
    <aside
      data-testid="plugin-details-rail"
      aria-label="Plugin details"
      className="w-full shrink-0 border-t border-line px-6 py-5 lg:w-60 lg:border-l lg:border-t-0"
    >
      <RailSection title="Installation" rows={installation} />
      <RailSection title="Resources" rows={resources} />
    </aside>
  );
}

export function PluginDetailsPage(props: {
  workspaceId: string;
  pluginId: string;
  /** Reports what this plugin calls itself, so its tab can carry the name the
   * user installed instead of the raw plugin id. This page is the only surface
   * that reads the plugin's manifest, the same way the web app page is the
   * only one that hears its app's title. */
  onTitle?: (pluginId: string, title: string) => void;
}) {
  const catalog = usePluginCatalog(props.workspaceId);
  const plugin =
    catalog.load.status === "ready"
      ? (catalog.load.plugins.find((entry) => entry.id === props.pluginId) ?? null)
      : null;

  // Held in a ref so a new callback identity never re-reports, and written
  // after the commit: a ref written while rendering keeps the value of a
  // render React discarded (PluginWebAppPage precedent).
  const onTitleRef = useRef(props.onTitle);
  useEffect(() => {
    onTitleRef.current = props.onTitle;
  });
  const title = plugin ? pluginTitle(plugin) : null;
  useEffect(() => {
    if (title !== null) onTitleRef.current?.(props.pluginId, title);
  }, [props.pluginId, title]);

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
      {/* The rail sits beside the content on a wide window and drops below it
          on a narrow one, so a reader never has to scroll sideways to read
          the README. */}
      <div className="flex flex-col lg:flex-row lg:items-stretch">
        <div className="flex min-w-0 flex-1 flex-col">
          <PluginDetailsHeader
            plugin={plugin}
            catalog={catalog}
            workspaceId={props.workspaceId}
          />
          <PluginSettingsSection
            workspaceId={props.workspaceId}
            plugin={plugin}
          />
          <section className="border-t border-line px-6 py-5">
            <PluginReadme
              workspaceId={props.workspaceId}
              directoryName={plugin.directoryName}
            />
          </section>
        </div>
        <PluginDetailsRail workspaceId={props.workspaceId} plugin={plugin} />
      </div>
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
        <PluginIcon
          workspaceId={props.workspaceId}
          plugin={plugin}
          glyphSize={26}
          className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-panel text-subtle"
        />
        <div className="min-w-0 flex-1">
          <h1 className="m-0 truncate text-xl font-semibold tracking-tight text-ink">
            {pluginTitle(plugin)}
          </h1>
          {plugin.description ? (
            <p
              data-testid="plugin-description"
              className="m-0 mt-1 max-w-2xl text-[13px] text-muted"
            >
              {plugin.description}
            </p>
          ) : null}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            {plugin.publisher ? (
              <>
                <span data-testid="plugin-publisher" className="text-muted">
                  {plugin.publisher}
                </span>
                <span aria-hidden className="text-line">
                  ·
                </span>
              </>
            ) : null}
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
            {/* The id a plugin is installed and acted on under is the rail's
                first row now, where it reads as a fact rather than as one
                more chip after the status. */}
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
