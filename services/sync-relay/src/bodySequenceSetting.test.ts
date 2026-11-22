import { afterEach, expect, it } from "vitest";
import {
  changeMadeBy,
  seededNote,
} from "../../../packages/ydoc-projection/src/bodySequenceChecksTestSupport.js";
import { BODY_SEQUENCE_SETTING, bodySequenceNotesAdmitted } from "./bodySequenceSetting.js";
import { createLiveValidationExecutor } from "./liveValidation.js";

const policy = {
  maxStructVisits: 1_000_000,
  maxValueNodeVisits: 5_000_000,
  maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000,
  maxDeleteClientGroupVisits: 1_000_000,
  maxDeleteIntervalVisits: 1_000_000,
  maxIndexOperations: 10_000_000,
};
const pools: ReturnType<typeof createLiveValidationExecutor>[] = [];
const before = process.env[BODY_SEQUENCE_SETTING];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  if (before === undefined) delete process.env[BODY_SEQUENCE_SETTING];
  else process.env[BODY_SEQUENCE_SETTING] = before;
});

it("is off unless it is 1, and refuses any other value", () => {
  expect(bodySequenceNotesAdmitted({})).toBe(false);
  expect(bodySequenceNotesAdmitted({ [BODY_SEQUENCE_SETTING]: "0" })).toBe(false);
  expect(bodySequenceNotesAdmitted({ [BODY_SEQUENCE_SETTING]: "1" })).toBe(true);
  for (const value of ["", "true", "2", " 1"])
    expect(() => bodySequenceNotesAdmitted({ [BODY_SEQUENCE_SETTING]: value })).toThrow(
      `${BODY_SEQUENCE_SETTING} must be 0 or 1.`,
    );
});

it.each([
  [undefined, "refused", "refused"],
  ["0", "refused", "refused"],
  ["1", "accepted", "accepted"],
] as const)(
  "set to %s, a validation worker answers %s for a format-2 note and %s for an edit to it",
  async (value, registration, edit) => {
    if (value === undefined) delete process.env[BODY_SEQUENCE_SETTING];
    else process.env[BODY_SEQUENCE_SETTING] = value;
    const pool = createLiveValidationExecutor();
    pools.push(pool);
    const note = seededNote();
    const document = {
      workspaceId: "workspace",
      mainVersionId: "main",
      objectId: "object",
      lineageClaimId: "lineage",
    };
    const settled = await pool.normalizeSettlement({
      document,
      currentPath: "note.md",
      checkpoint: note,
    });
    expect(settled.kind).toBe(registration);
    const typed = changeMadeBy(note, 77, ({ sequence }) => sequence.insert(2, "x"))!;
    const admitted = await pool.validator(policy)({
      document,
      currentPath: "note.md",
      checkpoint: note,
      suffix: [],
      candidate: typed,
    });
    expect(admitted.kind).toBe(edit);
  },
);
