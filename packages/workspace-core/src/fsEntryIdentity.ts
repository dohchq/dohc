// Is the entry at this path still the one we started on?
//
// Two surfaces move files into <workspace>/.dohc/trash, and both do it as a
// LADDER of renames: the real name first, then shorter ones, each attempted
// only because the platform refused the last. Nothing serializes those
// attempts, so a failed rung leaves a window in which another process can
// replace the source -- and the next rung would move the replacement into the
// trash and report the delete done, for a file nobody named.
//
// Both surfaces therefore ask this question before every attempt after the
// first, against an identity captured ONCE before the first one. It lives here
// so there is one answer rather than two that can drift.

/** The parts of a stat that identify one filesystem entry. */
export interface FsEntryIdentity {
  ino: number;
  dev: number;
}

/**
 * `ino` + `dev` identify an entry on every filesystem dohc ships to: NTFS
 * supplies the file index and the volume serial number, ext4 and APFS the
 * inode and device.
 *
 * An inode of `0` is a filesystem saying it has none to give, so it proves
 * neither sameness nor difference. That is "unknown", never "same" -- a caller
 * about to act destructively must not read absent evidence as permission. The
 * costs are not symmetric: a wrong refusal costs a retry, a wrong success
 * moves the wrong file and reports it done.
 */
export function sameFsEntry(
  before: FsEntryIdentity,
  after: FsEntryIdentity,
): "same" | "replaced" | "unknown" {
  if (before.ino === 0 || after.ino === 0) return "unknown";
  return before.ino === after.ino && before.dev === after.dev ? "same" : "replaced";
}
