# Release desktop builds

Release owners use this procedure before publishing installers. The
[capability reference](../reference/desktop-capabilities.md) lists release
targets and deployment requirements.

## Supported release targets

| Platform | Architectures | Published installer | Update package |
| --- | --- | --- | --- |
| Windows | x64 | NSIS `.exe` | `.exe` |
| macOS | arm64 (Apple silicon) | `.dmg` | `.zip` |
| Linux | x64 | AppImage | `.AppImage` |

The desktop release workflow builds each target from the matching Rust engine
target. macOS releases support Apple silicon only; there is no Intel build.
Stable releases require signing credentials for Windows and macOS.
Nightly builds may be unsigned for testing. An unsigned build is not a stable
release.

## Keep signing credentials on reviewed code

Store signing and notarization secrets in the GitHub `desktop-release` environment.
Do not store them as repository or organization secrets available to arbitrary branches.
Limit that environment's deployment branches to `main`, with no tag rules.
Add a required reviewer to that environment. For a private repository, GitHub offers required reviewers only on GitHub Enterprise; without it, anyone who can change `main` can publish.
Review organization-level signing-secret access before adding credentials.
Rotate any signing secrets that pull-request builds could have read.
Confirm that changes reaching `main` receive review before enabling signing.

The release workflow starts only when someone dispatches it.
Dispatches can start on other refs, but the preflight guard permits release jobs only on `main`.
Pull requests use local verification. Dry runs receive empty signing credentials.
The package and publish jobs both use the restricted environment.
The macOS signing and notarization secrets reach only the macOS package job, which runs on a fresh GitHub-hosted VM.
The Windows and Linux jobs receive empty values for them.
No release job runs on the self-hosted Mac. That runner's account outlives each job, and any repository writer can run code there.

## Provide release runners

Windows and Linux release jobs run on self-hosted runners.
macOS release jobs run on GitHub's hosted Apple silicon runner, `macos-26`, and bill the repository's Actions minutes.

| Jobs | Runner labels |
| --- | --- |
| Preflight, version check, and Publish for `linux` | `self-hosted`, `linux`, `x64` |
| Preflight, version check, and Publish for `macos` | `macos-26` (GitHub-hosted) |
| Preflight, version check, and Publish for other selections | `self-hosted`, `windows`, `x64` |
| Windows x64 package | `self-hosted`, `windows`, `x64` |
| Linux x64 package | `self-hosted`, `linux`, `x64` |
| macOS arm64 package | `macos-26` (GitHub-hosted) |

A job waits in the queue until a runner with its labels is online.
Each runner needs Git with bash, rustup, and the platform's native build tools.
The coordinator runner also needs the GitHub CLI, `gh`, for the version check and publishing.
Run the Windows runner in a signed-in desktop session for the packaged app check.
The Linux runner also needs `xvfb-run` for the fuse smoke.
The hosted macOS image ships bash 3.2, so the macOS Preflight and Publish jobs install Homebrew bash first.
After packaging, that check verifies the actual executable's fuse values and starts it with an isolated profile.
The smoke looks for `apps/desktop/release/linux-unpacked` on Linux, and on a Mac for `apps/desktop/release/mac-arm64/dohc.app`. Point `DOHC_SMOKE_PACKAGE_DIRECTORY` at any other unpacked directory or app bundle.
The package and publish jobs receive the environment's secrets.
Register only runners that the release owner controls.
On a shared Windows runner, set `DOHC_BUILD_SLOT_ROOT=C:\w\_locks` in the runner's `.env` file.
This keeps release engine builds within the local disk, slot, and compiler budget, even when Actions sets `CI=true`.
Start the runner's `run.cmd` when building a release.
The runner can stay offline between releases.

### Use WSL2 for Linux builds

