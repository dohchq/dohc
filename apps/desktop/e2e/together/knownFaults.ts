// The editing-together faults that are known and not yet fixed, by case.
//
// A case on this list must still fail the known way. The check fails when a case that is not here
// goes wrong, and also when a case that is here comes out right or goes wrong some other way.
// So the change that fixes a fault removes its line here, and a new fault never hides behind an old one.
import { test } from "@playwright/test";

export const KNOWN_FAULTS: Readonly<Record<string, number>> = {
  "same new empty line, the line's maker first": 4037,
  "same new empty line, the line's maker second": 4037,
  "both add a line after the same last line, one just after the other": 4037,
  "both join the same line": 4038,
  "joins of neighbouring lines": 4038,
  "a join and a split of one line": 4038,
  "a join and typing in the joined line": 4038,
  "typing in a paragraph someone deletes": 3983,
  "one presses Enter on a new empty line at the end of a to-do while its maker types in it": 3983,
  "the share page's server restarts under open pages": 3924,
};

/**
 * Ordinary edits the long run leaves out, by the known fault they would hit by chance. Whether two
 * people collide in a given run is luck, so that run cannot require a fault to show. Leaving the
 * edit out keeps the run strict: a stopped editor or a missing word fails it, with nothing excused.
 * The cases in same-moment.spec.ts make each of these collisions on purpose. The change that fixes
 * a fault removes its line here too, and the long run then makes those edits again.
 */
export const LEFT_OUT: Readonly<Record<string, number>> = {
  "joining and splitting lines": 4038,
  "typing on a line that is empty": 4037,
  "starting a new line where someone else starts one": 4037,
};

/**
 * What the long run still lets pass, by the fault that explains it. The run can tell this one
 * apart exactly: the word was typed into a line made to be deleted, and someone deleted that line.
 */
export const TOLERATED: Readonly<Record<string, number>> = {
  "a word goes with a line someone else deletes": 3983,
};

/**
 * Judges one case. `wanted` asserts the behavior a person should get. `symptom` asserts what the
 * case's known fault looks like on the page, and is unused for a case with no known fault.
 */
export function judge<Outcome>(
  name: string,
  outcome: Outcome,
  wanted: (outcome: Outcome) => void,
  symptom?: (outcome: Outcome) => void,
): void {
  const issue = KNOWN_FAULTS[name];
  test
    .info()
    .annotations.push({ type: "what the pages showed", description: JSON.stringify(outcome) });
  if (issue === undefined) {
    wanted(outcome);
    return;
  }
  test.info().annotations.push({ type: "known fault", description: `#${String(issue)}` });
  let wrong: unknown;
  try {
    wanted(outcome);
  } catch (error) {
    wrong = error;
  }
  if (wrong === undefined)
    throw new Error(
      `"${name}" came out right, so #${String(issue)} no longer happens here. Remove its line from knownFaults.ts in the change that fixed it.`,
    );
  if (!symptom) throw new Error(`"${name}" is a known fault with no symptom to check.`);
  try {
    symptom(outcome);
  } catch (other) {
    throw new AggregateError(
      [wrong, other],
      `"${name}" went wrong, but not the way #${String(issue)} does. What the pages showed: ${JSON.stringify(outcome)}`,
    );
  }
}
