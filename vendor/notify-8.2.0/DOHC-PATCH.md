# Local notify change

For maintainers updating the file watcher dependency: this directory contains
the `notify` 8.2.0 crates.io archive, with SHA-256
`4d3d07927151ff8575b7087f245456e549fea62edf0ec4e565a5ee50c8402bc3`.
Its recorded upstream commit is
`a1d7c2d8f80786679d58ec6d5986a1d4278bc8cf` in
[notify-rs/notify](https://github.com/notify-rs/notify).
The archive's CC0 license and source remain here.

The change in `src/fsevent.rs` removes two panics from the FSEvents callback.
A panic there cannot unwind through CoreServices, so it aborts the engine.

- A path that is not UTF-8 keeps its raw bytes. A FAT32 volume stores such a
  name percent-encoded but reports its raw bytes to FSEvents.
- Flag bits this version does not know are dropped.

The engine treats every callback as a reason to rescan and reads no path or
flag from it. Upstream fixed both sites after 8.2.0: the 9.0.0-rc.6 release
candidate has the fix, and no stable release does yet. Remove this copy when
the workspace moves to a stable release with that fix.

The crate is excluded from workspace membership and selected by the root Cargo
patch. `dohc-engine-files/tests/watch.rs` creates a file with a non-UTF-8 name
on a FAT32 disk image and checks that the watcher keeps reporting changes.

A crate taken from a path is outside `cargo deny` and `cargo audit` advisory
checks. Before updating or keeping this copy, check the RustSec advisory
database for notify by hand. `dohc-engine-files` pins `=8.2.0`, so a version
bump fails to resolve instead of quietly bringing back the upstream crate.
