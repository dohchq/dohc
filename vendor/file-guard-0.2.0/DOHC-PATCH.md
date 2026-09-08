# Local file-guard change

For maintainers updating the file locking dependency: this directory contains
the `file-guard` 0.2.0 crates.io archive, with SHA-256
`21ef72acf95ec3d7dbf61275be556299490a245f017cf084bd23b4f68cf9407c`.
Its recorded upstream commit is
`a4dc8e68bc3914f17dde16bfea839970a9a935bd` in
[kalamay/file-guard](https://github.com/kalamay/file-guard).
The archive's MIT license and source remain here.

The change in `src/os/unix.rs` selects Darwin's `F_OFD_SETLK` and
`F_OFD_SETLKW` commands through libc. Acquisition and release use the same
existing range and file descriptor. The Windows backend is unchanged.
The crate is excluded from workspace membership and selected by the root Cargo patch.
Application crates retain `forbid(unsafe_code)`.

The runtime holds one byte at offset `2^48` on the database file. This exceeds
SQLite's maximum database size and avoids its lock bytes. Darwin OFD locks
survive closure of unrelated descriptors. Classic POSIX locks do not.
Unsupported filesystems return an error; the runtime does not retry with a weaker lock.

The constants and file-description ownership were checked against libc 0.2.189
and [XNU f6217f891ac0bb64f3d375211650a4c1ff8ca1ea](https://github.com/apple-oss-distributions/xnu/tree/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea).
Regression tests cover SQLite open/close with a held lock, hard-link exclusion,
and actual daemon process death and reopen.