Ubuntu on WSL2 can build the Linux x64 AppImage on a Windows PC.
Register a separate Linux runner inside the distribution with the `self-hosted`, `linux`, and `x64` labels.
Keep its checkout and dependencies in the Linux filesystem, such as under `/home/<user>/`, rather than `/mnt/c`.
Use Linux Node 24.16 or newer, pnpm 11.20.0, rustup, and native compiler tools.
Do not reuse Windows `node_modules` or a Windows pnpm executable.
Install Electron's Linux runtime libraries, `xvfb-run`, and AppImage's FUSE library.
Confirm these tools are on the runner's noninteractive `PATH` before starting its `run.sh`.

WSL shares the PC's CPU, memory, and physical disk with Windows.
Check host disk space and build admission before a release.
Coordinate WSL builds with other work on the PC and cap Cargo parallelism to the host's build budget.
Do not share Windows slot records with Linux processes because their PID namespaces differ.
The `windows-linux` selection packages its two targets sequentially.
The `all` selection can package Windows and WSL Linux concurrently.
Before selecting `all`, confirm that the PC has enough resources for both builds.

WSLg can display the packaged app, and Xvfb supports automated startup checks.
These checks do not prove Linux desktop installation, protocol registration, or real AppImage upgrades.
Use a normal Linux desktop or desktop VM for those release rehearsals.

## Contributor access to releases

The committed `dohc-release` skill is a public procedure. It contains no credentials and grants no GitHub permissions.
Contributors can use it to build local packages or operate workflows in their own forks.
They need repository write access to dispatch this repository's workflow.
Trusted collaborators with write access can also request publication through `dry_run=false`.

The publish job receives a short-lived token scoped to this repository, with `contents: write`.
A fork's token does not grant access to this repository's releases or signing secrets.
Protect changes to `main` and restrict the `desktop-release` environment to reviewed code.
If publication must require the owner's approval, configure required reviewers on that environment where the repository plan supports them.
A branch restriction alone does not require an owner's approval.

Keep self-hosted runners restricted to trusted code when the repository becomes public.
Do not enable fork pull-request execution on the owner's PC.
Require approval for all external contributors in the repository's Actions settings.
The [Mac runner guide](macos-runner.md) explains why any repository writer can run code on a self-hosted runner.

## Choose versions

Stable releases use SemVer in `apps/desktop/package.json`.
During initial development, bump the patch number for fixes and the minor number for meaningful features or changed contracts.
Reserve `1.0.0` for the first supported stable release.
An agent can recommend and prepare the version change from the changes since the previous stable release.
Review that change through the normal pull request procedure.

Nightlies need no committed version change.
With package version `0.1.0`, a nightly becomes `0.1.1-nightly.YYYYMMDD.RUN.ATTEMPT`.
The date uses UTC. GitHub supplies the run number and attempt.
Each published release retains its tag, source commit, notes, and installers in GitHub Releases.

## Build a Windows nightly

Dispatch `Desktop Release` from `main` with `channel=nightly`, `platforms=windows`, and `dry_run=true`.
The Windows runner performs every job for this selection.
The workflow generates the nightly version from the package version, UTC date, run number, and run attempt.
Download the run's `desktop-Windows-x64` artifact after every job passes.
Verify its files with the artifact command below.
Pass `--channel nightly` and the run's generated version to that command.
The Windows package job checks the executable with an isolated profile and test workspace before uploading it.
For publication, dispatch again with `dry_run=false`.
The new dispatch generates a new nightly version.
The published prerelease records the source commit and includes generated release notes.

## Build a macOS nightly

Dispatch `Desktop Release` from `main` with `channel=nightly`, `platforms=macos`, and `dry_run=true`.
GitHub-hosted macOS runners perform every job for this selection. No self-hosted runner is required.
Download the run's `desktop-macOS-arm64` artifact after every job passes.
It contains the `.dmg`, the `.zip` update package, and the nightly macOS update manifest.
Verify the files with `--platform mac`, `--arch arm64`, the generated version, and `--channel nightly`.
A dry run builds without signing. A published nightly is signed and notarized when the `desktop-release` environment has the macOS credentials, and unsigned otherwise.
A channel that already publishes Windows or Linux updates refuses a `macos` publication. Use `all` to publish there.

## Build a Linux nightly

