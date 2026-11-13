# Release desktop builds

Release owners use this procedure before publishing installers. The
[capability reference](../reference/desktop-capabilities.md) lists release
targets and deployment requirements.

## Supported release targets

| Platform | Architectures | Published installer | Update package |
| --- | --- | --- | --- |
| Windows | x64 | NSIS `.exe` | `.exe` |
| macOS | arm64 (Apple silicon) | `.dmg` | `.zip` |
| Linux | x64 | AppImage and `.deb` | `.AppImage` and `.deb` |

The Desktop Release workflow builds Windows and Linux, each from the matching
Rust engine target. The release owner builds macOS on an Apple silicon Mac with
`pnpm release:macos`, which adds its files to the release the workflow published.
Stable releases require signing credentials for Windows and macOS.
Nightly Windows builds may be unsigned for testing. The macOS command always
signs and notarizes a release. An unsigned build is not a stable release.

Ubuntu 24.04 and later block the unprivileged user namespaces that Chromium's
sandbox needs, so the AppImage refuses to start there and says why. The `.deb`
installs an AppArmor profile that allows them. The profile covers every process
the desktop app starts, including the engine, chat runners, and the commands
agents run, so each of them can also create user namespaces. Point Ubuntu and
Debian users to the `.deb`.

On Linux the app's executable is `dohc-desktop`, and the `.deb` links it into
`/usr/bin`. The `dohc` command belongs to the chat CLI that agents use
([reference](../reference/cli-mcp-sdk.md)).

## Keep signing credentials on reviewed code

Store the Windows signing secrets in the GitHub `desktop-release` environment.
Do not store them as repository or organization secrets available to arbitrary branches.
Restrict that environment to the `main` branch, with no tag rules.
Review organization-level signing-secret access before adding credentials.
Rotate any signing secrets that pull-request builds could have read.
Confirm that changes reaching `main` receive review before enabling signing.

The release workflow starts only when someone dispatches it.
Dispatches can start on other refs, but the preflight guard permits release jobs only on `main`.
Pull requests never run this workflow.
The package and publish jobs both use the restricted environment.
Only Windows signing and packaging steps receive the Windows signing secrets.
Linux receives no signing secrets.
Both package targets receive `POSTHOG_CLI_API_KEY` only in the source map upload step.
Dry runs receive no release secrets.

