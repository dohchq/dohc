# App compiler containment

Use this reference when changing the app compiler's owner processes, bounds, sandbox profile or runtime.
The compiler builds an app for publishing and for local launch.

## What the compiler runs

The desktop captures the app's declared files and sends their bytes to one compiler worker per build.
The worker parses them with acorn and parse5 and bundles them with esbuild.
A plugin resolves every import to a captured input.
The worker refuses `package.json`, `tsconfig`, `node_modules` and computed imports, and esbuild writes nothing to disk.
No app code runs.

Hostile or broken source can still make parsing expensive.
An unbounded 60 MB single-file app reached a 7.2 GB footprint on an Apple M2.
A memory-safety bug in V8 or esbuild could give that source code execution inside the worker.

## Each bound by platform

Electron main sets the bounds in `main.ts`. `compilerProcessSupervisor.ts` enforces the pipe sizes on both platforms.

| Bound | Windows: `windowsCompilerJob.ps1` | macOS: `crates/dohc-compiler-owner` |
| --- | --- | --- |
| 60 s | The job owner's deadline | The owner's deadline. RLIMIT_CPU of 61 s per core outlives the owner |
| 1 GiB | Committed memory of the whole job. An allocation past it fails | The summed physical footprint of the tree, sampled every 10 ms |
| 8 processes | Active processes in the job. A spawn past it fails | Live processes in the tree, sampled every 10 ms |
| Kill on close | Closing the job kills it | Stdin EOF makes the owner kill its tree. The supervisor kills the owner's process group as a fallback |
| Files and network | No isolation. The supervisor scrubs the environment | Seatbelt, below |

## macOS containment is weaker than a Windows job

The memory and process bounds are detection thresholds, not ceilings.
A tree can pass a bound until the next sample and the kill that follows.
On an Apple M2, a real compile passed the 1 GiB bound by 24 to 43 MB.
An allocator touching 14.4 GB/s passed it by 33 to 67 MB.
A spawn loop reached 9 to 12 processes against a bound of 8.
A peak shorter than one sample can pass unseen.

The owner finds its tree through its process group and through parent pids.
It keeps every descendant it has seen, with its start time, so a descendant that left the group is still killed.
A failed inspection keeps a descendant tracked. Only a confirmed exit or a changed start time removes it.

A worker that gains code execution can still hide a child from the owner.
It can move the child out of the group with setsid or setpgid, then exit before the next sample sees the child.
Seatbelt is the only bound on that escaped process:

- It cannot read file contents outside the compiler, the OS libraries and the build directory.
- It cannot write outside the build directory, use the network, or reach Mach services.
- It can run the installed Node, with any script it writes in the build directory, and esbuild. It cannot run other programs or load native code it writes.
- Nothing bounds its memory, its process count, its disk use in the build directory or its lifetime.
  RLIMIT_CPU counts each process alone, so a process that sleeps or forks outlives it.

The owner removes the build directory with `remove_dir_all`, which opens each directory without following symlinks.
The desktop then removes only an empty directory.
A path-based recursive remove can follow a symlink that an escaped process swaps in, and delete files outside the build directory.
In a standalone race, Node's recursive `rm` did so in 2 of 150 rounds.
If an escaped process keeps writing, the build directory stays in the system's temporary folder.

## The Seatbelt profile

`profile.rs` holds the profile. The owner applies it in the worker between fork and exec.
The owner itself stays outside the sandbox, so the worker cannot signal, stop or inspect it.

The profile denies by default. It allows:

- exec of the installed Node and the installed esbuild binary;
- reads of the compiler root, the OS libraries and the dyld cache;
- reads and writes in one new build directory per compile, but no executable mappings from it;
- signals and process information inside the same sandbox;
- the sysctls that Node and esbuild read at startup, listed by name.

Seatbelt does not mediate `kern.procargs2`.
A confined process with code execution can read the arguments and environment of every process the user runs, including the owner.
It could place what it reads in the published bundle.
This needs a memory-safety exploit in V8 or esbuild first.

Path metadata stays readable everywhere, because Node aborts at startup without it.
A confined worker can still learn whether a path it names exists, with its size and times.
It cannot list a directory or read a file outside the profile. dohc accepts that exposure.
The owner canonicalizes every path in the profile, because Seatbelt matches resolved paths.
It refuses paths that are not UTF-8 or that hold control characters.
If `sandbox_init`, a resource limit or the exec fails, the worker never runs and the build fails.
Apple deprecated Seatbelt in macOS 10.8, and it still works on macOS 27.

## The runtime

Both platforms run the official Node 24.16.0, pinned by sha256 in `stage-app-compiler.mjs`.
Staging checks the macOS arm64 release archive against `SHASUMS256.txt`, then checks the `node` binary inside it against its own pin.
Node 24 needs macOS 13.5, so publishing and local launch refuse older macOS.
The rest of dohc keeps Electron's minimum.
dohc ships for Apple silicon only, so staging refuses macOS x64 and an x64 process on a Mac refuses to build apps.

electron-builder signs `node` and `compiler-owner` with the hardened runtime and its default inherited entitlements.
It can name entitlements only for the main app, login items and one plist shared by every other binary, Electron's helpers included.
Node needs `allow-jit`. Scoping entitlements to Node alone would need a custom signing hook.
The defaults also grant `allow-unsigned-executable-memory` and `disable-library-validation`.
The sandbox limits library loads to the signed bundle and the OS.
The hardened runtime still ignores `DYLD_` variables and refuses debuggers.

Linux has no app compiler yet.

## Checking a change

- `node --test scripts/compiler-process.test.mjs` from `apps/desktop` runs each bound, the sandbox, and the owner's own defenses.
  Each macOS case fails without its mechanism.
- `node --test scripts/stage-app-compiler.test.mjs` checks staging, the pins and a relocated packaged compile.
- `cargo nextest run -p dohc-compiler-owner` checks path encoding, argument parsing and the libproc and Seatbelt calls.
- The release workflow's macOS packaged smoke builds one app through the signed arm64 package's compiler.
