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

| Bound | Windows: `windowsCompilerOwner.cs` | macOS: `crates/dohc-compiler-owner` | Linux: `crates/dohc-compiler-owner` |
| --- | --- | --- | --- |
| 60 s | The job owner's deadline | The owner's deadline. RLIMIT_CPU of 61 s per core outlives the owner | As on macOS |
| 1 GiB | Committed memory of the whole job. An allocation past it fails | The summed physical footprint of the tree, sampled every 10 ms | The summed anonymous and shared resident memory of the tree, sampled every 10 ms |
| 8 processes | Active processes in the job. A spawn past it fails | Live processes in the tree, sampled every 10 ms | As on macOS |
| Kill on close | Closing the job kills it | Stdin EOF makes the owner kill its tree. The supervisor kills the owner's process group as a fallback | As on macOS. The worker also dies when the owner dies |
| Files and network | No isolation. The supervisor scrubs the environment | Seatbelt, below | Landlock and seccomp, below |

On macOS and Linux the owner also counts the tree's task slots, which the user's process limit counts: each live process's threads on Linux, and every exited process no one has reaped.
More than 1,024 stops the build as the process bound does, so the owner stops a tree that hoards threads or zombies.
Like the other bounds it is sampled, so a fast loop can pass 1,024 before the next sample. It is a detection threshold, not a ceiling.

## macOS and Linux containment is weaker than a Windows job

The memory and process bounds are detection thresholds, not ceilings.
A tree can pass a bound until the next sample and the kill that follows.
On an Apple M2, a real compile passed the 1 GiB bound by 24 to 43 MB.
An allocator touching 14.4 GB/s passed it by 33 to 67 MB.
A spawn loop reached 9 to 12 processes against a bound of 8.
A peak shorter than one sample can pass unseen.
The Linux bounds sample the same way.

The macOS owner finds its tree through its process group and through parent pids.
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

The Linux owner is a child subreaper, so no process escapes it this way.
Every orphan becomes the owner's child, and the owner walks each process's children from `/proc/<pid>/task/<tid>/children`.
It needs no process group walk, which would read the whole process table every sample.
The kernel builds those lists without one lock, so a fork or exit during a read can hide a process from one census.
Teardown therefore also waits until the owner has no child left: every live descendant has a live ancestor that is the owner's child.
The owner also reaps every exited child but the worker on each sample, so adopted processes cannot hold the user's pids as zombies until teardown.
The worker dies with the owner. A descendant whose owner was killed outright still outlives it, unless the supervisor's group kill reaches it.

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

## The Linux rules

`rules.rs` holds the Landlock rules and seccomp filters. The owner builds them before it forks and applies them in the worker between fork and exec.
The owner stays outside them, as it does outside Seatbelt.

Landlock denies every file right it handles unless a rule allows it. The rules allow:

- reads of the compiler root, `/lib`, `/lib64`, `/usr/lib`, `/usr/lib64` and `/etc/ld.so.cache`;
- reads and execution of the installed Node, esbuild and the dynamic loader;
- reads and writes in one new build directory per compile, but no execution from it;
- `/dev/null`, `/dev/random` and `/dev/urandom`.

The first Landlock ABI, in Linux 5.13, is required, so the owner refuses to build without it and the desktop refuses older kernels.
Later rights apply where the kernel has them: renames across folders, truncation and device ioctls, TCP from ABI 4, and from ABI 6 signals and abstract sockets that leave the sandbox.
Ubuntu 24.04's 6.8 kernel has ABI 4, so the seccomp filters also cover what Landlock leaves open there.

The seccomp filters:

- refuse `socket` entirely, so the tree has no network and cannot reach D-Bus or another local service through a Unix socket. Node and esbuild talk over `socketpair` and pipes;
- refuse every signal, through `kill`, `tkill`, `tgkill`, both `sigqueue` calls and `pidfd_send_signal`. Seatbelt lets the tree signal processes inside its sandbox, but seccomp cannot tell those apart from the desktop or another program of the same user. Node and esbuild need no signal to compile: Go's runtime in esbuild then schedules its goroutines cooperatively, and the owner does all stopping;
- refuse async I/O ownership, which signals without `kill`, and changes to another process's limits and scheduling;
- refuse changes to a file's mode, owner, extended attributes and times, which Landlock does not mediate, and truncation by path, which it mediates only from ABI 3;
- refuse reads of extended attributes, which can hold a download's source address, and Linux 6.17's `file_getattr` and `file_setattr`;
- refuse System V shared memory, message queues and semaphores, and POSIX message queues, which other programs of the user may hold;
- refuse `statmount` and `listmount`, which name the user's mounted volumes;
- refuse `inotify` and `fanotify`, which would report activity on paths outside the sandbox;
- refuse tracing, other processes' memory, keyrings, BPF, perf events, `userfaultfd`, `unshare`, `setns`, and `clone` with a new namespace;
- answer `io_uring` and `clone3` with ENOSYS. `io_uring` can open sockets and files without the calls the filters check, and Node's libuv falls back to ordinary calls. `clone3` passes its flags where a filter cannot read them, and glibc falls back to `clone`;
- answer every call newer than Linux 6.17's `file_setattr` with ENOSYS, so a later kernel cannot add one the filters do not know;
- refuse every x32 call, which shares the x86-64 audit architecture but numbers syscalls differently.

Landlock does not mediate path metadata, so as on macOS a confined worker can learn whether a path exists.
It cannot read `/proc`, so unlike on macOS it cannot read other processes' arguments.
Landlock cannot refuse an executable mapping of a file the worker wrote, as Seatbelt does, so a worker that gains code execution can load native code from its build directory.
Through the dynamic loader it can also run any program it can read, and through a memory file any code it writes. Each still runs under the same rules and inside the owner's tree.
The memory bound counts pages a process maps. Data written to a memory file it never maps, or to a build directory on a tmpfs `/tmp` as on Fedora and Arch, is RAM the bound does not see.
Nothing bounds it, as nothing bounds disk use in the build directory on macOS.
That still needs a memory-safety exploit in V8 or esbuild first.
Node stops at startup when the system's OpenSSL configuration exists but stays unreadable, so the owner sets `OPENSSL_CONF` to `/dev/null`. The compiler needs no OpenSSL configuration.

## The runtime

Every platform runs the official Node 24.16.0, pinned by sha256 in `stage-app-compiler.mjs`.
Staging checks the macOS arm64 and Linux x64 release archives against `SHASUMS256.txt`, then checks the `node` binary inside each against its own pin.
Node 24 needs macOS 13.5, so publishing and local launch refuse older macOS.
The rest of dohc keeps Electron's minimum.
dohc ships for Apple silicon only, so staging refuses macOS x64 and an x64 process on a Mac refuses to build apps.

electron-builder signs `node` and `compiler-owner` with the hardened runtime and its default inherited entitlements.
It can name entitlements only for the main app, login items and one plist shared by every other binary, Electron's helpers included.
Node needs `allow-jit`. Scoping entitlements to Node alone would need a custom signing hook.
The defaults also grant `allow-unsigned-executable-memory` and `disable-library-validation`.
The sandbox limits library loads to the signed bundle and the OS.
The hardened runtime still ignores `DYLD_` variables and refuses debuggers.

On Windows, staging compiles `windowsCompilerOwner.cs` into `compiler-owner.exe` with the .NET Framework `csc.exe` that ships with Windows, as it compiles `agentProbeOwner.exe`.
electron-builder signs both as it copies them into the resources folder. Its `signExts` leaves only the official `node.exe` as Node signed it.

On Linux, dohc builds apps on x64 only. Staging for Linux arm64 ships only esbuild, which Collection actions compile with.

## Checking a change

- `node --test scripts/compiler-process.test.mjs` from `apps/desktop` runs each bound, the sandbox, and the owner's own defenses.
  The owner cases run on Apple silicon Macs and Linux x64. Each macOS case fails without its mechanism.
- `node --test scripts/stage-app-compiler.test.mjs` checks staging, the pins and a relocated packaged compile.
- `cargo nextest run -p dohc-compiler-owner` checks path encoding and argument parsing, the libproc and Seatbelt calls on macOS, and the `/proc` reads and the Landlock and seccomp rules on Linux.
- The verification queues run these tests on the shared Windows host and Mac. The Windows host's Linux job also runs the owner's cargo tests in WSL for every PR that selects Rust.
  No queue runs the two Node test files on Linux, so run their Linux cases in a Linux x64 checkout.
- The macOS release command's packaged smoke builds one app through the signed arm64 package's compiler.
