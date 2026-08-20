// The sites list: dohc's activity-bar view for this plugin.
//
// It reads the workspace through the SDK, works out what the workspace holds
// with the same detection the plugin's Node half uses, and opens one preview
// tab per site. Opening a tab is the only thing it asks dohc to do that a
// plugin's own process cannot.

import { applyTheme, request, subscribe } from "./dohc.js";
import {
  availableModes,
  discoverSites,
  previewInstanceKey,
  SITE_SIGNAL_FILES,
} from "./sites.js";

const countOutput = /** @type {HTMLElement} */ (document.getElementById("count"));
const stateOutput = /** @type {HTMLElement} */ (document.getElementById("state"));
const listOutput = /** @type {HTMLElement} */ (document.getElementById("sites"));
const errorOutput = /** @type {HTMLElement} */ (document.getElementById("error"));
const refreshButton = /** @type {HTMLButtonElement} */ (document.getElementById("refresh"));

/** Raised for every load, so a slow answer never repaints a later one. */
let loadToken = 0;
let refreshTimeout = null;

/** @param {string} message */
function showError(message) {
  errorOutput.textContent = message;
  errorOutput.hidden = false;
}

function clearError() {
  errorOutput.textContent = "";
  errorOutput.hidden = true;
}

/**
 * @param {string} heading
 * @param {string} [detail]
 */
function showState(heading, detail) {
  listOutput.hidden = true;
  stateOutput.hidden = false;
  stateOutput.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = heading;
  stateOutput.append(strong);
  if (detail) {
    const span = document.createElement("span");
    span.textContent = detail;
    stateOutput.append(span);
  }
}

/** @param {import("./sites.js").WorkspaceSite} site */
function diagnosticLabel(site) {
  const diagnostic =
    site.diagnostics.find((entry) => entry.severity === "error") ?? site.diagnostics[0];
  if (!diagnostic) return null;
  const prefix = diagnostic.severity === "error" ? "Error" : "Warning";
  const detail = diagnostic.message || diagnostic.code;
  return diagnostic.path ? `${prefix}: ${detail} (${diagnostic.path})` : `${prefix}: ${detail}`;
}

/** The workspace path of a site's own page, for opening it in dohc. */
function entryPath(site) {
  if (!site.entry) return null;
  return site.root === "" ? site.entry : `${site.root}/${site.entry}`;
}

/**
 * @param {string} method
 * @param {unknown} params
 */
async function ask(method, params) {
  try {
    clearError();
    return await request(method, params);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** @param {import("./sites.js").WorkspaceSite} site */
function renderSite(site) {
  const item = document.createElement("li");
  const card = document.createElement("div");
  card.className = "site";

  const open = document.createElement("button");
  open.type = "button";
  open.className = "open";
  open.dataset.testid = "sites-row";
  open.dataset.root = site.root;

  const title = document.createElement("span");
  title.className = "title";
  const name = document.createElement("span");
  name.textContent = site.title;
  title.append(name);

  if (site.shared) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.dataset.testid = "sites-shared-label";
    tag.textContent = "Shared";
    title.append(tag);
  }
  if (site.confidence === "low") {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.dataset.testid = "sites-low-confidence";
    tag.title = "dohc is not sure this is a site.";
    tag.textContent = "Maybe";
    title.append(tag);
  }
  open.append(title);

  const root = document.createElement("span");
  root.className = "root";
  root.textContent = site.root === "" ? "." : site.root;
  open.append(root);

  const warning = diagnosticLabel(site);
  if (warning) {
    const note = document.createElement("span");
    note.className = "warning";
    note.dataset.testid = "sites-diagnostic";
    note.textContent = warning;
    open.append(note);
  }

  const modes = availableModes(site);
  open.addEventListener("click", () => {
    void ask("ui.openWebApp", {
      webAppId: "preview",
      instanceKey: previewInstanceKey(site.root, "auto"),
    });
  });
  card.append(open);

  const actions = document.createElement("div");
  actions.className = "actions";
  for (const mode of modes) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.testid = `sites-mode-${mode}`;
    button.dataset.root = site.root;
    button.textContent = mode;
    button.title = `Open this site in ${mode} mode.`;
    button.addEventListener("click", () => {
      void ask("ui.openWebApp", {
        webAppId: "preview",
        instanceKey: previewInstanceKey(site.root, mode),
      });
    });
    actions.append(button);
  }

  const page = entryPath(site);
  if (page) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.testid = "sites-open-file";
    button.textContent = "Open page";
    button.title = `Open ${page} in dohc.`;
    button.addEventListener("click", () => {
      void ask("ui.open", { target: page });
    });
    actions.append(button);
  }
  if (actions.childElementCount > 0) card.append(actions);

  item.append(card);
  return item;
}

/** @param {import("./sites.js").WorkspaceSite[]} sites */
function renderSites(sites) {
  countOutput.textContent = `${sites.length} site${sites.length === 1 ? "" : "s"}`;
  if (sites.length === 0) {
    showState("No sites yet", "Ask your agent to create a site for this workspace.");
    return;
  }
  stateOutput.hidden = true;
  listOutput.hidden = false;
  listOutput.replaceChildren(...sites.map(renderSite));
}

async function load() {
  const token = ++loadToken;
  refreshButton.disabled = true;
  try {
    const entries = await request("files.list", { path: ".", recursive: true });
    if (token !== loadToken) return;

    // Only these files change what a path means, so only these are read.
    const sources = await Promise.all(
      entries.map(async (entry) => {
        const name = entry.path.split("/").at(-1) ?? entry.path;
        if (!SITE_SIGNAL_FILES.includes(name)) return entry.path;
        try {
          const read = await request("files.read", { path: entry.path });
          return { path: entry.path, body: read.text };
        } catch {
          return { path: entry.path };
        }
      }),
    );
    if (token !== loadToken) return;

    clearError();
    renderSites(discoverSites(sources));
  } catch (error) {
    if (token !== loadToken) return;
    countOutput.textContent = "";
    showState(
      "Could not list this workspace",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (token === loadToken) refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", () => void load());

// dohc serves a panel a workspace at a time and starts it again when the user
// comes back to the view, so this list is read fresh every time it is shown.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void load();
});

void applyTheme().catch((error) => {
  showError(error instanceof Error ? error.message : String(error));
});
void subscribe("files.watch", { path: "." }, () => {
  if (refreshTimeout !== null) window.clearTimeout(refreshTimeout);
  refreshTimeout = window.setTimeout(() => {
    refreshTimeout = null;
    void load();
  }, 300);
}).catch((error) => {
  showError(error instanceof Error ? error.message : String(error));
});
void load();
