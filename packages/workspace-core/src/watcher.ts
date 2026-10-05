/** Settled file presence facts used by desktop bookkeeping and automations. */
export interface WatcherEvent {
  path: string;
  operation: "update" | "delete";
}
