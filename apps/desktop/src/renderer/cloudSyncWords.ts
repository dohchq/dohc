// A synced workspace whose remote does not match main's current session.
// The renderer cannot tell the two causes apart: another account owns the
// remote, or main has not read this account's saved session again since a
// Disconnect that did not finish. Nothing reads it again until Try again or
// a restart, so the words state what failed and promise nothing. Settings,
// About and the Notices row all say this.
export const SYNC_UNCONFIRMED_ACCOUNT = "dohc couldn't confirm this workspace's account, so it isn't syncing.";

// A synced workspace while nobody is connected to a server. Disconnecting is
// a choice, not a fault, so the words name the way back and blame nothing.
export const SYNC_NOT_CONNECTED = "This workspace isn't syncing until you connect your server.";
