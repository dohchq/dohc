// What a notice owner files: a failure from a closed list, with the facts
// its words need, and what the person can do about it. The words for each
// code live in `FAILURE_WORDS` (ipc/errorWords.ts), so a code without words
// does not compile.

export type VersionsRead = "last-changes" | "counts" | "conflicts";

// Each failure code and the facts its words take.
export interface FailureFacts {
  // The Versions page could not finish a read, or more than one.
  "versions-reads": { read: VersionsRead | "several" };
}
export type FailureCode = keyof FailureFacts;

// `cause` is the error as it arrived. It goes to Copy details and adds its
// own words after the failure's, never in their place.
export type Failure = {
  [Code in FailureCode]: { code: Code; facts: FailureFacts[Code]; cause: unknown };
}[FailureCode];

// Each operation a notice's Try again can run, and the input it takes. A
// notice keeps only this reference. The view that can run the operation
// registers it with the owner while it is mounted.
interface RetryInputs {
  // Reads again every read the page has failed when Try again is pressed.
  "read-versions-again": { page: string };
}
type RetryOperation = keyof RetryInputs;

export type Recovery = {
  [Operation in RetryOperation]: { retry: Operation; input: RetryInputs[Operation] };
}[RetryOperation];
