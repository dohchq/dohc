// Retirement Phase C (WS-H1): batchedSync (batchToChangeSet) is retired with
// the desktop's legacy history recorder. What remains here is the legacy
// CLOUD sync path (mergeSync + collaboration policy), which retires with the
// old cloud stack in audit Phase D when Arc 0P replaces it.
export * from "./cloudSync";
export * from "./collaborationPolicy";
