---
name: dohc-release
description: Prepare or publish a dohc desktop nightly or stable release when Ice asks to build, cut, or ship one.
---

# Release dohc

Read [the release procedure](../../../docs/engineering/desktop-release.md) before preparing or dispatching a release.
Use the repository's release scripts for versioning and artifact checks.
This skill provides instructions, not credentials or repository permissions.

## Prepare the release

Confirm the requested channel, source commit, platforms, and publication intent from the conversation.
Default testing builds to the nightly channel and Windows x64.
Use `platforms=linux` for Linux-only builds and `platforms=windows-linux` for both platforms on one PC.
Use `platforms=macos` for macOS-only builds on the Mac runner.
Use `platforms=all` when every platform must receive the release.
Check previous releases on the requested channel before selecting platforms.
Continue including platforms that already receive updates on that channel.
A request to prepare a release authorizes preparation and a dry run.
A request to cut or publish a nightly authorizes publishing that testing build.
Preserve any broader publication authorization already given in the conversation.

For a stable release, inspect changes since the previous stable release.
Apply the project's agreed versioning policy to supported contracts and user-visible changes.
During initial development, use patch versions for fixes and minor versions for meaningful features or changed contracts.
Prepare the version change and release notes through the repository's review procedure.
The stable version must match the committed desktop package version.

## Run the workflow

Check the live workflow and its inputs before dispatching.
Confirm that the required self-hosted runners are online and owned by the release operator.
If a selected Windows runner is offline, start its registered `run.cmd` for this release.
For Linux-only builds, use the registered Linux runner for every job, including preflight and publication.
For WSL, follow the Linux runner and shared-PC requirements in the release procedure.
Start only a registered Linux runner that the operator owns, using its `run.sh` and native Linux tools.
Record the process identity and stop that task-started listener after the run finishes.
Check the local build budget before dispatching on the shared PC.
Release jobs accept only reviewed code on `main`.
Record the dispatched commit and inputs before starting the run.
Use `gh workflow run desktop-release.yml --ref main` with explicit channel, platforms, and dry-run values.
Leave nightly version selection to the release generator.
Retain the run URL and watch that run through completion.
If dispatch returns an uncertain result, inspect matching runs before retrying.
If a run fails, inspect its failed steps before starting another run.

## Deliver the result

Verify the selected installer files and update manifests with the repository's artifact verifier.
Report the release version, full source commit, selected platforms, signing status, and download or artifact URL.
Include the checks completed and any installer or update rehearsal still outstanding.
Private downloads require repository access.
Describe updater availability only after verifying its feed and an actual upgrade.
Keep installer verification separate from executing the packaged app.
Use an isolated profile and test workspace for packaged desktop QA on the owner's PC.
Complete the task's resource cleanup after preserving the installer and required evidence.
