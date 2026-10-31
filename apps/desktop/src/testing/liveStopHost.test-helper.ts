export const HOST_STOP_CASES = [
  [
    "host-paused",
    "running without this document (paused)",
    "Live editing didn't stop. Recent edits haven't reached the server yet. Resume live editing to send them, then stop it.",
    "resume"
  ],
  [
    "host-diverged",
    "running without this document (server copy diverged)",
    "Live editing didn't stop. The server's copy of this workspace no longer matches the synced one. Contact the server's operator.",
    "none"
  ],
  [
    "host-no-edit-grant",
    "running without this document (no Edit grant)",
    "Live editing didn't stop. The server may hold recent edits, but it only loads documents shared with Edit access. Share this one with Edit access again, then try again.",
    "retry"
  ],
  [
    "host-moved",
    "running without this document (moved from old/plan.md)",
    "Live editing didn't stop. The server may hold recent edits, but it only loads this document from old/plan.md. Put it back there, then try again.",
    "retry"
  ],
  [
    "host-start-failed",
    "couldn't start",
    "Live editing didn't stop. The server couldn't load this document and may hold recent edits. Contact the server's operator, then try again.",
    "retry"
  ],
  [
    "host-not-loaded",
    "starting",
    "Live editing didn't stop. The server hasn't loaded this document yet and may hold recent edits to it. Try again in a moment.",
    "retry"
  ],
  [
    "host-not-loaded",
    "restarting",
    "Live editing didn't stop. The server hasn't loaded this document yet and may hold recent edits to it. Try again in a moment.",
    "retry"
  ],
  [
    "host-not-loaded",
    "running, document not loaded yet",
    "Live editing didn't stop. The server hasn't loaded this document yet and may hold recent edits to it. Try again in a moment.",
    "retry"
  ]
] as const;

// Match Electron's rejected-handler string; code and metadata survive in the name.
export function hostStopWireError(code: string, sessionHost: string, words: string): Error {
  const detail = {code, sessionHost, ...(code === "host-moved" ? {path: "old/plan.md"} : {})};
  return new Error(`Error invoking remote method: LiveStopRefusal [${encodeURIComponent(JSON.stringify(detail))}]: ${words}\nServer: ${sessionHost}`);
}
