import { phoneWrites } from "../server/phoneWrites";

// Whether this build may run an app. An app can write its Collection through the server, so running one waits for
// phone writes, as Approve does.
export const canOpenApps = phoneWrites;
