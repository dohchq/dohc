import * as Schema from "effect/Schema";
import { WorkspaceDaemonRequester, type DaemonRequesterClient } from "../live/daemonLiveAdapter";
import type { WorkspaceHandle } from "../protocol";

const FILES_CHANGED_EVENT = "workspace.filesChanged";
const Revision = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Cursor = Schema.Struct({ generation: Schema.String.check(Schema.isNonEmpty()), revision: Revision });
const Fact = Schema.Struct({ path: Schema.String.check(Schema.isNonEmpty()), kind: Schema.Literals(["appeared", "disappeared", "changed"]) });
const Changes = Schema.Struct({ cursor: Cursor, ready: Schema.Boolean, resync: Schema.Boolean, facts: Schema.Array(Fact) });
const Wake = Schema.Struct({ workspaceId: Schema.String, cursor: Cursor });

export type FileObservationCursor = typeof Cursor.Type;
export type FileObservationFact = typeof Fact.Type;
export type FileObservationChanges = typeof Changes.Type;
export const decodeFileObservationChanges = Schema.decodeUnknownSync(Changes);
export const decodeFileObservationWake = Schema.decodeUnknownSync(Wake);

/** Cursor reads recover a missed wake. A resync requires a full consumer refresh. */
export class EngineFileObservation {
  private readonly requester: WorkspaceDaemonRequester;

  constructor(client: DaemonRequesterClient, private readonly workspace: WorkspaceHandle) {
    this.requester = new WorkspaceDaemonRequester(client);
  }

  async changesSince(cursor?: FileObservationCursor): Promise<FileObservationChanges> {
    return decodeFileObservationChanges(await this.requester.request("files.changesSince", { cursor: cursor ?? null }, { workspace: this.workspace }));
  }

  /** Forces a metadata scan before answering, including writes preceding this request. */
  async drain(cursor?: FileObservationCursor): Promise<FileObservationChanges> {
    return decodeFileObservationChanges(await this.requester.request("files.drain", { cursor: cursor ?? null }, { workspace: this.workspace }));
  }
}
