// One rule for what an instanced web app request may be, shared by the plugin
// host and main. Two shapes exist — a web app that opens one tab, and one that
// opens a tab per instance — and the manifest says which. A request that does
// not match its id's shape is refused here rather than served as the other
// one, because both wrong answers look like a working app until the user finds
// two tabs over the same origin.

/**
 * How many instances of one web app may run at once, per workspace.
 *
 * Every instance is a live WebContentsView with its own renderer process,
 * behind a server the plugin spawned for it. That is the real resource, and it
 * is much heavier than a tab: MAX_OPEN_TABS bounds tabs at 100, and 100 live
 * guest processes for one plugin would not survive the machine. Twenty leaves
 * a workspace room to keep every listed thing previewed at once and still
 * spends only a fifth of the tab budget on one plugin.
 */
export const MAX_PLUGIN_WEB_APP_INSTANCES = 20;

/** The bound on a web app tab's title, whether it comes from the manifest or
 * from a start that named its own instance. Both land in the same IPC field. */
export const MAX_PLUGIN_WEB_APP_TITLE_CHARS = 120;

/**
 * How long an instance key may be. The key names one runtime thing the plugin
 * serves — a site root is the case this was built for — so the bound is the
 * one a workspace-relative path needs, not a plugin id's. It rides in a tab
 * path, which restore rejects past 4096 characters; 512 leaves that room even
 * fully percent-encoded.
 */
export const MAX_PLUGIN_WEB_APP_INSTANCE_KEY_CHARS = 512;

/**
 * An instance key names a thing on screen and rides in a tab path, so it holds
 * no control characters — a NUL would split the key the view registry builds,
 * and the rest would break the label or the path it is written into. The rule
 * lives here, on the trusted side, because the SDK that also checks it is the
 * caller's own copy and a caller can skip it.
 */
export function hasControlCharacter(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}

export interface DeclaredWebApp {
  id: string;
  instanced: boolean;
}

/**
 * Finds the manifest entry a request names and checks the request's shape
 * against it. Returns the entry so the caller can use its title.
 */
export function requireDeclaredWebApp<T extends DeclaredWebApp>(
  pluginId: string,
  webApps: readonly T[] | undefined,
  webAppId: string,
  instanceKey: string | null,
): T {
  const declared = webApps?.find((candidate) => candidate.id === webAppId);
  if (!declared) {
    throw new Error(
      `Plugin "${pluginId}" does not declare web app "${webAppId}".`,
    );
  }
  if (declared.instanced && instanceKey === null) {
    throw new Error(
      `Plugin "${pluginId}" web app "${webAppId}" opens one tab per instance, so an open must name an instance. This one named none.`,
    );
  }
  if (!declared.instanced && instanceKey !== null) {
    throw new Error(
      `Plugin "${pluginId}" web app "${webAppId}" opens one tab for the whole plugin, so an open must not name an instance. This one named "${instanceKey}". Set "instanced": true in the manifest to open it per instance.`,
    );
  }
  return declared;
}

/**
 * Refuses an instance past the budget. The caller passes how many other
 * instances of this web app are already live, so restarting one that is
 * already open never counts against it.
 */
export function assertInstanceBudget(
  pluginId: string,
  webAppId: string,
  liveOtherInstances: number,
): void {
  if (liveOtherInstances < MAX_PLUGIN_WEB_APP_INSTANCES) return;
  throw new Error(
    `Plugin "${pluginId}" web app "${webAppId}" already runs ${liveOtherInstances} instances, the limit of ${MAX_PLUGIN_WEB_APP_INSTANCES} instances per web app. Close an instance tab and open this one again.`,
  );
}
