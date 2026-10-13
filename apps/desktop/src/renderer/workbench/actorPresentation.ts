import type { ActorPresentation } from "../../ipc/bridgeContract";
import { ACTOR_HUES } from "@dohc/workspace-contracts/actor-presentation";
import { palette, identityHues, type IdentityHue } from "../tokens";
import { chosenHue, subscribeChosenColors } from "./chosenColors";

export const neutralPresentation: ActorPresentation = { group: "", hue: null, self: false };
export const ownPresentation: ActorPresentation = { group: "own", hue: null, self: true };
export function relayPresentation(slot: number, self = false): ActorPresentation {
  return { group: "", hue: ACTOR_HUES[slot] ?? null, self };
}
const HUE_CLASSES: Record<IdentityHue, string> = {
  rust: "bg-hue-rust/15 text-hue-rust", amber: "bg-hue-amber/15 text-hue-amber",
  teal: "bg-hue-teal/15 text-hue-teal", blue: "bg-hue-blue/15 text-hue-blue",
  indigo: "bg-hue-indigo/15 text-hue-indigo", plum: "bg-hue-plum/15 text-hue-plum",
  rose: "bg-hue-rose/15 text-hue-rose", olive: "bg-hue-olive/15 text-hue-olive",
};
const AGENT_CLASSES: Record<IdentityHue, string> = {
  rust: "border-hue-rust/50 bg-bg text-hue-rust", amber: "border-hue-amber/50 bg-bg text-hue-amber",
  teal: "border-hue-teal/50 bg-bg text-hue-teal", blue: "border-hue-blue/50 bg-bg text-hue-blue",
  indigo: "border-hue-indigo/50 bg-bg text-hue-indigo", plum: "border-hue-plum/50 bg-bg text-hue-plum",
  rose: "border-hue-rose/50 bg-bg text-hue-rose", olive: "border-hue-olive/50 bg-bg text-hue-olive",
};
function hueFor(token: ActorPresentation, kind: "human" | "agent"): IdentityHue | null {
  return (token.self ? chosenHue(kind) : null) ?? token.hue;
}
export function presentationClasses(token: ActorPresentation, kind: "human" | "agent" = "human"): string {
  const hue = hueFor(token, kind);
  return kind === "agent" ? hue ? AGENT_CLASSES[hue] : "border-agent/50 bg-bg text-agent"
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
export function subscribePresentationColors(listener: () => void): () => void {
  const unsubscribe = subscribeChosenColors(listener);
  const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(listener);
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => { observer?.disconnect(); unsubscribe(); };
}
