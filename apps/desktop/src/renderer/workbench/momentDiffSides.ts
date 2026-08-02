import type { EngineMomentDetailRecord } from "../../ipc/bridgeContract";

/// What the diff page can show for one moment, decided PER SIDE.
///
/// A moment can change a file's kind, and then its two sides disagree. Keying
/// the page on one record-level kind throws the other side away: a text->binary
/// change would hide the text the file used to hold, which is the only readable
/// thing that moment has.
export interface MomentDiffSides {
  /// The before side's lines, or undefined when it holds bytes / is protected.
  before: string | undefined;
  /// The after side's lines, on the same terms.
  after: string | undefined;
  beforeIsBinary: boolean;
  afterIsBinary: boolean;
  /// Bytes replaced bytes: neither side has lines, so there is no diff to draw.
  bytesOnly: boolean;
  /// How many bytes to name when there is nothing readable to show. A DELETE
  /// carries its bytes on the before side, and the record-level count follows
  /// the after side, so reading that alone reports a removed file as 0 bytes.
  byteLength: number;
  /// This change created the file, so restoring it removes the file. A binary
  /// preimage means the file existed before — as bytes — and restore brings
  /// those bytes back instead.
  createdFile: boolean;
}

export function momentDiffSides(
  moment: Pick<
    EngineMomentDetailRecord,
    | "protected"
    | "beforeText"
    | "afterText"
    | "beforeBinary"
    | "afterBinary"
    | "byteLength"
  >,
): MomentDiffSides {
  const isProtected = moment.protected === true;
  const beforeIsBinary = moment.beforeBinary !== undefined;
  const afterIsBinary = moment.afterBinary !== undefined;
  const before = isProtected || beforeIsBinary ? undefined : (moment.beforeText ?? undefined);
  const after = isProtected || afterIsBinary ? undefined : (moment.afterText ?? undefined);
  return {
    before,
    after,
    beforeIsBinary,
    afterIsBinary,
    bytesOnly:
      !isProtected &&
      (beforeIsBinary || afterIsBinary) &&
      before === undefined &&
      after === undefined,
    byteLength:
      moment.afterBinary?.byteLength ??
      moment.beforeBinary?.byteLength ??
      moment.byteLength ??
      0,
    createdFile: !isProtected && moment.beforeText === null && !beforeIsBinary,
  };
}