Dispatch `Desktop Release` from `main` with `channel=nightly`, `platforms=linux`, and `dry_run=true`.
The Linux runner performs every job for this selection. A Windows runner is not required.
Download the run's `desktop-Linux-x64` artifact after every job passes.
It contains the AppImage and the nightly Linux update manifest.
Verify the files with `--platform linux`, `--arch x64`, the generated version, and `--channel nightly`.
The Linux package job checks artifact hashes and runs the packaged fuse smoke before uploading.

Use `platforms=windows-linux` to prepare both packages from one commit and generated version.
Both runners must be available. The Windows runner performs the coordinator jobs.
Download both platform artifacts from the same run.

Use `platforms=all` when Windows, macOS, and Linux runners are available.
Only the selected platforms receive installers and update packages.
Choose `all` when the release must update existing installations on every supported platform.
Continue including every platform that previously shipped on the selected channel.
For example, Windows and Linux history permits `windows-linux`, and macOS-only history permits `macos`. History with macOS and another platform requires `all`.
An updater cannot find its platform manifest in a release that omits it.
Before packaging a published release, the workflow checks every previous published release on that channel.
It rejects a selection that omits an existing platform manifest.
Partial-platform dry runs remain available because they publish no update feed.

Private repository downloads require repository access.
The packaged updater also needs an authenticated private feed or a public download host.
Do not embed a repository token in the desktop package.

## Publish a stable version

Merge the version change and its verification evidence into `main`.
Before enabling releases, configure the environment credentials and protect changes to `main`.
Complete the installer and update rehearsal below before publishing the first stable release.
Dispatch `Desktop Release` from `main` with `channel=latest` and the matching package version.
Select the platforms that the release supports.
Use `dry_run=true` to check unsigned packaging without publication.
For publication, use `dry_run=false`. Stable Windows and macOS builds require signing.

Pushing a tag does not start a release.
The publish job creates the release as a draft at the dispatched commit and uploads every file to it.
Its last step publishes the draft, and GitHub then creates the version's tag.
Updaters never read a draft.
A dispatch stops before packaging if its version already has a tag or a release, published or draft.
Then bump the version, or delete the draft that a stopped run left, and dispatch again.
A push to `main` starts no release.
A second dispatch on the same channel waits for the running one to finish.
GitHub keeps one waiting run per channel, and a newer dispatch replaces it.

## Choose an update feed

Packaged desktop builds normally check GitHub Releases.
`DOHC_UPDATE_URL` replaces that feed with an operator-selected generic update URL.
Set it only in a launch environment you control, and use a trusted HTTPS endpoint.

The app downloads available updates and installs them on quit.
Controlling the feed controls update metadata and the artifacts offered to the app.
Download hashes alone do not authenticate a feed whose metadata an attacker controls.
Windows publisher checks depend on the packaged `app-update.yml` configuration.
Do not assume unsigned builds have the same update guarantees as signed releases.

Development builds honor the override only with `DOHC_DESKTOP_MOCK_UPDATES=1`.
Before launch, test tampered updates against signed Windows and macOS release artifacts.
Verify the Linux update trust model separately; the Windows verifier does not cover AppImage updates.

## Configure usage and error reports

Packaged builds send usage reports and short error reports to one PostHog
project when the build names it. The
[reports reference](../reference/usage-and-error-reports.md) lists what they
hold for users. Development builds, test runs, isolated test launches, and dry
runs send nothing.

Set these repository variables. They are not secrets, because the app carries
the values.

| Variable | Value |
| --- | --- |
| `DOHC_POSTHOG_KEY` | The PostHog project API key, which starts with `phc_`. |
| `DOHC_POSTHOG_HOST` | `https://us.i.posthog.com`, `https://eu.i.posthog.com`, or your own HTTPS host. |

The workflow sets `DOHC_DESKTOP_DIST` to `<platform>-<arch>` for each package.
Error reports carry it as `dist`. A missing or invalid key or host turns off
both kinds of report. `scripts/verification/build.mjs` includes these
variables in the desktop build fingerprint.

