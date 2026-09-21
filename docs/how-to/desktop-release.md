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

The release workflow runs for pushes to `main`.
Manual dispatches can start on other refs, but the preflight guard permits release jobs only on `main`.
Pull requests use local verification. Dry runs receive empty signing credentials.
The package and publish jobs both use the restricted environment.

## Publish a stable version

Merge the version change and its verification evidence into `main`.
Before enabling releases, configure the environment credentials and protect changes to `main`.
Complete the installer and update rehearsal below before publishing the first stable release.
Dispatch `Desktop Release` from `main` with `channel=latest` and the matching package version.
Use `dry_run=true` to check unsigned packaging without publication.
For publication, use `dry_run=false`. Stable Windows and macOS builds require signing.

Pushing a tag does not start a release. The publish job creates the version's release tag.
After enabling the workflow, pushes to `main` produce nightly builds.

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
