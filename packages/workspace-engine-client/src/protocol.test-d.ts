// Compile-only contract, enforced by `pnpm typecheck`: every wire value the
// crate's generated types describe is assignable to the widened types in
// protocol.ts, so a field the crate adds or renames fails here first.
import type { Envelope as WireEnvelope } from "../../../crates/dohc-engine-protocol/generated/ts/Envelope";
import type { Event as WireEvent } from "../../../crates/dohc-engine-protocol/generated/ts/Event";
import type { Request as WireRequest } from "../../../crates/dohc-engine-protocol/generated/ts/Request";
import type { Response as WireResponse } from "../../../crates/dohc-engine-protocol/generated/ts/Response";
import type { JsonValue as WireJsonValue } from "../../../crates/dohc-engine-protocol/generated/ts/serde_json/JsonValue";
import type { Envelope, Event, JsonValue, Request, Response } from "./protocol";

declare const wire: {
  json: WireJsonValue;
  request: WireRequest;
  response: WireResponse;
  event: WireEvent;
  envelope: WireEnvelope;
};
const widened: {
  json: JsonValue;
  request: Request;
  response: Response;
  event: Event;
  envelope: Envelope;
} = wire;
void widened;
