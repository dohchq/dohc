// What a notice owner files: a failure from a closed list, with the facts
// its words need. The words for each code live in `FAILURE_WORDS`
// (ipc/errorWords.ts), so a code without words does not compile.

export type VersionsRead = "last-changes" | "counts" | "conflicts";

export interface FailureFacts {
  // The Versions page could not finish a read, or more than one.
  "versions-reads": { read: VersionsRead | "several" };
}
export type FailureCode = keyof FailureFacts;
