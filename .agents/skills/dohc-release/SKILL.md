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
Default releases to the nightly channel and `platforms=windows-linux`.
A published nightly must select `platforms=windows-linux`, and only one nightly publishes per UTC day.
For a dry run, select fewer platforms when the request names them: `platforms=windows` or `platforms=linux`.
The workflow builds no macOS files. The Mac release command adds them after the workflow publishes.
For a stable release, check previous releases on its channel before selecting platforms.
Continue including platforms that already receive updates on that channel.
A request to prepare a release authorizes preparation and a dry run.
A request to cut or publish a nightly authorizes publishing that testing build, including its macOS files.
Preserve any broader publication authorization already given in the conversation.

For a stable release, inspect changes since the previous stable release.
Apply the project's agreed versioning policy to supported contracts and user-visible changes.
During initial development, use patch versions for fixes and minor versions for meaningful features or changed contracts.
Prepare the version change and release notes through the repository's review procedure.
The stable version must match the committed desktop package version.

## Run the workflow

Nightlies publish on a schedule from the Mac mini. See "Publish nightlies on a schedule" in the release procedure.
While that job is installed, do not dispatch a nightly by hand unless Ice asks.
Read the job's reports on #2281 before starting any nightly work.
To test the workflow without publishing, run `node scripts/release-nightly.mjs run --dry-run` on the Mac mini.
Check the live workflow and its inputs before dispatching.
The workflow uses fresh GitHub-hosted Windows and Linux runners.
Release jobs accept only reviewed code on `main`.
Record the dispatched commit and inputs before starting the run.
Use `gh workflow run desktop-release.yml --ref main` with explicit channel, platforms, and dry-run values.
Leave nightly version selection to the release generator.
Retain the run URL and watch that run through completion.
If dispatch returns an uncertain result, inspect matching runs before retrying.
If a run fails, inspect its failed steps before starting another run.

## Add the macOS files

Add the macOS files right after every run that publishes. Until then, Macs on that channel receive no update and show no error.
The scheduled nightly job adds them itself. If its report says that failed, run the command the report names.
A release is not finished until `pnpm release:macos` reports that the release holds the macOS files.
Do not report a release as done before that, because no Mac shows that the step was missed.
Follow "Add the macOS files" in the release procedure on the Apple silicon Mac that holds the release keychain.
Run `pnpm release:macos --version <tag> --channel <channel> --dry-run` and read its upload plan.
Run the real command from a clean checkout of `main`.
If Ice saved the release keychain's password in the login keychain, the command unlocks the keychain itself.
Otherwise, it asks for the password before it builds and before it packages, and Ice types it.
Never ask for that password, never read the saved one, and never pass it to a command.
Never create, change, or delete the saved password. If the command reports that it did not unlock the keychain, report that and stop.
If an upload stops, run the same command again. It finishes from the files it kept in `~/dohc-release/<tag>/files`.
If the command refuses, report its reason and stop.
Run the `gh release delete-asset` commands it prints only when Ice asks.

## Deliver the result

Verify the selected installer files and update manifests with the repository's artifact verifier.
Report the release version, full source commit, selected platforms, signing status, and download or artifact URL.
Report whether the macOS files were added, and the command's read-back result.
Report a Mac step that has not succeeded as unfinished release work.
Include the checks completed and any installer or update rehearsal still outstanding.
Private downloads require repository access.
Describe updater availability only after verifying its feed and an actual upgrade.
Keep installer verification separate from executing the packaged app.
Use an isolated profile and test workspace for packaged desktop QA on the owner's PC.
Complete the task's resource cleanup after preserving the installer and required evidence.
