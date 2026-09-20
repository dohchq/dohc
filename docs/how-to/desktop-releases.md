# Release desktop builds

Reader: maintainers packaging dohc and operators choosing an update feed.

## Keep signing credentials on reviewed code

Store signing and notarization secrets in the GitHub `desktop-release` environment.
Do not store them as repository or organization secrets available to arbitrary branches.
Restrict that environment to the `main` branch, with no tag rules.

The release workflow accepts pushes and manual dispatches on `main` only.
Pull requests use local verification. Dry runs receive empty signing credentials.
The package and publish jobs both use the restricted environment.

The workflow was manually disabled when checked on 2026-09-20. This change does not enable it.
Required environment reviewers were unavailable under the repository's billing plan.
The environment's branch restriction is configured in GitHub, outside this repository.

## Publish a stable version

Merge the version change and its verification evidence into `main`.
Before enabling releases, configure the environment credentials and protect changes to `main`.
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
