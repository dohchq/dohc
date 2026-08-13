import * as Schema from "effect/Schema";

export const NonEmptyString = Schema.NonEmptyString.annotate({
  message: "String must contain at least 1 character.",
});
