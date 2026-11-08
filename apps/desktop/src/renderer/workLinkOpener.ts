import { parseWorkLinkUrl } from "@dohc/workspace-contracts/work-links";

// Opens a work link's message in dohc. True when dohc opened it; false sends
// the link to the browser, as for any other link.
type OpenWorkLink = (url: string) => Promise<boolean>;

// One opener for the whole renderer, installed by the workspace shell, as
// ExternalLinkConfirm installs its gate. With no shell there is no workspace
// to open a message in.
let opener: OpenWorkLink | null = null;

export function installWorkLinkOpener(next: OpenWorkLink): () => void {
  opener = next;
  return () => {
    if (opener === next) opener = null;
  };
}

/** True when the URL is a work link and dohc opened its message. */
export async function openWorkLinkInDohc(url: string): Promise<boolean> {
  const open = opener;
  if (open === null || parseWorkLinkUrl(url) === null) return false;
  return await open(url).catch(() => false);
}
