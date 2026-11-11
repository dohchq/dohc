// The shape of an eval case and of what a run records. README.md says how to add a case.

/**
 * A JSON value the dohc app answers with, or a function of the request's arguments and the
 * workspace folder. A function that throws stands for a request whose answer never arrived.
 */
export type DesktopAnswer = unknown | ((args: Record<string, unknown>, root: string) => unknown);

export interface EvalCase {
  id: string;
  /** `bad` reproduces a mistake, `guard` protects correct behavior, `control` is ordinary work. */
  kind: "bad" | "guard" | "control";
  /** The real experience, in a sentence. */
  experience: string;
  /** Where it happened: a pull request, an issue, or a commit. */
  source: string;
  /** The workspace's files, by path. */
  files?: Record<string, string>;
  /** What the dohc app answers, by request verb. An unlisted verb ends the sample as an error. */
  desktop?: Record<string, DesktopAnswer>;
  /** What the person asks the agent. */
  prompt: string;
  expect: Expectation;
  /**
   * Calls that meet `expect`, and the answer that goes with them. cases.test.ts replays them
   * against the real server with no model, so a case that cannot pass fails in CI.
   */
  solution: { calls: { tool: string; args: Record<string, unknown> }[]; text?: string };
}

/** One tool call to look for. `args` match partially; see `matchesArgs` in grade.ts. */
export interface CallMatch {
  /**
   * A dohc tool without its server prefix, such as `dohc_edit_document`, or a built-in such as
   * `Edit`. A name that ends in `*` matches every tool that starts with the rest.
   */
  tool: string;
  args?: Record<string, unknown>;
  /** Match only calls that succeeded (`true`) or only calls the tool refused (`false`). */
  ok?: boolean;
}

export interface Expectation {
  /** Each of these matches at least one call. */
  calls?: CallMatch[];
  /** None of these matches any call. A string names a tool. */
  notCalls?: (string | CallMatch)[];
  /** These tools are called in this order; other calls may come between. */
  order?: string[];
  /** The most calls a tool may get. */
  maxCalls?: Record<string, number>;
  /** Regular expressions the final answer matches. */
  text?: string[];
  /** Regular expressions the final answer does not match. */
  notText?: string[];
  /** The workspace's files after the run. */
  files?: Record<string, { contains?: string[]; lacks?: string[]; times?: Record<string, number>; absent?: true }>;
}

export interface RecordedCall {
  tool: string;
  args: Record<string, unknown>;
  /** False when the tool result was an error. */
  ok: boolean;
}

export interface RunRecord {
  calls: RecordedCall[];
  /** The agent's last text. */
  text: string;
  /** The workspace's files after the run, by path. */
  files: Record<string, string>;
}

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}
