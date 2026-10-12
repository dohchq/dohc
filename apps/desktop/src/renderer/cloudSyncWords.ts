// A synced workspace whose remote does not match main's current session.
// The renderer cannot tell the two causes apart: another account owns the
// remote, or main has not read this account's saved session again since a
// Disconnect that did not finish. Settings and About both say this.
export const SYNC_PAUSED_FOR_ACCOUNT = "Sync is paused until dohc confirms this workspace's account.";
