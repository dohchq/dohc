import type { DatasetPlace } from "@dohc/cli/dataset";

export type CollectionServer = NonNullable<Extract<DatasetPlace, { kind: "here" }>["server"]>;

/** What moving to `server` does to a Collection's automations, or null when they keep running. */
function automationsMove(server: CollectionServer): string | null {
  if (!server.automations) return null;
  if (server.runs === "off") return `Its automations stop, because ${server.host} doesn't run automations.`;
  if (server.runs === null) return `Its automations run only if ${server.host} runs automations.`;
  if (server.runs === "no-schedules" && server.scheduledAutomations) return `Its schedules and Group messages stop until you choose ${server.host} under Schedules run on in Settings.`;
  return null;
}

/**
 * Said before the action that moves a Collection on this computer to the
 * workspace's server: saving a person's access, or publishing an app on a link.
 */
export function CollectionMoveNote({ action, server }: { action: "Saving" | "Publishing"; server: CollectionServer }) {
  const automations = automationsMove(server);
  return <p data-testid="collection-move-note" className="m-0 text-[12px] text-muted">
    {action} moves this Collection to {server.host}. Even on this computer, it then works only while {server.host} is reachable. dohc can't move it back.
    {automations ? ` ${automations}` : null}
  </p>;
}