Before the first release that reports:

1. In PostHog, turn on **Discard client IP data** for the project.
2. In PostHog, set a billing limit for product analytics and for error
   tracking. Check the current free allowance for each on PostHog's pricing
   page.

The app limits what it sends:

| Limit | Usage reports | Error reports |
| --- | --- | --- |
| Events per launch | 1,000 | 25 |
| Waiting at once | 100 | 10 |
| Sent | 60 s after the first waits, or at once when 50 wait | 1 s after the problem |
| Repeats | Each action counts | Each distinct problem once per launch |
| Prepared per launch | Same as sent | 100, repeats included. Each window hands main at most 25 distinct errors. |

A request times out after 10 s and is never retried. After a 429 response the
app waits as long as `Retry-After` says, up to one hour, and drops reports
until then. At quit, the app waits up to 3 s in total for a send under way and
the reports behind it, alongside workspace shutdown, then drops the rest.

Usage reports go to PostHog's batch endpoint from dohc's own code. Error
reports go through `posthog-node`'s `captureExceptionImmediate`, loaded the
first time an error report leaves. The SDK reads only the error dohc rebuilds
from allowlisted values, and it opens no files.

Usage events are `app_launched`, `workspace_created`, `workspace_opened`,
`share_created`, `app_published`, and `chat_message_sent`. To add one, add it
to `UsageEvent` and `USAGE_EVENTS` in `apps/desktop/src/telemetry/telemetry.ts`,
then update the reports reference.

PostHog groups an error report with frames in dohc's code by those frames,
once source maps resolve them. A report without such a frame sets
`$exception_fingerprint` from the failed part and the error chain, so problems
with the same message stay apart.

Each error report carries a new random distinct ID. PostHog's count of users
affected by an issue therefore counts reports, not people or installations.
An installation sends a problem at most once per launch, so a problem that
recurs on one computer still adds a report on each launch.

An error report sets `mechanism.handled` on its first exception to `false`
when nothing caught the error in main or a window. It is `true` for an error
a window's error boundary caught, and for engine and process failures that
dohc handled.

### Upload source maps

A production build writes hidden source maps beside its files. The installer
leaves them out. When `DOHC_POSTHOG_KEY` is set, add these so PostHog can show
original source lines:

| Name | Kind | Value |
| --- | --- | --- |
| `POSTHOG_CLI_API_KEY` | Environment secret | A personal API key with the `error tracking write` and `organization read` scopes. |
| `POSTHOG_CLI_PROJECT_ID` | Variable | The PostHog project ID. |
| `POSTHOG_CLI_HOST` | Variable | Set only for a host other than `https://us.posthog.com`, such as `https://eu.posthog.com`. |

The **Upload source maps** step runs `scripts/upload-desktop-source-maps.mjs`
for each package, after the desktop build and before packaging. The script
runs `posthog-cli sourcemap process` from `@posthog/cli` 0.18.10 on
`apps/desktop/dist/main` and `apps/desktop/dist/renderer`. The CLI writes a
chunk ID into each script, then uploads each source map under that ID with
release name `dohc-desktop`, the package version, and the package's dist as
the build. The script then fails if any script with a source map has no chunk
ID. The package ships those modified files, and error reports carry each
frame's chunk ID. No later step may rebuild `apps/desktop/dist`.

Without `DOHC_POSTHOG_KEY`, the step uploads nothing. With the key but without
`POSTHOG_CLI_API_KEY` or `POSTHOG_CLI_PROJECT_ID`, the step fails. To fix it,
add the missing value or clear the key. A dry run skips the step.

### Check a release against PostHog

The tests prove what leaves the app, but not that PostHog accepts and
resolves it. Run both checks below on Windows and on macOS for the first
release that reports, and after a `posthog-node` or `@posthog/cli` update.

#### Check source maps before the release

The release workflow publishes as soon as its packages pass, so check a local
package of the release commit first.
`apps/desktop/scripts/check-error-symbolication.mjs` checks that PostHog
resolves frames in the packaged main script and in the window's entry script.

