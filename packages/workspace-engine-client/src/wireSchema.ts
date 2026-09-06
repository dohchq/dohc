import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

export class ProtocolShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolShapeError";
  }
}

export function mutableStruct<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
) {
  return Schema.Struct(fields).mapFields(Struct.map(Schema.mutableKey));
}
