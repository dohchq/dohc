import { AlertTriangle, Blocks, Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type {
  OfferedPluginRecord,
  PluginStatusRecord,
} from "../../ipc/bridgeContract";
import { EmptyState, SectionLabel } from "../ui/controls";
import { PluginIcon } from "./PluginIcon";
import {
  actionLabel,
  canInstall,
  isInstalled,
  isPipelineBusy,
  matchesFilter,
  pluginTitle,
  statusText,
  statusTone,
  usePluginCatalog,
} from "./pluginCatalog";

// The plugin browser, in the side panel behind the activity bar's Plugins
// item. VS Code's Extensions view is the model: a filter box pinned at the
// top, Installed above what the workspace merely offers, and one quiet row
// per plugin. A row says what a plugin IS — icon, name, what it does, who
// publishes it, folder, status — and opens the plugin's details tab, which is
// where everything a plugin can DO lives. Install is the one exception: it
// stays here so a workspace's offered plugins can be taken up without a
// detour.
//
// Every line below the name is optional, because every manifest field behind
// it is. A plugin that declares nothing still gets the row it had before
// manifests carried metadata: glyph, id, status, folder.

const installButton =
  "shrink-0 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50";
const retryButton =
  "rounded-md border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink disabled:opacity-50";

export function PluginsView(props: {
  workspaceId: string;
  /** The plugin whose details tab is the active editor tab, so the list can
   * carry the same selected read-out the explorer gives the open file. */
  activePluginId: string | null;
  onOpenDetails: (pluginId: string) => void;
}) {
  const catalog = usePluginCatalog(props.workspaceId);
  const offersLoad = catalog.offersLoad;
  const [filter, setFilter] = useState("");

  const plugins = catalog.load.status === "ready" ? catalog.load.plugins : [];
  const matched = useMemo(
    () => plugins.filter((plugin) => matchesFilter(plugin, filter)),
    [plugins, filter],
  );
  const installedPlugins = matched.filter(isInstalled);
  const candidatePlugins = matched.filter((plugin) => !isInstalled(plugin));
  const offersReady = offersLoad.status === "ready" ? offersLoad.offers : [];
  const offers = useMemo(
    () => offersReady.filter((offer) => matchesFilter(offer, filter)),
    [offersReady, filter],
  );

  function renderRow(plugin: PluginStatusRecord) {
    const busyAction = catalog.busy[plugin.id];
    const disabled = busyAction !== undefined || isPipelineBusy(plugin);
    const selected = props.activePluginId === plugin.id;
    const error = catalog.errors[plugin.id];
    return (
      <li key={plugin.id} className="list-none">
        {/* The row's two controls are siblings, never nested: the name area
            opens the details tab and Install acts in place. Nesting them
            would need a click to be swallowed on its way out. */}
        <div
          data-testid="plugin-row"
          data-plugin-id={plugin.id}
          data-selected={selected ? "true" : undefined}
          className={`flex items-center gap-1 rounded-md pr-1.5 transition-colors ${
            selected ? "bg-line text-ink" : "hover:bg-line/50"
          }`}
        >
          <button
            type="button"
            data-testid="plugin-open-details"
            aria-current={selected ? "page" : undefined}
            onClick={() => props.onOpenDetails(plugin.id)}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ink/30"
          >
            <PluginIcon
              workspaceId={props.workspaceId}
              plugin={plugin}
              glyphSize={15}
              className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-bg text-subtle"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink">
                {pluginTitle(plugin)}
              </span>
              {plugin.description ? (
                <span
                  data-testid="plugin-description"
                  className="mt-0.5 block truncate text-[11px] text-muted"
                >
                  {plugin.description}
                </span>
              ) : null}
              <span className="mt-0.5 flex items-center gap-1 text-[11px]">
                {plugin.error ? (
                  <AlertTriangle
                    size={11}
                    aria-hidden
                    className="shrink-0 text-danger"
                  />
                ) : null}
                <span
                  data-testid="plugin-status"
                  data-status={plugin.status}
                  className={`shrink-0 ${statusTone(plugin)}`}
                >
                  {statusText(plugin)}
                </span>
                {plugin.publisher ? (
                  <>
                    <span aria-hidden className="shrink-0 text-line">
                      ·
                    </span>
                    <span
                      data-testid="plugin-publisher"
                      className="truncate text-subtle"
                    >
                      {plugin.publisher}
                    </span>
                  </>
                ) : null}
                {plugin.directoryName === plugin.id ? null : (
                  <>
                    <span aria-hidden className="shrink-0 text-line">
                      ·
                    </span>
                    <span className="truncate font-mono text-subtle">
                      {`plugins/${plugin.directoryName}`}
                    </span>
                  </>
                )}
              </span>
            </span>
          </button>
          {canInstall(plugin) ? (
            <button
              type="button"
              data-testid="plugin-install"
              disabled={disabled}
              onClick={() => catalog.runAction(plugin, "install")}
              className={installButton}
            >
              {actionLabel("install", busyAction === "install")}
            </button>
          ) : null}
        </div>
        {error ? (
          <p
            data-testid="plugin-action-error"
            role="alert"
            className="m-0 px-1.5 pb-1 text-[11px] text-danger"
          >
            {error}
          </p>
        ) : null}
      </li>
    );
  }

  function renderOfferRow(offer: OfferedPluginRecord) {
    const busyAction = catalog.busy[offer.directoryName];
    const error = catalog.errors[offer.directoryName];
    return (
      <li key={offer.directoryName} className="list-none">
        <div
          data-testid="plugin-offer-row"
          data-plugin-directory={offer.directoryName}
          className="flex items-center gap-1 rounded-md pr-1.5"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2.5 px-1.5 py-1.5">
            <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-bg text-subtle">
              <Blocks size={15} strokeWidth={1.9} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink">
                {offer.displayName ?? offer.directoryName}
              </span>
              {offer.description ? (
                <span className="mt-0.5 block truncate text-[11px] text-muted">
                  {offer.description}
                </span>
              ) : null}
              {offer.publisher ? (
                <span className="mt-0.5 block truncate text-[11px] text-subtle">
                  {offer.publisher}
                </span>
              ) : null}
            </span>
          </div>
          <button
            type="button"
            data-testid="plugin-offer-add"
            disabled={busyAction !== undefined}
            onClick={() => catalog.addOffer(offer)}
            className={installButton}
          >
            {actionLabel("add", busyAction === "add")}
          </button>
        </div>
        {error ? (
          <p
            data-testid="plugin-action-error"
            role="alert"
            className="m-0 px-1.5 pb-1 text-[11px] text-danger"
          >
            {error}
          </p>
        ) : null}
      </li>
    );
  }

  const sections: { testId: string; label: string; rows: ReactNode[] }[] = [
    {
      testId: "plugins-section-installed",
      label: "Installed",
      rows: installedPlugins.map(renderRow),
    },
    {
      testId: "plugins-section-available",
      label: "Available in this workspace",
      rows: candidatePlugins.map(renderRow),
    },
    {
      testId: "plugins-section-offered",
      label: "Built in",
      rows: offers.map(renderOfferRow),
    },
  ].filter((section) => section.rows.length > 0);

  return (
    <div data-testid="plugins-view" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line px-2 py-2">
        <div className="flex items-center gap-1.5 rounded-md border border-line bg-bg px-1.5 py-1 transition-colors focus-within:border-ink">
          <Search size={12} aria-hidden className="shrink-0 text-subtle" />
          <input
            type="text"
            data-testid="plugins-filter"
            aria-label="Search plugins"
            placeholder="Search plugins"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-subtle"
          />
        </div>
      </div>

      {catalog.load.status === "loading" ? (
        <div className="flex flex-1 items-center justify-center px-4 text-xs text-subtle">
          Loading plugins…
        </div>
      ) : catalog.load.status === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <AlertTriangle size={18} aria-hidden className="text-warning" />
          <p
            data-testid="plugins-load-error"
            role="alert"
            className="m-0 text-[11px] text-danger"
          >
            {catalog.load.message}
          </p>
          <button type="button" onClick={catalog.reload} className={retryButton}>
            Retry
          </button>
        </div>
      ) : plugins.length === 0 && offersReady.length === 0 && offersLoad.status !== "error" ? (
        <div data-testid="plugins-empty" className="flex min-h-0 flex-1 flex-col">
          <EmptyState
            title="No plugins yet"
            hint="Ask your agent to add a plugin folder under plugins/."
          />
        </div>
      ) : matched.length === 0 && offers.length === 0 && offersLoad.status !== "error" ? (
        <div data-testid="plugins-filter-empty" className="flex min-h-0 flex-1 flex-col">
          <EmptyState
            title={`No plugins match "${filter.trim()}"`}
            hint="Try a shorter search."
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-1 py-2">
          {sections.map((section, index) => (
            <section
              key={section.testId}
              data-testid={section.testId}
              className={index > 0 ? "mt-4" : undefined}
            >
              <SectionLabel className="block px-2 pb-1">{section.label}</SectionLabel>
              <ul className="m-0 flex list-none flex-col p-0">{section.rows}</ul>
            </section>
          ))}
          {offersLoad.status === "error" ? (
            <section
              data-testid="plugins-offers-error"
              className={sections.length > 0 ? "mt-4" : undefined}
            >
              <SectionLabel className="block px-2 pb-1">Built in</SectionLabel>
              <div className="flex flex-col items-start gap-2 px-2 py-1.5">
                <p role="alert" className="m-0 text-[11px] text-danger">
                  {offersLoad.message}
                </p>
                <button type="button" onClick={catalog.reload} className={retryButton}>
                  Retry
                </button>
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
