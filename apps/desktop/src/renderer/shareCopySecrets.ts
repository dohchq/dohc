import type { CopySecret } from "./ui/CopyButton";

// A share's code and browser invitation, as a copy that failed names them,
// and where a person copies them again once Try again cannot.
export const SHARE_CODE_SECRET: CopySecret = {
  what: "the share code",
  again: "Copy it again from Shared by me while the share is active.",
};
export const BROWSER_INVITATION_SECRET: CopySecret = {
  what: "the browser invitation",
  again: "Copy it again from Shared by me while the share is active.",
};
