# Release desktop builds

Release owners use this procedure before publishing installers. The
[capability reference](../reference/desktop-capabilities.md) lists release
targets and deployment requirements.

## Supported release targets

| Platform | Architectures | Published installer | Update package |
| --- | --- | --- | --- |
| Windows | x64 | NSIS `.exe` | `.exe` |
| macOS | x64, arm64 | `.dmg` | `.zip` |
| Linux | x64 | AppImage | `.AppImage` |

The desktop release workflow builds each target from the matching Rust engine
target. Stable releases require signing credentials for Windows and macOS.
Nightly builds may be unsigned for testing. An unsigned build is not a stable
release.

## Keep signing credentials on reviewed code

Store signing and notarization secrets in the GitHub `desktop-release` environment.
Do not store them as repository or organization secrets available to arbitrary branches.
Restrict that environment to the `main` branch, with no tag rules.
Review organization-level signing-secret access before adding credentials.
Rotate any signing secrets that pull-request builds could have read.
Confirm that changes reaching `main` receive review before enabling signing.

The release workflow starts only when someone dispatches it.
Dispatches can start on other refs, but the preflight guard permits release jobs only on `main`.
Pull requests use local verification. Dry runs receive empty signing credentials.
The package and publish jobs both use the restricted environment.

## Provide self-hosted runners

Every release job runs on a self-hosted runner. Cloud runners stay off.

| Jobs | Runner labels |
| --- | --- |
| Preflight, Publish, and the Linux x64 package | `self-hosted`, `linux`, `x64` |
| Windows x64 package | `self-hosted`, `windows`, `x64` |
| macOS x64 and arm64 packages | `self-hosted`, `macos`, `arm64` |

A job waits in the queue until a runner with its labels is online.
Each runner needs Git with bash, rustup, and the platform's native build tools.
The Linux runner also needs `xvfb-run` for the fuse smoke and the GitHub CLI, `gh`, for publishing.
The package and publish jobs receive the environment's secrets.
Register only runners that the release owner controls.

## Publish a stable version

Merge the version change and its verification evidence into `main`.
Before enabling releases, configure the environment credentials and protect changes to `main`.
Complete the installer and update rehearsal below before publishing the first stable release.
Dispatch `Desktop Release` from `main` with `channel=latest` and the matching package version.
Use `dry_run=true` to check unsigned packaging without publication.
For publication, use `dry_run=false`. Stable Windows and macOS builds require signing.

Pushing a tag does not start a release.
The publish job creates the release as a draft at the dispatched commit and uploads every file to it.
Its last step publishes the draft, and GitHub then creates the version's tag.
Updaters never read a draft.
A dispatch stops before packaging if its version already has a tag or a release, published or draft.
Then bump the version, or delete the draft that a stopped run left, and dispatch again.
To build a nightly, dispatch `Desktop Release` from `main` with `channel=nightly`.
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

Packaged builds send usage reports to PostHog and short error reports to
Sentry when the build names those services. The
[reports reference](../reference/usage-and-error-reports.md) lists what they
hold for users. Development builds, test runs, isolated test launches, and dry
runs send nothing.

Set these repository variables. They are not secrets, because the app carries
the values.

| Variable | Value |
| --- | --- |
| `DOHC_POSTHOG_KEY` | The PostHog project API key, which starts with `phc_`. |
| `DOHC_POSTHOG_HOST` | `https://us.i.posthog.com`, `https://eu.i.posthog.com`, or your own HTTPS host. |
| `DOHC_SENTRY_DSN` | The Sentry project DSN. |

The workflow sets `DOHC_SENTRY_DIST` to `<platform>-<arch>` for each package.
The release name is `dohc-desktop@<version>`. A missing or invalid value turns
off that service only. `scripts/verification/build.mjs` includes these
variables in the desktop build fingerprint.

Before the first release that reports:

1. In PostHog, turn on **Discard client IP data** for the project.
2. In PostHog, set a billing limit. The free tier covers 1 million events a month.
3. In Sentry, turn on **Prevent storing of IP addresses** for the project.
4. In Sentry, keep spike protection on and set a rate limit on the DSN key.
   The Developer plan covers 5,000 errors a month; Team covers 50,000.

The app limits what it sends:

| Limit | Usage reports | Error reports |
| --- | --- | --- |
| Events per launch | 1,000 | 25 |
| Waiting at once | 100 | 10 |
| Sent | 60 s after the first waits, or at once when 50 wait | 1 s after the problem |
| Repeats | Each action counts | Each distinct problem once per launch |
| Prepared per launch | Same as sent | 100, repeats included. Each window hands main at most 25 distinct errors. |

A request times out after 10 s and is never retried. The app honors
`Retry-After` and `X-Sentry-Rate-Limits` for up to one hour, and drops reports
until then. At quit, waiting reports get one try of 3 s that quit does not wait for.

Usage events are `app_launched`, `workspace_created`, `workspace_opened`,
`share_created`, `app_published`, and `chat_message_sent`. To add one, add it
to `UsageEvent` and `USAGE_EVENTS` in `apps/desktop/src/telemetry/telemetry.ts`,
then update the reports reference.

### Upload source maps

A production build writes hidden source maps beside its files. The installer
leaves them out. When `DOHC_SENTRY_DSN` is set, add these so Sentry can show
original source lines:

| Name | Kind | Value |
| --- | --- | --- |
| `SENTRY_AUTH_TOKEN` | Environment secret | An organization token that can upload release files. |
| `SENTRY_ORG` | Variable | The organization slug. |
| `SENTRY_PROJECT` | Variable | The project slug. |
| `SENTRY_URL` | Variable | Set only for self-hosted Sentry. |

The **Upload source maps** step runs `scripts/upload-desktop-source-maps.mjs`
for each package. The script runs `@sentry/cli` 3.8.0 to upload
`apps/desktop/dist` with that package's release and dist, under the URL prefix
`app:///dist`. Error reports name frames the same way. Without
`DOHC_SENTRY_DSN`, the step uploads nothing. With the DSN but without
`SENTRY_AUTH_TOKEN`, the step fails. To fix it, add the token or clear the DSN.
A dry run skips the step.

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

The Linux job also runs the packaged fuse smoke. It boots an asar assembled
from the built desktop files and verifies that the packaged window can start.

These checks do not prove code signing, OS installer registration, update
installation, or an upgrade that preserves a user's profile. Release owners
must run those checks on a disposable account for each platform before the
first stable release.

## Verify a downloaded artifact

Download the matching update manifest and every file it lists.
Keep them in one directory with the installer for your target architecture.
On macOS, include the `.dmg` installer and `.zip` update packages.
A published macOS manifest can list packages for both architectures.
Then run:

```powershell
node scripts/verify-desktop-release-artifacts.mjs `
  --directory . `
  --platform win `
  --arch x64 `
  --version 0.1.0 `
  --channel latest
```

Use `mac` with `x64` or `arm64` for a macOS release. Use `linux` with `x64`
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
