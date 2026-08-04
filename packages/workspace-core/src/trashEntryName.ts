// One rule for naming an entry in <workspace>/.dohc/trash, because two
// surfaces move files there and both must produce a name the filesystem can
// hold.
//
// The MCP server did not. It joined a ~51-byte timestamp+uuid prefix onto an
// untruncated basename, so a legal 230-character name -- fine on NTFS, ext4
// and APFS -- produced a rename target past the per-component limit. The
// calling agent received "ENOENT: no such file or directory, rename ..." about
// a file that was right there, and would reasonably read that as a delete that
// never happened (#613). The desktop had the fix and kept it to itself.
//
// The entropy stays with the caller: this module takes the prefix already
// built, so it needs no crypto import and stays usable from any environment.

// The per-component limit on ext4, APFS and NTFS. BYTES, not characters:
// a 255-character name of 2-byte characters does not fit.
export const NAME_MAX_BYTES = 255;

// TextEncoder/TextDecoder rather than Buffer, so this module carries no Node
// dependency. The decoder replaces a split multibyte sequence with U+FFFD,
// exactly as Buffer#toString does.
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

// Truncates a (decorative) name so that `${prefix}${result}` fits NAME_MAX.
// Byte-accurate: a multibyte sequence split at the cut decodes to U+FFFD,
// which is trimmed so the entry never carries a dangling replacement
// character. An oversized prefix leaves no budget and answers "".
export function fitWithinNameMax(name: string, prefix: string): string {
  const budget = NAME_MAX_BYTES - utf8Encoder.encode(prefix).length;
  if (budget <= 0) return "";
  const bytes = utf8Encoder.encode(name);
  if (bytes.length <= budget) return name;
  return utf8Decoder.decode(bytes.subarray(0, budget)).replace(/�+$/, "");
}

// The whole name: a caller-built unique prefix, then as much of the original
// basename as fits. The basename is decorative -- recovery is opening
// <workspace>/.dohc/trash and moving the entry back -- so truncating it is
// always better than failing the delete.
export function trashEntryName(name: string, prefix: string): string {
  return `${prefix}${fitWithinNameMax(name, prefix)}`;
}