The script reads the package's `app.asar` and the `apps/desktop/dist` folder
of the build that made it. The package leaves source maps out, so only that
folder has them. The script stops when a script in the folder differs from the
packaged one, or when its source map carries another chunk ID. It picks a
position in each script that the source map ties to dohc's own source. It then
builds one main error and one window error at those positions. dohc's own
report code prepares and sends them: `createTelemetry`, the same allowlist,
and `posthog-node`, built from the checkout. Both reports set `channel` and
`dist` to `release-check`.

The script makes these errors itself, so this check does not test the reports
notice or the switches. The installed release check below tests them.

1. Use a clean checkout of the release commit on a computer you control.
2. In one shell, set `DOHC_POSTHOG_KEY` and `DOHC_POSTHOG_HOST` to the
   release's PostHog project.
3. In the same shell, set `POSTHOG_CLI_API_KEY` and `POSTHOG_CLI_PROJECT_ID`.
   Set `POSTHOG_CLI_HOST` only for a host other than `https://us.posthog.com`.
4. Set `DESKTOP_VERSION` to the release version followed by `-release-check`.
   Set `DOHC_DESKTOP_DIST` to the package's dist, such as `win-x64`.
5. Set `CSC_IDENTITY_AUTO_DISCOVERY` to `false`, so the package stays unsigned.
6. From the repository root, build, upload, and package in this order:

   ```sh
   node scripts/update-desktop-package-version.mjs
   pnpm build:desktop
   node scripts/upload-desktop-source-maps.mjs
   pnpm --filter @dohc/desktop run build:engine
   pnpm --filter @dohc/desktop exec electron-builder --dir --publish never
   ```

7. Run the script without `--send`. It sends nothing:

   ```sh
   node apps/desktop/scripts/check-error-symbolication.mjs --app <app.asar> --dist apps/desktop/dist
   ```

   On Windows, `<app.asar>` is
   `apps/desktop/release/win-unpacked/resources/app.asar`. On an Apple
   silicon Mac, it is
   `apps/desktop/release/mac-arm64/dohc.app/Contents/Resources/app.asar`.
8. Confirm that the output shows `"passed": true`. Read each event's
   `payload`, which is the report the script would send.
9. Run the same command with `--send`. The script sends the two reports to
   the project from step 2 and waits up to 3 s for answers.
10. Confirm that the output shows `"passed": true`. Record each event's
    `eventId`, `expected`, and `releaseId`.
11. In PostHog, find each event by its `eventId`. Confirm that its top frame
    shows the `expected` file and line, and that its `$release_id` equals
    `releaseId`.

If `"passed"` is `false`, each event's `problem` says what failed. Fix the
cause and run the check again. Do not publish a release that reports until
PostHog resolves both frames.

#### Check the installed release

Use a disposable OS account or virtual machine in which no other dohc runs.
These steps stop one engine process: the one that this installation started.

1. In the release run, confirm that **Upload source maps** passed.
2. In PostHog, open the error tracking settings and find the symbol sets.
   Confirm that the release's chunk IDs are there.
3. Install the package, open a workspace, and close the reports notice. Keep
   **Error reports** on.
4. Find the engine process of this installation. On Windows, set `$install`
   to the installation folder, then run:

   ```powershell
   $engine = @(Get-CimInstance Win32_Process -Filter "Name = 'dohc-workspace-engine.exe'" |
     Where-Object ExecutablePath -eq "$install\resources\workspace-engine\dohc-workspace-engine.exe")
   $engine | Select-Object ProcessId, ParentProcessId
   Get-CimInstance Win32_Process -Filter "ProcessId = $($engine[0].ParentProcessId)" |
     Select-Object ExecutablePath, CommandLine
   Invoke-CimMethod -InputObject $engine[0] -MethodName GetOwner | Select-Object User
   ```

   Continue only if `$engine` holds one process, its owner is the disposable
   account, and its parent is `$install\dohc.exe` with no `--type=` in its
   command line. On macOS, run:

   ```sh
   main=$(pgrep -x -U "$(id -u)" dohc)
   engine=$(pgrep -P "$main" -f /Contents/Resources/workspace-engine/dohc-workspace-engine)
   ps -o user=,pid=,ppid=,command= -p "$main,$engine"
   ```

   Continue only if `main` and `engine` each hold one process ID, both belong
   to your account, and both commands are in the installed `dohc.app`.