The macOS signing identity and notarization credentials stay in a release
keychain on the release owner's Mac. They never enter GitHub, and no workflow
can read them. The keychain stays locked between releases. Publishing the
macOS files needs the release owner to unlock it, or the password that the
owner [saved for unattended releases](#let-releases-run-unattended).

## Contributor access to releases

The committed `dohc-release` skill is a public procedure. It contains no credentials and grants no GitHub permissions.
Contributors can use it to build local packages or operate workflows in their own forks.
They need repository write access to dispatch this repository's workflow.
Trusted collaborators with write access can also request publication through `dry_run=false`.
While the repository is private, workflows from fork PRs never run. Before it goes public, require approval for every outside contributor's run ([setup](enable-blacksmith.md#prepare-the-account-at-launch)).

The publish job receives a short-lived token scoped to this repository, with `contents: write`.
A fork's token does not grant access to this repository's releases or signing secrets.
Protect changes to `main` and restrict the `desktop-release` environment to reviewed code.
If publication must require the owner's approval, configure required reviewers on that environment where the repository plan supports them.
A branch restriction alone does not require an owner's approval.

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

## Publish a nightly

The public alpha is the nightly channel. A nightly publishes only when all of these hold:

- The dispatch selects `platforms=windows-linux`, so every installation the workflow builds for receives the update.
- The Windows and Linux packages each pass their packaged smoke.
- No other nightly published in the same nightly day. A nightly day starts at 18:00 UTC, before the scheduled nightly at 20:00 UTC.

Before packaging, the workflow refuses a dispatch that breaks the platform or day rule.
The publish job checks both rules again before it creates the release.
A run that publishes after 18:00 UTC therefore counts for the nightly day it published in.
A nightly published by hand before 18:00 UTC doesn't hold back that evening's scheduled nightly.
When the workflow refuses a nightly, its error names the time the next nightly can publish.
A dry run skips both rules, so a dry run can test one platform at any time.
If any package fails, the publish job does not run.

To publish, dispatch `Desktop Release` from `main` with `channel=nightly`, `platforms=windows-linux`, and `dry_run=false`.
Then [add the macOS files](#add-the-macos-files) the same day.

### Publish nightlies on a schedule

On the Mac mini, a LaunchAgent publishes each nightly with nobody at the Mac.
It publishes without asking each time.
Every rule above still applies.

At 04:00 local time, launchd fetches `main` from `dohchq/dohc` into the job's own clone, `~/dohc-release/driver`.
It discards anything else in that clone, then runs `node scripts/release-nightly.mjs run` from it.
The job first waits up to 3 hours until the Mac's verification queue has no request queued or running. The nightly verification starts at 03:07.
The job publishes only when all of these hold:

- The Mac's full nightly verification passed on `main`'s head commit.
- `main` has changed since the newest nightly.
- No nightly published in that nightly day.

The job dispatches `Desktop Release` with `commit` set to that head. Preflight builds nothing unless `main` is still at `commit`.
The job follows the run for up to 6 hours.
When the run publishes, the job [adds the macOS files](#add-the-macos-files) to the new release.
The job never cancels a run, because that could interrupt a publish. It leaves a run that is still going after 6 hours to finish.
If the newest nightly published without its macOS files, the next night's job adds them first.
[`scripts/release-nightly.mjs`](../../scripts/release-nightly.mjs) holds the full sequence.

The job comments on #2281 after each published nightly and each failure.
It also comments on every other skip that leaves `main` unpublished.
When launchd cannot update its clone, the LaunchAgent comments and runs no code from the clone.
A night with nothing new posts nothing.
The LaunchAgent writes the job's output to `~/dohc-release/nightly.log`.

The job and every run of `release-desktop-macos.mjs` on the Mac take one lock, `~/dohc-release/release.lock`, so only one release command runs at a time.
A command that finds the lock held stops at once, and the job reports that night.
A crash leaves no stale lock.
`install` and `uninstall` also run under the lock, so stopping the job through them never interrupts the macOS command.
A logout, a shutdown, a forced kill, or stopping the LaunchAgent by hand with `launchctl bootout` still can.
The release keychain then locks itself after 30 minutes without use, or when the Mac sleeps.

The job needs all of these:

- The Mac's verification queue, installed with `pnpm verify:queue install`.
- A [saved release keychain password](#let-releases-run-unattended).
- `gh` signed in with write access to `dohchq/dohc` for dispatch, uploads, and issue comments.
- A signed-in session. launchd runs the job only there, where the login keychain is open.

Each night the job runs `main`'s code, and the release commit's dependency install scripts, with nobody watching.
It runs them with your `gh` token and while the saved keychain password can be read.
Anyone who can merge to `main` therefore controls what runs with those credentials.
Keep `main` protected: require a review and allow no bypass, including for administrators.

Install or remove the LaunchAgent from a login shell, in a checkout of `main` whose origin is `dohchq/dohc`.
The LaunchAgent keeps the `PATH` of the shell that installs it, which must find `node`, `git`, `gh`, `pnpm`, and the Xcode tools.
`install` makes the job's clone afresh each time:

```sh
node scripts/release-nightly.mjs install
node scripts/release-nightly.mjs uninstall
```

To check the workflow without publishing, run a dry run by hand. It dispatches with `dry_run=true`, waits for the run, and adds no macOS files:

```sh
node scripts/release-nightly.mjs run --dry-run
```

## Build a nightly without publishing

A dry run builds and checks the packages and publishes nothing.

1. Dispatch `Desktop Release` from `main` with `channel=nightly`, `dry_run=true`, and `platforms` set to `windows`, `linux`, or `windows-linux`.
2. After every job passes, download the run's `desktop-Windows-x64` artifact, its `desktop-Linux-x64` artifact, or both.
3. [Verify the files](#verify-a-downloaded-artifact) of each artifact. Pass `--platform win` or `--platform linux`, `--arch x64`, `--channel nightly`, and the run's generated version.

Each dispatch generates a new nightly version.
The Linux artifact contains the AppImage, the `.deb`, and the nightly Linux update manifest, which lists both.
`windows-linux` prepares both packages from one commit and generated version.
A nightly dispatch with one platform cannot publish. [Publish a nightly](#publish-a-nightly) with `platforms=windows-linux`.

## Select platforms for a published release

Only the selected platforms receive installers and update packages.
Continue including every platform that previously shipped on the selected channel.
For example, Windows and Linux history requires `windows-linux`.
An updater cannot find its platform manifest in a release that omits it.
Before packaging a published release, the workflow checks every previous published release on that channel.
It rejects a selection that omits an existing Windows or Linux manifest.
It does not check macOS, because the Mac command adds those files after the workflow publishes.
Partial-platform dry runs remain available because they publish no update feed.

## Publish a stable version

Merge the version change and its verification evidence into `main`.
Before enabling releases, configure the environment credentials and protect changes to `main`.
Complete the installer and update rehearsal below before publishing the first stable release.
Dispatch `Desktop Release` from `main` with `channel=latest` and the matching package version.
[Select the platforms](#select-platforms-for-a-published-release) that the release supports.
Use `dry_run=true` to check unsigned packaging without publication.
For publication, use `dry_run=false`. Stable Windows builds require signing.
Then [add the macOS files](#add-the-macos-files).

Pushing a tag does not start a release.
The publish job creates the release as a draft at the dispatched commit and uploads every file to it.
Its last step publishes the draft, and GitHub then creates the version's tag.
Updaters never read a draft.
A dispatch stops before packaging if its version already has a tag or a release, published or draft.
Then bump the version, or delete the draft that a stopped run left, and dispatch again.
A push to `main` starts no release.
A second dispatch on the same channel waits for the running one to finish.
GitHub keeps one waiting run per channel, and a newer dispatch replaces it.

## Add the macOS files

Follow these steps for every published release, nightly or stable.
Run the command as soon as the workflow publishes.
The [scheduled nightly job](#publish-nightlies-on-a-schedule) runs it for each nightly it publishes.
The command stops at once while another release command, such as the nightly job, runs on the Mac.
A Mac updater reads `<channel>-mac.yml` from the newest release on its channel.
Until this command uploads that file, a Mac on that channel shows no update and no error.
It updates at its first check after the file arrives.
Windows and Linux still report a missing manifest as an error, because the workflow always uploads theirs.
A custom `DOHC_UPDATE_URL` feed also reports it.
The release is not finished until the command reports that the release holds the macOS files.

1. Dispatch `Desktop Release` with `dry_run=false`. Wait until the run publishes the release.
2. Record the release tag, such as `v0.1.1-nightly.20261019.42.1`, and its channel.
3. On the Apple silicon Mac, run the command with `--dry-run` from any checkout that has it. Read the upload plan it prints.

   ```sh
   pnpm release:macos --version v0.1.1-nightly.20261019.42.1 --channel nightly --dry-run
   ```

4. Update a clean checkout of `main`, then run the same command from it without `--dry-run`.
5. If you [saved the release keychain's password](#let-releases-run-unattended), the command unlocks the keychain itself. Otherwise, it asks for the password twice: before it builds, and before it packages. Type it each time. Without a terminal, the command prints the `security unlock-keychain` command and waits up to 30 minutes for someone to run it.

| Flag | Meaning |
| --- | --- |
| `--version <version or tag>` | The release, such as `0.1.0` or `v0.1.1-nightly.20261019.42.1`. Required. |
| `--channel latest\|nightly` | The release's channel. Required. |
| `--keychain <path>` | The release keychain. The default is `~/Library/Keychains/dohc-release.keychain-db`. |
| `--keychain-profile <name>` | The notarytool profile in the release keychain. The default is `dohc-notary`. |
| `--dry-run` | Builds unsigned, runs every check that needs no signature, prints the upload plan, and uploads nothing. A dry run runs from any checkout, does not read or lock the release keychain, and sends no reports. |
| `--rehearse` | Only with `--dry-run`. Builds the checkout's own commit instead of the release commit, and prints what a real run refuses instead of stopping. |

The command builds the release commit in a throwaway worktree under `~/dohc-release/<tag>` and removes it when it ends.
It never changes the files of the checkout it runs from.
It builds as the workflow's package job does, then signs and notarizes the app and the DMG. [`scripts/release-desktop-macos.mjs`](../../scripts/release-desktop-macos.mjs) holds the steps.
Only the files to upload stay, in `~/dohc-release/<tag>/files`, until the upload succeeds.
A dry run uses `~/dohc-release/<tag>-dry-run` and keeps its files for inspection.
Ctrl-C, SIGTERM, or a closed terminal stops the command after the current step.
It starts no further upload, removes the throwaway worktree, and locks the release keychain.

A real run unlocks the release keychain for two short periods.
Before it builds, the command checks that the identity is valid and that the notarytool profile signs in. It reads the PostHog key into memory and locks the keychain again.
Before it packages, the command unlocks the keychain again. The keychain locks once Apple accepts the DMG.
The install, the builds, and the source map upload run with the keychain locked.
The upload fetches `@posthog/cli` outside the lockfile and runs its install script, and only that step receives the PostHog key.
If the keychain is already unlocked when packaging starts, someone opened it while the build ran. The command says so, locks it, and unlocks it again the usual way.
The command also locks the keychain when it ends, however it ends.

While the release keychain is unlocked, any program running as you can sign
with the Developer ID identity through `codesign` and notarize with the profile
through `notarytool`. Those periods cover the checks before the build,
electron-builder, and both notarization waits.

The command stops before it builds unless all of these are true:

- The host is an Apple silicon Mac, and Node runs as arm64.
- The release is published, and its prerelease state matches the channel.
- The release has no macOS files, or only part of an upload that the command can finish, as [Finish an upload that stopped](#finish-an-upload-that-stopped) describes.
- A Desktop Release run dispatched on the `main` branch has a successful `Publish` job for the tag's commit. A run dispatched on a tag named `main` does not count.
- For a nightly, that run and its attempt are the ones in the tag. A later attempt also counts when it re-ran only the failed jobs.
- The tag's commit is on the `main` branch.
- The version is the one the workflow stamped for the commit's package version and the tag.
- For a real run: the checkout that runs the command is clean and on `main`, and your `gh` account can upload to `dohchq/dohc`.
- For a real run: the release keychain holds one Developer ID Application certificate and the notarytool profile. While the `DOHC_POSTHOG_KEY` repository variable is set, it also holds the PostHog CLI API key.

When the command's message names this document, find the fix in [Prepare the Mac once](#prepare-the-mac-once).
Step 1 creates the release keychain, steps 4 and 5 add and confirm the certificate, step 6 stores the notarytool profile, and step 7 stores the PostHog key.
For a saved password that does not unlock the keychain, see [Let releases run unattended](#let-releases-run-unattended).

Before it uploads, the command runs `codesign --verify --deep --strict` and `spctl --assess` on the app, and `xcrun stapler validate` on the app and on the DMG.
It also runs the packaged fuse smoke and `scripts/verify-desktop-release-artifacts.mjs` for `mac` and `arm64`.
A dry run skips `spctl` and `stapler`, because an unsigned app has no Developer ID signature or ticket.

The command uploads the DMG, the ZIP, and the ZIP's blockmap first.
It uploads `<channel>-mac.yml` only after the release holds each of those files with the size and SHA-256 digest that the command built, so the manifest never names a missing file.
It refuses a manifest that names any other file.
After the upload, it reads the release back and compares every file again.
The manifest lists only the ZIP, which is what the Mac updater installs.
Stapling changes the DMG's bytes after packaging, so the DMG stays out of the manifest.

### Finish an upload that stopped

If an upload fails or you stop it, the command keeps the built files in
`~/dohc-release/<tag>/files` and says so. Run the same command again. A rebuild
signs with new timestamps, so the rerun does not rebuild. It finishes the
upload from the kept files when both of these are true:

- The release holds only some of the DMG, the ZIP, and its blockmap, and no `<channel>-mac.yml`.
- Each of those files on the release has the kept file's size and SHA-256
  digest, and the ZIP that the rerun downloads has the SHA-512 that the kept
  manifest names.

The rerun first checks the kept files as the stopped run did. It then uploads
the missing files and, after the release holds all three, the manifest. It
reads the release back. Finishing an upload signs nothing, so it does not
unlock the release keychain. In any other state, the command stops and prints
the `gh release delete-asset` commands that remove the macOS files from the
release. Run them only for that release, then run the command again to build
from the start. The command never offers to delete files from a release that
already has a Mac update manifest, because Macs may already update from it.

### Prepare the Mac once

The Mac needs the repository's development tools, the Xcode command line
tools, and `gh` signed in with write access to `dohchq/dohc`. The signing
identity, the notarization credentials, and the PostHog key live only in a
release keychain with its own password. Nothing goes in an environment
variable, and no key file stays on the Mac. Only the release keychain's own
password can go in the login keychain, if you
[let releases run unattended](#let-releases-run-unattended). The release keychain
is not in the keychain search list, so programs that search your keychains do
not find it.

1. Create the release keychain. `security` asks for a new password. Use one that differs from your login password:

   ```sh
   security create-keychain ~/Library/Keychains/dohc-release.keychain-db
   ```

2. Run `security list-keychains -d user`. If the list includes
   `dohc-release.keychain-db`, set it back to your login keychain:

   ```sh
   security list-keychains -d user -s ~/Library/Keychains/login.keychain-db
   ```

3. Make the keychain lock itself after 30 minutes without use, and when the Mac sleeps:

   ```sh
   security set-keychain-settings -lut 1800 ~/Library/Keychains/dohc-release.keychain-db
   ```

   The command locks the keychain itself, so this limit matters only if the
   command cannot. During a release, the longest time without use is one
   notarization wait.
4. Import the Developer ID Application certificate. `-x` makes macOS refuse to
   export its private key, though anyone with the keychain file and its
   password can still decrypt it. `-T` lets `codesign` use the key without asking. While
   the keychain is unlocked, any program running as you can run `codesign`
   with this identity:

   ```sh
   security import DeveloperIDApplication.p12 -k ~/Library/Keychains/dohc-release.keychain-db -x -T /usr/bin/codesign
   ```

   `security` asks for the `.p12` password. Then remove the `.p12` file from
   the Mac and keep it only in an offline backup.
5. Confirm that this command lists one valid `Developer ID Application` identity:

   ```sh
   security find-identity -v -p codesigning ~/Library/Keychains/dohc-release.keychain-db
   ```

6. Store the notarization credentials as a notarytool profile in the release
   keychain. Use an App Store Connect team API key with the Developer role. It
   can notarize but cannot sign in to your Apple ID, and you can revoke it in
   App Store Connect:

   ```sh
   xcrun notarytool store-credentials dohc-notary --key AuthKey_<key ID>.p8 --key-id <key ID> --issuer <issuer ID> --keychain ~/Library/Keychains/dohc-release.keychain-db
   ```

   notarytool copies the key into the keychain. Then remove the `.p8` file
   from the Mac. App Store Connect lets you download it only once, so keep it
   only in an offline backup, or revoke the key and create another when you
   need it again. If you cannot use an API key, use `--apple-id <Apple ID>
   --team-id <team ID>` instead of the three key options. notarytool then asks
   for an app-specific password, which can also sign in to that Apple ID. To
   use another profile name, pass it to the command with `--keychain-profile`.
7. While releases report to PostHog, store the PostHog CLI API key that
   uploads source maps. `read` keeps the key out of your shell history.
   `security -i` reads the command from its input, so the key is never in a
   command line that other programs can see:

   ```sh
   read -rs key && printf 'add-generic-password -a "%s" -s dohc-posthog-cli-api-key -w "%s" "%s"\n' "$USER" "$key" ~/Library/Keychains/dohc-release.keychain-db | security -i; unset key
   ```

   Use a personal API key with the scopes in [Upload source maps](#upload-source-maps).
   While the release keychain is unlocked, any program running as you can read
   this key with `security`.
8. Lock the release keychain:

   ```sh
   security lock-keychain ~/Library/Keychains/dohc-release.keychain-db
   ```

The first signed run can show a dialog that asks whether `codesign` may use
the key. Enter the release keychain's password and choose **Always Allow**.

### Let releases run unattended

To run releases with nobody at the Mac, save the release keychain's password
in your login keychain. `security` asks for the password twice:

```sh
security add-generic-password -U -a "$USER" -s dohc-release-keychain-password -w
```

The command then unlocks the release keychain itself at the same two points,
and locks it again as before.

This gives up what the release keychain's own password protects. While you
are logged in, any program running as you can read the saved password with
`security`. With it, a program can:

- Unlock the release keychain at any time, sign with your Developer ID,
  notarize, and read the PostHog key.
- Copy the keychain file and decrypt it on another computer. That gives it the
  Developer ID private key, the App Store Connect API key, and the PostHog key.
  `-x` does not prevent this. Deleting the saved password afterwards does not
  take the keys back.

The 30-minute and sleep locks no longer limit this. Code that runs during a
build can unlock the keychain, sign, and lock it again without the command
noticing. Anyone with your login password can also open the release keychain,
including from a backup of both keychain files. Without a saved password, a
program can sign, notarize, and read the PostHog key only while a release has
the keychain unlocked, and cannot take the Developer ID key or the App Store
Connect API key.

If you think a program took the keys, revoke the App Store Connect API key and the
PostHog key, and email product-security@apple.com to ask Apple to revoke the
Developer ID certificate. You cannot revoke it from your account. After Apple
revokes it, Macs no longer install releases signed with it.

If the saved password does not unlock the release keychain, the command stops
before it signs anything. Save the right one with the same command, or delete
it. To type the password again at each release, delete the saved one:

```sh
security delete-generic-password -s dohc-release-keychain-password
```

## Choose an update feed

Packaged desktop builds normally check GitHub Releases.
`DOHC_UPDATE_URL` replaces that feed with an operator-selected generic update URL.
Set it only in a launch environment you control, and use a trusted HTTPS endpoint.

Private repository downloads require repository access.
The packaged updater also needs an authenticated private feed or a public download host.
Do not embed a repository token in the desktop package.

The app checks for updates but downloads one only when the person selects Update
at the top right of the window. When the download finishes, the button reads
Restart to update. When dohc cannot start or a window keeps failing, a dialog
offers the update instead, and the download starts only when the person selects
Download. On Windows and macOS a downloaded update also installs on quit.
On Linux an update installs only when the person selects Restart to update: the
AppImage replaces itself, and the `.deb` installs with `dpkg` after the system
asks once for an administrator password. If `dpkg` reports missing dependencies,
`apt-get` adds them under the same password but never removes a package, then
`dpkg` installs again (`patches/electron-updater@6.8.9.patch`). A cancelled
prompt or any other failed install fails the update. Restart tries again.
When the password prompt was not cancelled, the failure also shows the
`sudo apt install` command for the downloaded `.deb`, with a copy control. That
covers a desktop where no authentication agent can ask for the password.
Controlling the feed controls update metadata and the artifacts offered to the app.
Download hashes alone do not authenticate a feed whose metadata an attacker controls.
Windows publisher checks depend on the packaged `app-update.yml` configuration.
Do not assume unsigned builds have the same update guarantees as signed releases.

Development builds honor the override only with `DOHC_DESKTOP_MOCK_UPDATES=1`.
Before launch, test tampered updates against signed Windows and macOS release artifacts.
Linux updates have no signature. The app checks only the SHA-512 that the same
release's manifest lists, when the download finishes, as T3 Code does. Whoever can
publish a GitHub release or set `DOHC_UPDATE_URL` can offer an AppImage that runs
as the person, or a package that the `.deb` installs as root. A signed apt
repository would add a signature for the `.deb`.

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

The app caps the reports it sends in each launch and drops the ones it cannot
send. The limits are `REPORT_LIMITS` in
[`apps/desktop/src/telemetry/telemetry.ts`](../../apps/desktop/src/telemetry/telemetry.ts).
The other files in [`apps/desktop/src/telemetry/`](../../apps/desktop/src/telemetry/)
build and send each report.

To add a usage event, add it to `UsageEvent` and `USAGE_EVENTS` in
`apps/desktop/src/telemetry/telemetry.ts`, then update the reports reference.

Each error report carries a new random distinct ID. PostHog's count of users
affected by an issue therefore counts reports, not people or installations.
An installation sends a problem at most once per launch, so a problem that
recurs on one computer still adds a report on each launch.

### Upload source maps

A production build writes hidden source maps beside its files. The installer
leaves them out. When `DOHC_POSTHOG_KEY` is set, add these so PostHog can show
original source lines:

| Name | Kind | Value |
| --- | --- | --- |
| `POSTHOG_CLI_API_KEY` | Environment secret | A personal API key with the `error tracking write` and `organization read` scopes. |
| `POSTHOG_CLI_PROJECT_ID` | Variable | The PostHog project ID. |
| `POSTHOG_CLI_HOST` | Variable | Set only for a host other than `https://us.posthog.com`, such as `https://eu.posthog.com`. |

The **Upload source maps** step runs
[`scripts/upload-desktop-source-maps.mjs`](../../scripts/upload-desktop-source-maps.mjs)
for each package, after the desktop build and before packaging. The script
runs `posthog-cli sourcemap process` from `@posthog/cli`. The CLI writes a
chunk ID into each script, then uploads each source map under that ID. The
package ships those modified files, and error reports carry each frame's
chunk ID. No later step may rebuild `apps/desktop/dist`.

Without `DOHC_POSTHOG_KEY`, the step uploads nothing. With the key but without
`POSTHOG_CLI_API_KEY` or `POSTHOG_CLI_PROJECT_ID`, the step fails. To fix it,
add the missing value or clear the key. A dry run uploads nothing. It only
installs the CLI and runs `posthog-cli --version`, so a CLI that cannot install
fails the dry run before it can fail a release.

### Check a release against PostHog

The tests prove what leaves the app, but not that PostHog accepts and
resolves it. Run both checks below on Windows and on macOS for the first
release that reports, and after a `posthog-node` or `@posthog/cli` update.

#### Check source maps before the release

Run this check before you dispatch the release. The release workflow publishes
as soon as its packages pass, so the check uses a local package of the release
commit.
[`apps/desktop/scripts/check-error-symbolication.mjs`](../../apps/desktop/scripts/check-error-symbolication.mjs)
checks that PostHog resolves frames in the packaged main script and in the
window's entry script. It builds one error in each, and dohc's own report code
prepares and sends them. Both reports set `channel` and `dist` to
`release-check`. The script makes these errors itself, so this check does not
test the reports notice or the switches.
[Check the installed release](#check-the-installed-release) tests them.

You need a clean checkout of the release commit on a computer you control.
Set these variables in one shell:

| Variable | Value |
| --- | --- |
| `DOHC_POSTHOG_KEY` and `DOHC_POSTHOG_HOST` | The release's PostHog project. |
| `POSTHOG_CLI_API_KEY` and `POSTHOG_CLI_PROJECT_ID` | As [Upload source maps](#upload-source-maps) describes. |
| `POSTHOG_CLI_HOST` | Set only for a host other than `https://us.posthog.com`. |
| `DESKTOP_VERSION` | The release version followed by `-release-check`. |
| `DOHC_DESKTOP_DIST` | The package's dist, such as `win-x64`. |
| `CSC_IDENTITY_AUTO_DISCOVERY` | `false`, so the package stays unsigned. |

1. From the repository root, build, upload, and package in this order:

   ```sh
   node scripts/update-desktop-package-version.mjs
   pnpm build:desktop
   node scripts/upload-desktop-source-maps.mjs
   pnpm --filter @dohc/desktop run build:engine
   pnpm --filter @dohc/desktop exec electron-builder --dir --publish never
   ```

2. Run the script without `--send`. It sends nothing:

   ```sh
   node apps/desktop/scripts/check-error-symbolication.mjs --app <app.asar> --dist apps/desktop/dist
   ```

   On Windows, `<app.asar>` is
   `apps/desktop/release/win-unpacked/resources/app.asar`. On an Apple
   silicon Mac, it is
   `apps/desktop/release/mac-arm64/dohc.app/Contents/Resources/app.asar`.
   `--dist` must name the folder of the build that made the package. The
   package leaves source maps out, so only that folder has them.
3. Confirm that the output shows `"passed": true`. Read each event's
   `payload`, which is the report the script would send.
4. Run the same command with `--send`. The script sends the two reports to
   the PostHog project and waits up to 3 s for answers.
5. Confirm that the output shows `"passed": true`. Record each event's
   `eventId`, `expected`, and `releaseId`.
6. In PostHog, find each event by its `eventId`.

The check passes when each event's top frame shows the `expected` file and
line, and its `$release_id` equals `releaseId`.

If `"passed"` is `false`, each event's `problem` says what failed. Fix the
cause and run the check again. Do not publish a release that reports until
PostHog resolves both frames.

#### Check the installed release

Run this check after the release publishes, on the installed package.
Use a disposable OS account or virtual machine in which no other dohc runs.
These steps stop one engine process: the one that this installation started.

Before you start, confirm both of these:

- In the release run, **Upload source maps** passed.
- In PostHog, the symbol sets in the error tracking settings hold the
  release's chunk IDs.

1. Install the package, open a workspace, and close the reports notice. Keep
   **Error reports** on.
2. Find the engine process of this installation. On Windows, set `$install`
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
3. Stop only that process. On Windows, run
   `Stop-Process -Id $engine[0].ProcessId -Force`. On macOS, run
   `kill -9 "$engine"`.
4. In PostHog, confirm that an `EngineDaemonUnavailableError` issue arrives
   with `process` set to `engine`, the release's `app_version` and `dist`, and
   `$release_id`.
5. Confirm that the event holds no file names, messages, or paths from your
   computer, and that PostHog made no person for it.
6. Turn **Error reports** off. dohc starts a new engine after step 3, so do
   step 2 again to find its process. Do step 3 again, and confirm that PostHog
   receives nothing.

The check passes when the confirmations in steps 4, 5, and 6 all hold.

## What the release workflow proves

Every workflow job runs on a fresh GitHub-hosted runner with a pinned image, `windows-2025` or `ubuntu-24.04`.
Windows and Linux packages build in parallel on separate machines.
The workflow runs the release helper tests and the desktop release smoke.
Each package job then checks its files and its packaged app before it uploads them.
The steps are in [`.github/workflows/desktop-release.yml`](../../.github/workflows/desktop-release.yml).

- Both jobs check the update manifest and the installer files with [`scripts/verify-desktop-release-artifacts.mjs`](../../scripts/verify-desktop-release-artifacts.mjs).
- The Windows job runs the packaged executable with an isolated profile and test workspace. It checks startup, editing, disk persistence, and restart.
- The Linux job runs the packaged fuse smoke with `xvfb-run`. The smoke checks the executable's fuse values against `electron-builder.yml` and starts the package with an isolated profile.
- The Linux job checks that a workspace survives an engine upgrade, because any nightly can add an engine migration. The packaged engine opens a test workspace that the newest published nightly's engine captured. The check runs in dry runs too. It skips with a notice when no nightly is published, or when the newest one predates the packaged engine and is listed in `scripts/select-upgrade-nightly.mjs`. It covers the engine store and workspace files, not app settings or the desktop profile.

To repeat an engine upgrade failure locally, set `DOHC_UPGRADE_PREVIOUS_ENGINE` to the older engine and run `pnpm --filter @dohc/desktop exec vitest run src/workspaces/engineUpgrade.e2e.test.ts`.
The fuse smoke uses `apps/desktop/release/linux-unpacked` on Linux and `apps/desktop/release/mac-arm64/dohc.app` on a Mac.
For a local smoke with another package path, set `DOHC_SMOKE_PACKAGE_DIRECTORY` to that directory or app bundle.

The workflow's checks do not prove code signing, installation, protocol
registration, OS installer registration, update installation, or an upgrade
that preserves a user's profile. Release owners must run those checks on a
disposable account or VM for each platform before the first stable release.

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
for an AppImage and `.deb` release. The command checks artifact bytes only.
For Windows and macOS stable releases, confirm the signature with the platform
tools before opening the installer. This workflow has no equivalent signing
requirement for the AppImage or the `.deb`.

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
