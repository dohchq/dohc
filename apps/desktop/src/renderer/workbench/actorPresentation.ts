import type { ActorPresentation, DohcDesktopBridge } from "../../ipc/bridgeContract";
import { ACTOR_HUES } from "@dohc/workspace-contracts/actor-presentation";
import { palette, identityHues, type IdentityHue } from "../tokens";
import { chosenHue, subscribeChosenColors } from "./chosenColors";

export const neutralPresentation: ActorPresentation = { group: "", hue: null, self: false };
export const ownPresentation: ActorPresentation = { group: "own", hue: null, self: true };
export const ownAgentPresentation: ActorPresentation = { group: "own-agent", hue: null, self: true };
// An agent no longer in Settings: no hue at all, so it can't pass for one left at the default olive.
export const goneAgentPresentation: ActorPresentation = { group: "gone-agent", hue: null, self: false };
const listeners = new Set<() => void>();
const agentOverrides = new Map<string, { workspaceId: string; hue: IdentityHue | null }>();
export function clearAgentColorOverrides(workspaceId?: string): void {
  let changed = false;
  for (const [group, override] of agentOverrides) {
    if (workspaceId === undefined || override.workspaceId === workspaceId) { agentOverrides.delete(group); changed = true; }
  }
  if (!changed) return;
  for (const listener of listeners) listener();
}
export function bindAgentColorUpdates(
  api: Pick<DohcDesktopBridge, "onAgentColorChanged">,
  workspaceId: () => string | undefined,
): () => void {
  const stop = api.onAgentColorChanged(event => {
    if (event.workspaceId !== workspaceId()) return;
    agentOverrides.set(event.group, { workspaceId: event.workspaceId, hue: event.hue });
    for (const listener of listeners) listener();
  });
  return () => { stop(); clearAgentColorOverrides(); };
}
export function setOwnPresentation(token: ActorPresentation | undefined): void {
  const hue = token?.hue ?? null;
  if (ownPresentation.hue === hue) return;
  ownPresentation.hue = hue;
  for (const listener of listeners) listener();
}
export function subscribePresentation(listener: () => void): () => void {
  listeners.add(listener);
  const unsubscribe = subscribeChosenColors(listener);
  return () => { listeners.delete(listener); unsubscribe(); };
}
export function relayPresentation(slot: number, self = false): ActorPresentation {
  return { group: "", hue: ACTOR_HUES[slot] ?? null, self };
}
const HUE_CLASSES: Record<IdentityHue, string> = {
  rust: "bg-hue-rust/15 text-hue-rust", amber: "bg-hue-amber/15 text-hue-amber",
  teal: "bg-hue-teal/15 text-hue-teal", blue: "bg-hue-blue/15 text-hue-blue",
  indigo: "bg-hue-indigo/15 text-hue-indigo", plum: "bg-hue-plum/15 text-hue-plum",
  rose: "bg-hue-rose/15 text-hue-rose",
};
const AGENT_CLASSES: Record<IdentityHue, string> = {
  rust: "border-hue-rust bg-bg text-hue-rust", amber: "border-hue-amber bg-bg text-hue-amber",
  teal: "border-hue-teal bg-bg text-hue-teal", blue: "border-hue-blue bg-bg text-hue-blue",
  indigo: "border-hue-indigo bg-bg text-hue-indigo", plum: "border-hue-plum bg-bg text-hue-plum",
  rose: "border-hue-rose bg-bg text-hue-rose",
};
/** The color chosen for this agent itself; null is the default. */
export function agentChoice(token: ActorPresentation): IdentityHue | null {
  return agentOverrides.has(token.group) ? agentOverrides.get(token.group)?.hue ?? null : token.hue;
}
// The renderer's own tokens and an unknown author's group name no agent main can color.
const UNCHOOSABLE_GROUPS = new Set([neutralPresentation.group, ownPresentation.group, ownAgentPresentation.group, goneAgentPresentation.group]);
/** Whether main issued this agent's group, so a color can be chosen for it. */
export function canChooseAgentColor(token: ActorPresentation): boolean {
  return !UNCHOOSABLE_GROUPS.has(token.group) && !token.group.startsWith("unknown:");
}
function hueFor(token: ActorPresentation, kind: "human" | "agent"): IdentityHue | null {
  if (kind === "agent") return agentChoice(token) ?? (token.self ? chosenHue("agent") : null);
  return (token.self ? chosenHue("human") : null) ?? token.hue;
}
const AGENT_TEXT: Record<IdentityHue, string> = {
  rust: "text-hue-rust", amber: "text-hue-amber", teal: "text-hue-teal", blue: "text-hue-blue",
  indigo: "text-hue-indigo", plum: "text-hue-plum", rose: "text-hue-rose",
};
/** An agent's name and mark in its avatar's hue, olive by default. */
export function agentTextClass(token: ActorPresentation): string {
  if (token.group === goneAgentPresentation.group) return "text-subtle";
  const hue = hueFor(token, "agent");
  return hue ? AGENT_TEXT[hue] : "text-agent";
}
export function presentationClasses(token: ActorPresentation, kind: "human" | "agent" = "human"): string {
  if (kind === "agent" && token.group === goneAgentPresentation.group) return "border-subtle bg-panel text-subtle";
  const hue = hueFor(token, kind);
  return kind === "agent" ? hue ? AGENT_CLASSES[hue] : "border-agent bg-bg text-agent"
    : hue ? HUE_CLASSES[hue] : "bg-panel-2 text-muted";
}
export function presentationTheme(): "light" | "dark" {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
export function presentationColor(token: ActorPresentation, kind: "human" | "agent" = "human", theme = presentationTheme()) {
  const hue = hueFor(token, kind);
  const stroke = hue ? identityHues[theme][hue] : palette[theme][kind === "agent" ? "agent" : "muted"];
  const rgb = [1, 3, 5].map(offset => parseInt(stroke.slice(offset, offset + 2), 16));
  return { stroke, background: "rgba(" + rgb.join(", ") + ", 0.15)" };
}

// The account token applies before a workspace opens, including manager settings.
export function bindOwnPresentation(api: Pick<DohcDesktopBridge, "cloudStatus" | "onCloudSessionChanged">): () => void {
  let active = true;
  let revision = 0;
  const refresh = () => {
    const request = ++revision;
    void api.cloudStatus().then(status => {
      if (active && request === revision) setOwnPresentation(status.ownPresentation);
    }).catch(() => undefined);
  };
  const unsubscribe = api.onCloudSessionChanged(event => {
    revision += 1;
    setOwnPresentation(undefined);
    if (event.phase === "ready") refresh();
  });
  refresh();
  return () => { active = false; revision += 1; unsubscribe(); };
}
