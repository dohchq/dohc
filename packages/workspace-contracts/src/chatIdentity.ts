import * as Schema from "effect/Schema";
import {
  MAX_PREFERRED_NAME_LENGTH,
  hasPreferredNameControlCharacters,
} from "./chatIdentityValues";

export {
  MAX_PREFERRED_NAME_LENGTH,
  agentDisplayLabel,
  preferredNameFromInput,
} from "./chatIdentityValues";

/**
 * The human-readable owner name used by chat authorship surfaces. This value is
 * display-only: authorization continues to use opaque, verified user ids.
 */
export const PreferredName = Schema.Trim.check(
  Schema.isNonEmpty({ message: "Enter the name your agent should use." }),
  Schema.isMaxLength(MAX_PREFERRED_NAME_LENGTH, {
    message: `Names must contain ${MAX_PREFERRED_NAME_LENGTH} characters or fewer.`,
  }),
  Schema.makeFilter((value) => !hasPreferredNameControlCharacters(value), {
    message: "Names cannot contain control characters.",
  }),
);

export type PreferredName = typeof PreferredName.Type;
