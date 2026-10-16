import type { ApprovalAgent } from "@dohc/security-contract/approval-provenance";
import type { LocalAppLaunchBackend } from "./localAppLaunch";
import type { LocalAppPrepared, LocalAppStore } from "./localAppStore";
import type { createLocalDatasetApps } from "./localDatasetApps";

/** The only local publication API exposed to owner handlers and browser launch. */
export function createLocalApps(store: LocalAppStore, dataset: ReturnType<typeof createLocalDatasetApps>) {
  const backend: LocalAppLaunchBackend = {
    browserPublication(publicationId) {
      dataset.current(publicationId);
      return store.browserPublication(publicationId);
    },
    assertBrowserPublication(publicationId, authorityRevision) {
      dataset.current(publicationId, authorityRevision);
    },
    request: (publicationId, action, input, signal) => dataset.request(publicationId, action, input, signal),
    readBrowserFile: (publicationId, input, signal) => dataset.readBrowserFile(publicationId, input, signal),
  };
  return {
    ...backend,
    activate: (prepared: LocalAppPrepared, signal: AbortSignal, agent?: ApprovalAgent | null) => dataset.activate(prepared, signal, agent),
    has: (publicationId: string) => store.has(publicationId),
    list: (appRoot: string) => store.list(appRoot).map(value => dataset.describe(value)),
    withdraw: (publicationId: string, expected: number) => store.withdraw(publicationId, expected, (value, commit) => dataset.withdrawBinding(value, commit)),
  };
}
