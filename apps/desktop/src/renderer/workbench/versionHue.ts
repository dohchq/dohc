import { IDENTITY_HUES, type IdentityHue } from "@dohc/workspace-contracts/agent-hues";

// Spelled out so Tailwind sees every class.
const VERSION_DOTS: Record<IdentityHue, string> = {
  rust: "bg-hue-rust",
  amber: "bg-hue-amber",
  teal: "bg-hue-teal",
  blue: "bg-hue-blue",
  indigo: "bg-hue-indigo",
  plum: "bg-hue-plum",
  rose: "bg-hue-rose",
};

// A version's dot color comes from its id, so the menu chip and the Versions page agree
// and the color stays when the version is renamed. Main has no dot.
export function versionDotClass(versionId: string): string {
  let hash = 0;
  for (let index = 0; index < versionId.length; index += 1) {
    hash = (Math.imul(hash, 31) + versionId.charCodeAt(index)) >>> 0;
  }
  return VERSION_DOTS[IDENTITY_HUES[hash % IDENTITY_HUES.length] ?? "rust"];
}
