# Local notify changes

For maintainers updating the file watcher dependency: this directory contains
the `notify` 8.2.0 crates.io archive, with SHA-256
`4d3d07927151ff8575b7087f245456e549fea62edf0ec4e565a5ee50c8402bc3`.
Its recorded upstream commit is
`a1d7c2d8f80786679d58ec6d5986a1d4278bc8cf` in
[notify-rs/notify](https://github.com/notify-rs/notify).
The archive's CC0 license and source remain here.

The engine treats every callback as a reason to rescan and reads no path or
flag from it. An error callback also makes the engine watch the root again.
Remove this copy when the workspace moves to a stable release that has every
change below.

## FSEvents panics

The change in `src/fsevent.rs` removes two panics from the FSEvents callback.
A panic there cannot unwind through CoreServices, so it aborts the engine.

- A path that is not UTF-8 keeps its raw bytes. A FAT32 volume stores such a
  name percent-encoded but reports its raw bytes to FSEvents.
- Flag bits this version does not know are dropped.

Upstream fixed both sites after 8.2.0: the 9.0.0-rc.6 release candidate has
the fix, and no stable release does yet.
`dohc-engine-files/tests/watch.rs` creates a file with a non-UTF-8 name on a
FAT32 disk image and checks that the watcher keeps reporting changes.

## Windows changes that were never reported

The changes in `src/windows.rs` make two silent failures visible to the caller.

- When more changes arrive than the 16 KiB read buffer holds, Windows discards
  their details. It completes the next read with zero bytes or with
  `ERROR_NOTIFY_ENUM_DIR`. Unpatched 8.2.0 reported nothing for that read, so
  the engine missed the changes. The backend now sends a rescan event, as
  upstream 9.0.0-rc.5 does.
- After a read error it does not recognize, unpatched 8.2.0 stopped watching
  the directory and told nobody. The backend now removes the watch and then
  sends the error. Upstream 9.0.0-rc.5 still removes the watch silently.

`dohc-engine-files/tests/watch.rs` holds the backend's thread while 1000 new
files overflow the buffer, and checks that a rescan event arrives.

## Advisory checks

The crate is excluded from workspace membership and selected by the root Cargo
patch.

A crate taken from a path is outside `cargo deny` and `cargo audit` advisory
checks. Before updating or keeping this copy, check the RustSec advisory
database for notify by hand. `dohc-engine-files` pins `=8.2.0`, so a version
bump fails to resolve instead of quietly bringing back the upstream crate.
