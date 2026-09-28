// Kept apart from automationButtons, whose imports reach Node-only code, so the renderer can import it.
/** Why a pressed button's run waits, in the words a person and an agent read. Keys are the executor's wait reasons. */
export const PRESS_WAITING = {
  roster: "Waiting to check who can edit this Collection.",
  held: "Waiting for someone who can edit this Collection to allow a step.",
  busy: "Waiting for other automations to finish.",
  session: "Sign in to send this automation's chat messages.",
} as const;

