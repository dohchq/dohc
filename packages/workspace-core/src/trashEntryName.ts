// One rule for naming an entry in <workspace>/.dohc/trash, because two
// surfaces move files there and both must produce a name the filesystem can
// hold.
//
// The MCP server did not. It joined a ~51-character timestamp+uuid prefix onto
// an untruncated basename, so a legal 230-character name -- fine on NTFS, ext4
// and APFS -- produced a rename target past the per-component limit. The
// calling agent received "ENOENT: no such file or directory, rename ..." about
// a file that was right there, and would reasonably read that as a delete that
// never happened (#613). The desktop had a fix and kept it to itself.
//
// Then this module predicted the filesystem's answer twice, and was wrong both
// times. First it assumed the per-component limit was the only one, which is
// false on Windows without long paths. Then it assumed the composed-path limit
// ALWAYS binds, which is false wherever long paths are enabled -- and that
// took deletion away from deep workspaces that had been working.
//
// So it stopped predicting. The rule offers CANDIDATES, longest first, and the
// caller renames its way down them: the real name is attempted before anything
// is thrown away, and a shorter one is used only when the platform actually
// refused the longer one. A name that fits is never shortened for a limit that
// did not apply -- which matters, because the trash keeps no record of the
// original name, so a character dropped here is gone for good.
//
// The entropy stays with the caller: this module takes the prefix already
// built, so it needs no crypto import and stays usable from any environment.

// The per-component limit, 255 everywhere dohc ships -- but NOT in the same
// unit. NTFS counts UTF-16 code units; ext4 and APFS count UTF-8 bytes. A
// 70-character CJK basename is 70 units and 210 bytes, so a byte rule on NTFS
// truncates a name the filesystem would have taken whole.
export const NAME_MAX_UNITS = 255;

// Win32 MAX_PATH: 260 including the terminating NUL, so 259 usable characters
// for the WHOLE path, counted in UTF-16 units. It applies only when the
// process is not long-path aware or
// HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled is 0 --
// which is why it is a FALLBACK here and never a precondition.
export const WINDOWS_MAX_PATH_CHARS = 259;

// TextEncoder/TextDecoder rather than Buffer, so this module carries no Node
// dependency. The decoder replaces a split multibyte sequence with U+FFFD,
// exactly as Buffer#toString does -- checked over every cut offset of 2-, 3-
// and 4-byte sequences, not assumed.
//
// ignoreBOM is the one place they disagree, and its name is inverted: it means
// "ignore the BOM-NESS of U+FEFF", so `true` KEEPS the character. The default
// eats a leading U+FEFF, which for filename bytes is data loss -- a name that
// legitimately starts with U+FEFF would come back a character short, silently,
// with no error to notice.
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** How a platform counts a path component. */
export type NameUnit = "utf16" | "utf8";

/** NTFS counts UTF-16 code units; ext4 and APFS count UTF-8 bytes. */
export function nameUnitFor(platform: string): NameUnit {
  return platform === "win32" ? "utf16" : "utf8";
}

function measure(value: string, unit: NameUnit): number {
  return unit === "utf16" ? value.length : utf8Encoder.encode(value).length;
}

// A UTF-16 slice can land between a surrogate pair. A lone surrogate is not
// something to hand a filesystem, so the half goes.
function withoutTrailingHalfPair(value: string): string {
  return /[\uD800-\uDBFF]$/.test(value) ? value.slice(0, -1) : value;
}

// Truncates a (decorative) name so that `${prefix}${result}` fits the
// per-component limit in the platform's unit, and -- when `maxEntryChars` is
// given -- the whole entry fits that many UTF-16 characters too.
export function fitWithinNameMax(
  name: string,
  prefix: string,
  options: { unit?: NameUnit; maxEntryChars?: number } = {},
): string {
  const unit = options.unit ?? "utf8";
  const maxEntryChars = options.maxEntryChars ?? Number.POSITIVE_INFINITY;

  const budget = NAME_MAX_UNITS - measure(prefix, unit);
  if (budget <= 0) return "";

  let fitted = name;
  if (measure(fitted, unit) > budget) {
    if (unit === "utf16") {
      fitted = withoutTrailingHalfPair(fitted.slice(0, budget));
    } else {
      // Byte-accurate: a multibyte sequence split at the cut decodes to
      // U+FFFD, which is trimmed so the entry never carries a dangling
      // replacement character.
      const bytes = utf8Encoder.encode(fitted);
      fitted = utf8Decoder.decode(bytes.subarray(0, budget)).replace(/�+$/, "");
    }
  }

  // Characters, after the component unit: two limits in two units, and one cut
  // cannot serve both, so the narrower one is applied second.
  const charBudget = maxEntryChars - prefix.length;
  if (fitted.length > charBudget) {
    fitted = withoutTrailingHalfPair(fitted.slice(0, Math.max(0, charBudget)));
  }
  return fitted;
}

/** The names to try, longest first, and what to do when they all fail. */
export interface TrashEntryPlan {
  /** Rename targets in order. Never empty; the first is untruncated. */
  candidates: string[];
  /**
   * True when a composed-path limit leaves no room even for the unique
   * prefix. There is no shorter name to fall back to, so a caller whose
   * candidates have all failed must refuse and name the limit.
   */
  exhausted: boolean;
}

// The ladder. Rung 1 is the real name, attempted before anything is thrown
// away. Rung 2 fits the per-component limit. Rung 3 also fits a composed-path
// limit, and exists only where one applies. Consecutive duplicates collapse,
// so a name that already fits yields exactly one candidate and one rename.
export function trashEntryPlan(
  name: string,
  prefix: string,
  options: { unit?: NameUnit; maxEntryChars?: number } = {},
): TrashEntryPlan {
  const maxEntryChars = options.maxEntryChars ?? Number.POSITIVE_INFINITY;
  const rungs = [
    `${prefix}${name}`,
    `${prefix}${fitWithinNameMax(name, prefix, { unit: options.unit })}`,
  ];
  const exhausted = prefix.length > maxEntryChars;
  if (!exhausted && Number.isFinite(maxEntryChars)) {
    rungs.push(`${prefix}${fitWithinNameMax(name, prefix, options)}`);
  }
  const candidates = rungs.filter(
    (rung, index) => index === 0 || rung !== rungs[index - 1],
  );
  return { candidates, exhausted };
}

// How many characters an entry name may use inside `directory` IF the legacy
// composed-path limit turns out to apply. Only Windows has one worth
// budgeting -- PATH_MAX is 4096 on Linux and 1024 on macOS, both far past
// anything the component limit allows -- so every other platform answers
// Infinity and the component rule alone governs.
export function trashEntryCharBudget(directory: string, platform: string): number {
  if (platform !== "win32") return Number.POSITIVE_INFINITY;
  return WINDOWS_MAX_PATH_CHARS - directory.length - 1; // 1 for the separator
}
