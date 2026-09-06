// The wire types ts-rs emits from crates/dohc-engine-protocol. Regenerate with
// `TS_RS_EXPORT_DIR=generated/ts cargo test --features bindings export_bindings`
// in that crate. Type-only, so no bundle resolves the crate path.
import type { Envelope as WireEnvelope } from "../../../crates/dohc-engine-protocol/generated/ts/Envelope";
import type { Event as WireEvent } from "../../../crates/dohc-engine-protocol/generated/ts/Event";
import type { Request as WireRequest } from "../../../crates/dohc-engine-protocol/generated/ts/Request";
import type { Response as WireResponse } from "../../../crates/dohc-engine-protocol/generated/ts/Response";

export type { BlobStart } from "../../../crates/dohc-engine-protocol/generated/ts/BlobStart";
export type { ErrorCode } from "../../../crates/dohc-engine-protocol/generated/ts/ErrorCode";
export type { Retryability } from "../../../crates/dohc-engine-protocol/generated/ts/Retryability";
export type { WireError } from "../../../crates/dohc-engine-protocol/generated/ts/WireError";
export type { WorkspaceHandle } from "../../../crates/dohc-engine-protocol/generated/ts/WorkspaceHandle";

// ts-rs emits `{ [key in string]: JsonValue }` for `serde_json::Value`, which
// rejects any object type with an optional field. Every params and result
// type in this package has one, so the object arm accepts `undefined` values
// and the four wire types that carry a JsonValue are re-derived on top of it.
// `protocol.test-d.ts` proves the crate's shapes still fit these.
export type JsonValue =
  | number
  | string
  | boolean
  | Array<JsonValue>
  | { [key in string]?: JsonValue }
  | null;

export type Request = Omit<WireRequest, "params"> & { params: JsonValue };
export type Response = Omit<WireResponse, "result"> & { result: JsonValue };
export type Event = Omit<WireEvent, "payload"> & { payload: JsonValue };
export type Envelope =
  | Exclude<WireEnvelope, { type: "request" | "response" | "event" | "batch" }>
  | ({ type: "request" } & Request)
  | ({ type: "response" } & Response)
  | ({ type: "event" } & Event)
  | { type: "batch"; envelopes: Envelope[] };
