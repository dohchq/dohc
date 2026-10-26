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
macOS releases support Apple silicon only; there is no Intel build.
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
Pull requests never run this workflow. Dry runs receive empty signing credentials.
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

## GitHub-hosted release jobs

Every workflow job runs on a fresh GitHub-hosted runner with a pinned image.
Windows and Linux packages build in parallel on separate machines.

| Jobs | Image |
| --- | --- |
| Preflight for `linux` | `ubuntu-24.04` |
| Preflight for other selections | `windows-2025` |
| Version check and Publish | `ubuntu-24.04` |
| Windows x64 package | `windows-2025` |
| Linux x64 package | `ubuntu-24.04` |

The workflow installs the pinned Node, pnpm, and Rust versions before building.
The Windows package runs the packaged app check in its runner's desktop session.
The Linux package runs its fuse smoke with `xvfb-run`.
The smoke checks the executable's fuse values and starts it with an isolated profile.
It uses `apps/desktop/release/linux-unpacked` on Linux and `apps/desktop/release/mac-arm64/dohc.app` on a Mac.
For a local smoke with another package path, set `DOHC_SMOKE_PACKAGE_DIRECTORY` to that directory or app bundle.
These checks do not prove installation, protocol registration, or installer upgrades.
Use a disposable desktop account or VM for those release rehearsals.

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
Then [add the macOS files](#add-the-macos-files) the same day. The Mac command always signs and notarizes.

### Publish nightlies on a schedule

On the Mac mini, a LaunchAgent publishes each nightly with nobody at the Mac.
Ice decided on 2026-10-20 that it publishes without asking each time.
Every rule above still applies.

At 04:00 local time, launchd fetches `main` into its own clone in `~/dohc-release/driver`.
It fetches from the `dohchq/dohc` URL that `install` checked, whatever the clone's own origin says.
`install` makes that clone afresh each time. When the fetch or checkout fails, `gh` reports it, so no code from the clone runs.
It discards anything else in that clone, then runs `node scripts/release-nightly.mjs run` from it.
The job stops unless the clone is clean and on `main`. The job:

1. Waits up to 3 hours until the Mac's verification queue has no request queued or running. The nightly verification starts at 03:07.
2. Adds the macOS files to the newest nightly if it published without them, after a failure or a lost run.
3. Skips the night when `main` has not changed since the newest nightly, or when a nightly already published in that nightly day.
4. Skips the night unless the Mac's full nightly verification passed on `main`'s head commit.
5. Dispatches `Desktop Release` with `channel=nightly`, `platforms=windows-linux`, `dry_run=false`, and `commit` set to that head. Preflight builds nothing unless `main` is still at `commit`. The run's title names the channel, a dry run, and the commit, so the job follows its own run.
6. Follows the run for up to 6 hours. When the run publishes, the job [adds the macOS files](#add-the-macos-files) to the new release. The job never cancels a run, because that could interrupt a publish. A run still going after 6 hours is left to finish, and if it publishes, the next night adds its macOS files.

The job comments on #2281 after each published nightly and each failure.
It also comments on every other skip that leaves `main` unpublished, such as missing verification or a nightly already published that nightly day, and when launchd cannot update its clone.
A night with nothing new posts nothing.
The LaunchAgent writes the job's output to `~/dohc-release/nightly.log`.
The job and every run of `release-desktop-macos.mjs` on the Mac take one lock, `~/dohc-release/release.lock`, so only one release command runs at a time.
The system releases the lock when the last process holding it exits, so a crash leaves no stale lock.
A command that finds it held stops at once, and the job reports that night on #2281.
`install` and `uninstall` also run under the lock, so stopping the job through them never interrupts the macOS command.
A logout, a shutdown, a forced kill, or stopping the LaunchAgent by hand with `launchctl bootout` still can. The release keychain then locks itself after 30 minutes without use, or when the Mac sleeps.

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
The LaunchAgent keeps the `PATH` of the shell that installs it, which must find `node`, `git`, `gh`, `pnpm`, and the Xcode tools:

```sh
node scripts/release-nightly.mjs install
node scripts/release-nightly.mjs uninstall
```

To check the workflow without publishing, run a dry run by hand. It dispatches with `dry_run=true`, waits for the run, and adds no macOS files:

```sh
node scripts/release-nightly.mjs run --dry-run
```

## Build a Windows nightly

Dispatch `Desktop Release` from `main` with `channel=nightly`, `platforms=windows`, and `dry_run=true`.
Preflight and packaging run on `windows-2025`. The version check runs on `ubuntu-24.04`.
The workflow generates the nightly version from the package version, UTC date, run number, and run attempt.
Download the run's `desktop-Windows-x64` artifact after every job passes.
Verify its files with the artifact command below.
Pass `--channel nightly` and the run's generated version to that command.
The Windows package job checks the executable with an isolated profile and test workspace before uploading it.
A Windows-only nightly dispatch cannot publish. [Publish a nightly](#publish-a-nightly) with `platforms=windows-linux`.
Each dispatch generates a new nightly version.
The published prerelease records the source commit and includes generated release notes.

## Build a Linux nightly

Dispatch `Desktop Release` from `main` with `channel=nightly`, `platforms=linux`, and `dry_run=true`.
Every job for this selection runs on `ubuntu-24.04`.
Download the run's `desktop-Linux-x64` artifact after every job passes.
It contains the AppImage, the `.deb`, and the nightly Linux update manifest, which lists both.
Verify the files with `--platform linux`, `--arch x64`, the generated version, and `--channel nightly`.
The Linux package job checks artifact hashes and runs the packaged fuse smoke and the engine upgrade check before uploading.

Use `platforms=windows-linux` to prepare both packages from one commit and generated version.
The packages build in parallel. Preflight runs on `windows-2025`; the version check and Publish run on `ubuntu-24.04`.
Download both platform artifacts from the same run.

Only the selected platforms receive installers and update packages.
Continue including every platform that previously shipped on the selected channel.
For example, Windows and Linux history requires `windows-linux`.
An updater cannot find its platform manifest in a release that omits it.
Before packaging a published release, the workflow checks every previous published release on that channel.
It rejects a selection that omits an existing Windows or Linux manifest.
It does not check macOS, because the Mac command adds those files after the workflow publishes.
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
5. If you [saved the release keychain's password](#let-releases-run-unattended), the command unlocks the keychain itself. Otherwise, it asks for the password twice: before it builds, and before it packages. Type it each time.

A real run opens the release keychain for two short periods. Before it builds,
the command unlocks the keychain, checks that the identity is valid and that the
notarytool profile signs in, reads the PostHog key into memory, and locks the
keychain again. The install, the builds, and the source map upload then run
with the keychain locked. The upload fetches `@posthog/cli` outside the
lockfile and runs its install script, and only that step receives the PostHog
key. Before packaging, the command unlocks the keychain again. electron-builder
signs and notarizes the app, the command notarizes the DMG, and the keychain
locks once Apple accepts it. If the keychain is already unlocked when
packaging starts, someone opened it while the build ran. The command says so,
locks it, and unlocks it again the usual way. The command also locks the
keychain when it ends, however it ends.

With a saved password, the command unlocks the keychain itself. Otherwise, in a
terminal, `security` asks for the password. Without a terminal, the command
prints the `security unlock-keychain` command and waits up to 30 minutes for
someone to run it.

While the release keychain is unlocked, any program running as you can sign
with the Developer ID identity through `codesign` and notarize with the profile
through `notarytool`. Those periods cover the checks before the build,
electron-builder, and both notarization waits.

The command never changes the files of the checkout it runs from. It fetches
the release commit and creates a throwaway worktree of it in
`~/dohc-release/<tag>/checkout`. It installs dependencies there and builds the
engine there with its own Cargo target folder. When it ends, it removes that
worktree and Git's record of it. Only the files to upload stay, in
`~/dohc-release/<tag>/files`, until the upload succeeds. A dry run uses
`~/dohc-release/<tag>-dry-run` and keeps its files for inspection.

The command stops before it builds unless all of these are true:

- The host is an Apple silicon Mac, and Node runs as arm64.
- The release is published, and its prerelease state matches the channel.
- The release has no macOS files, or only part of an upload that the command
  can finish, as [Finish an upload that stopped](#finish-an-upload-that-stopped) describes.
- A Desktop Release run dispatched on `main` published the tag's commit: its
  `Publish` job succeeded for that commit. For a nightly, that run is the one
  in the tag. Its attempt is the tag's attempt, or a later attempt that re-ran
  only the failed jobs and so kept the tag attempt's Preflight, which stamped
  the version. The workflow runs `Publish` only after Preflight
  passes on `refs/heads/main`, so a run dispatched on a tag named `main` does
  not count. The commit must also be on the `main` branch's current commit.
- The version is the one the workflow stamped. The command resolves it with
  `scripts/resolve-desktop-release.mjs`, from the commit's package version and
  the nightly date, run number, and attempt in the tag.
- For a real run: the checkout that runs the command is clean and on `main`,
  and your `gh` account can upload to `dohchq/dohc`. A dry run runs from any
  checkout and prints which commit it ran from.
- For a real run: the release keychain exists and holds one Developer ID
  Application certificate and the notarytool profile. While the
  `DOHC_POSTHOG_KEY` repository variable is set, it also holds the PostHog CLI
  API key. A locked keychain shows all of this.

When it first unlocks the keychain, the command checks that the identity is
valid and that the notarytool profile signs in.

The command then follows the workflow's package job. It stamps the version,
builds the desktop and the `aarch64-apple-darwin` engine, and runs the package
smoke. A real run builds with the repository's PostHog variables and uploads
source maps after the engine build, before packaging, with the release keychain
locked. electron-builder signs the
app with the identity in the release keychain and notarizes and staples it
through the notarytool profile. The command then notarizes and staples the DMG.

Before it uploads, the command runs these checks:

- `codesign --verify --deep --strict` on the app.
- `spctl --assess` on the app.
- `xcrun stapler validate` on the app and on the DMG.
- The packaged fuse smoke, which also compiles one app through the packaged compiler and boots the app.
- `scripts/verify-desktop-release-artifacts.mjs` for `mac` and `arm64`.

The command uploads the DMG, the ZIP, and the ZIP's blockmap. It uploads
`<channel>-mac.yml` only after the release holds each of those files with the
size and SHA-256 digest that the command built, so the manifest never names a
missing file. It refuses a manifest that names any other file. It then reads
the release back and compares every file again. The manifest lists only the
ZIP, which is what the Mac updater installs. Stapling changes the DMG's bytes
after packaging, so the DMG stays out of the manifest.

Ctrl-C, SIGTERM, or a closed terminal stops the command after the current step.
It starts no further upload, removes the throwaway worktree, and locks the
release keychain.

| Flag | Meaning |
| --- | --- |
| `--version <version or tag>` | The release, such as `0.1.0` or `v0.1.1-nightly.20261019.42.1`. Required. |
| `--channel latest\|nightly` | The release's channel. Required. |
| `--keychain <path>` | The release keychain. The default is `~/Library/Keychains/dohc-release.keychain-db`. |
| `--keychain-profile <name>` | The notarytool profile in the release keychain. The default is `dohc-notary`. |
| `--dry-run` | Builds unsigned, runs every check that needs no signature, prints the upload plan, and uploads nothing. A dry run runs from any checkout, does not read or lock the release keychain, and sends no reports. |
| `--rehearse` | Only with `--dry-run`. Builds the checkout's own commit instead of the release commit, and prints what a real run refuses instead of stopping. |

A dry run skips `spctl` and `stapler`, because an unsigned app has no
Developer ID signature or ticket.

### Finish an upload that stopped

If an upload fails or you stop it, the command keeps the built files in
`~/dohc-release/<tag>/files` and says so. Run the same command again. A rebuild
signs with new timestamps, so the rerun does not rebuild. It finishes the
upload from the kept files when both of these are true:

- The release holds only some of the DMG, the ZIP, and its blockmap, and no `<channel>-mac.yml`.
- Each of those files on the release has the kept file's size and SHA-256
  digest, and the ZIP that the rerun downloads has the SHA-512 that the kept
  manifest names.

The rerun first checks the kept files as the stopped run did. It runs the
artifact verifier on them, unpacks the ZIP, and runs `codesign`, `spctl`, and
`stapler` on the app and `stapler` on the DMG. It then uploads the missing
files and, after the release holds all three, the manifest. It reads the
release back. Finishing an upload signs nothing, so it does not unlock the
release keychain. In any other state, the command stops and prints the
`gh release delete-asset` commands that remove the macOS files from the
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

The app downloads available updates. On Windows and macOS it installs them on quit.
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
add the missing value or clear the key. A dry run uploads nothing. It only
installs the CLI and runs `posthog-cli --version`, so a CLI that cannot install
fails the dry run before it can fail a release.

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

The Linux job also checks that a workspace survives an engine upgrade, because any nightly can add an engine migration.
It extracts the engine from the newest published nightly's AppImage.
That engine captures a test workspace with an edited Markdown file, a binary file, a nested folder, and a non-ASCII file name.
The packaged engine then opens the same workspace.
The check fails when a file's hash or latest moment changes, a recorded moment or its content disappears or changes, bytes on disk change, or a new edit is not captured.
It covers the engine store and workspace files, not app settings or the desktop profile.
It runs only on Linux, dry runs included.
It fails when the newest published nightly has no AppImage or no executable engine.
It skips with a notice when no nightly is published, or when the newest one predates the packaged engine.
Those nightlies are listed in `scripts/select-upgrade-nightly.mjs`.
To repeat a failure locally, set `DOHC_UPGRADE_PREVIOUS_ENGINE` to the older engine and run `pnpm --filter @dohc/desktop exec vitest run src/workspaces/engineUpgrade.e2e.test.ts`.

The workflow's checks do not prove code signing, OS installer registration, update
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
