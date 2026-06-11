# e3 (explorer) codex security review — findings for e3(fix)

Source: two focused medium-effort codex passes (the xhigh/high passes overran
the reasoning budget on the full diff before flushing findings — split by file
worked). Logs: /tmp/codex-e3-movezip.log, /tmp/codex-e3-importmenu.log.
Apply AFTER E5.0 lands (both lanes append to main.ts/channels/preload).

## P1 — renderer-supplied import paths exfiltrate local files
`workspaceFiles.ts` importDroppedPaths (~:160): a compromised renderer passes
`/etc/passwd`, `~/.ssh/id_rsa`, or any readable absolute path in droppedPaths;
realpath + isFile() accepts it and copyIntoWorkspace copies it in — then cloud
sync can upload local secrets. Symlink drops to such files also pass (realpath
checked, not lstat of the original). Unregistered-workspace `.dohc` is
importable. 100-path cap only enforced at the zod parse (bridgeContract:185).
FIX: do not trust renderer-supplied absolute import paths. webUtils.getPathForFile
gives REAL dropped paths, but the threat is a compromised renderer forging the
array. Mitigation: keep OS-drag-in but (a) lstat each source, refuse symlinks
and non-regular files; (b) refuse sources whose realpath is inside ANY
dohc-managed location (.dohc anywhere) AND outside-of-home secrets are
inherently allowed since a real user drag could include them — so the true
control is that drag-in requires a genuine drop gesture. Since a compromised
renderer can forge the IPC regardless, the robust fix is to treat dropped
imports as COPIES the user must see: import into a visible quarantine/confirm,
OR accept the residual (renderer-compromise is already game-over given file
write IPCs exist) and at minimum lstat-refuse symlinks + non-regular files +
cap path count in the handler not just zod. DECISION for the fix lane: lstat
hardening + non-regular/symlink refusal + handler-level count cap + a comment
naming the compromised-renderer residual; do NOT remove OS drag-in (a shipped
feature). Confirm with the lead if a stronger quarantine is wanted.

## P2 cluster — symlink TOCTOU + zip-slip + move semantics
- movePath case-only descendant bypass (~:231): descendant refusal is
  case-sensitive lexical; on case-insensitive fs `Foo` -> `foo/bar` evades it.
  FIX: case-fold/realpath compare source vs dest-parent.
- movePath dest TOCTOU (~:252): dest-exists check then rename; POSIX rename
  overwrites if dest appears in between. FIX: no-overwrite move primitive
  (renameat2 RENAME_NOREPLACE where available) or accept+document (low: needs a
  colluding local process).
- deletePath follows symlink target (~:302): deleting a symlink trashes its
  target via realpath. FIX: lstat first, trash the LINK not the target.
- deletePath trash-dir race (~:318): validated then renamed-into later; raced
  symlink swap of trashDir moves data outside. FIX: dirfd/no-follow revalidate.
- deletePath long-basename (~:329): full basename prefix can exceed NAME_MAX.
  FIX: truncate basename, keep the uuid.
- export symlink leak (~:360,:374): export rejects symlink DIRENTS but add()
  stat/readFile can follow a file swapped to a symlink after readdir. FIX:
  lstat/open no-follow, recheck containment after open.
- export size cap before read (~:375): stat-cap then readFile; file can grow.
  FIX: open, fstat, bounded read from the fd.
- zipWriter zip-slip (~:67): entry names written verbatim; `../x` / `..\x`
  slip in extractors. FIX: validate entry names = relative POSIX, no abs/drive/
  backslash/empty-seg/`..`.
- OK: createFolder containment sandwich (pre+post mkdir lstat) is solid.

## Verify
Each fix gets a negative test; the existing e3 deletePath/move tests extend.
Re-run full desktop E2E + perf + lean. Adversarial replay of the P1 (forge a
droppedPaths array of /etc/passwd through the import handler in a test) and the
symlink-swap TOCTOUs.

## Disposition — e3(fix) implemented + adversarially verified

All P1 + P2 findings above are FIXED (commit: e3 fix lane) with negative tests:
- P1 import exfil: lstat the ORIGINAL source (final-component symlink refused),
  handler-level count cap, .dohc containment on canonical realpath.
- movePath case-fold descendant (realpath isInside guard), dest-TOCTOU
  documented-accepted; deletePath lstat-first (trash the LINK not the target) +
  NAME_MAX-safe trash names; export add() = open(O_NOFOLLOW)+fstat+bounded read
  (symlink-swap TOCTOU + grow-after-cap closed); zipWriter assertSafeEntryName
  (abs/drive/backslash/dotdot/empty-seg rejected). Move/trash TOCTOUs are
  documented accepted residuals (Node has no renameat2 RENAME_NOREPLACE).

Adversarial verification pass (workflow e3fix-adversarial-verify, 57 agents:
5 attackers x bypass attempts -> 17 candidate bypasses -> 3-lens refutation
each -> synthesis). Result: 16 of 17 refuted; every other fix confirmed to
hold on static reading (zip-slip, export no-follow, deletePath, movePath).

ONE confirmed (P2, 2/3 refuters): importDroppedPaths ancestor-symlink — a real
regular file reached through a symlinked ANCESTOR (drop `/stage/link/id_rsa`,
`link -> ~/.ssh`) still imports, because lstat refuses only the FINAL component
and realpath then canonicalizes to the secret.

DISPOSITION: accepted-residual + documented (NOT a code guard). Rationale:
(1) it grants a compromised renderer nothing beyond the already-accepted
residual — it can name `~/.ssh/id_rsa` directly and the final-component lstat
passes it; an ancestor symlink is just an alias to that same canonical path;
(2) the recommended `hasNoSymlinkedAncestor` walk would false-reject legitimate
OS drags through SYSTEM symlinks (macOS /tmp -> /private/tmp, /var -> /private/
var — including this repo's own temp-dir tests on macOS) = silent import loss
for zero security gain; (3) the one location gate we enforce (.dohc) runs on
the canonical realpath, so an ancestor symlink CANNOT smuggle a metadata source
past it — locked by a new test ("still refuses a .dohc source reached through a
symlinked ANCESTOR"). The genuine fix if this ever matters is a visible
import-confirm quarantine, deferred pending product sign-off (the original P1
already flagged quarantine as the stronger option). The code comment names this
residual at the call site.