5. Stop only that process. On Windows, run
   `Stop-Process -Id $engine[0].ProcessId -Force`. On macOS, run
   `kill -9 "$engine"`.
6. In PostHog, confirm that an `EngineDaemonUnavailableError` issue arrives
   with `process` set to `engine`, the release's `app_version` and `dist`, and
   `$release_id`.
7. Confirm that the event holds no file names, messages, or paths from your
   computer, and that PostHog made no person for it.
8. Turn **Error reports** off. dohc starts a new engine after step 5, so do
   step 4 again to find its process. Do step 5 again, and confirm that PostHog
   receives nothing.

## What the release workflow proves

The workflow runs the release helper tests and the desktop release smoke. Each
platform job then checks the generated files with
`scripts/verify-desktop-release-artifacts.mjs`. That check confirms all of the
following:

- The platform manifest has the requested version.
- Every manifest file exists in the release directory.
- The manifest size and SHA-512 match the file on disk.
- The legacy `path` and `sha512` fields point to one listed file.
- The expected installer files exist for the target architecture.
- Artifact paths stay inside the release directory.

The Linux job also runs the packaged fuse smoke.
It verifies the packaged executable's fuse values against `electron-builder.yml`.
It then boots that package with an isolated profile and checks that the window can start.
Windows-only selections skip that Linux check.
The Windows job runs the packaged executable with an isolated profile and test workspace.
It checks startup, editing, disk persistence, and restart before uploading artifacts.

These checks do not prove code signing, OS installer registration, update
installation, or an upgrade that preserves a user's profile. Release owners
must run those checks on a disposable account for each platform before the
first stable release.

## Verify a downloaded artifact

Download the matching update manifest and every file it lists.
Keep them in one directory with the installer for your target architecture.
On macOS, include the `.dmg` installer and `.zip` update packages.
Then run:

```powershell
node scripts/verify-desktop-release-artifacts.mjs `
  --directory . `
  --platform win `
  --arch x64 `
  --version 0.1.0 `
  --channel latest
```

Use `mac` with `arm64` for a macOS release. Use `linux` with `x64`
for an AppImage release. The command checks artifact bytes only.
For Windows and macOS stable releases, confirm the signature with the platform
tools before opening the installer. This workflow has no equivalent signing
requirement for AppImage.

## Installer rehearsal before launch

Use a clean disposable OS account or virtual machine. Install the artifact,
launch dohc, create a local workspace, edit a file, close dohc, and reopen it.
Then install the next build over the first build and confirm that the workspace
and settings remain. Record the platform, artifact name, version, signature
status, install result, upgrade result, and evidence location.

Exercise the in-app update flow between two signed builds on the same channel.
Confirm the displayed version after restart. Open the saved workspace and check
its edits and settings again. Reinstalling a newer package alone does not prove
the updater works.

To check the actual Windows packaged executable with an isolated profile, use
the existing benchmark with one run:

```powershell
node tools/perf-profiling/packaged-benchmark.mjs `
  --binary C:\release\dohc.exe `
  --package-commit <full-build-commit> `
  --output .agent-artifacts\release-check `
  --label candidate --runs 1 --idle-seconds 1 --keystrokes 5 --switches 1
```

Use a new output directory. Read its `result.json` before recording a pass.
The benchmark checks startup, editing, disk persistence, and restart. It does
not run an installer or install an update. It supplies an isolated profile and
`--dohc-isolated-test` so the app leaves the installed share-link handler alone.
Only use builds that implement this flag. The updater checks a loopback feed
with no newer release or downloadable package.

Keep its evidence until review ends, then remove it.
