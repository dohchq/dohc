# t3-code

Wraps the published [`t3`](https://www.npmjs.com/package/t3) coding agent
server (MIT) as a dohc plugin. Installing the plugin installs the pinned
`t3@0.0.33` from its committed lockfile. Opening **T3 Code** from the plugin
settings starts one t3 server per workspace and shows its web UI in a
hardened app view with its own storage, separate from dohc's own windows.

## How it runs

- The server is spawned through dohc's plugin child-process broker from the
  installed dependency's own `dist/bin.mjs` — never a `t3` found on PATH.
- It binds `127.0.0.1` on a fresh port, with the workspace root as its
  working directory and provider-session target.
- Its state — sessions, settings, logs, secrets, its SQLite database — lives
  in the plugin's data directory beside dohc's own app data, never inside the
  workspace. One exception, from t3 itself: t3 writes its checkpoint refs
  (`refs/t3/checkpoints`) into the workspace's git repository.
- The plugin becomes ready only when `GET /.well-known/t3/environment`
  answers with exactly version `0.0.33`. A different version stops the
  process and reports a plugin integrity error.
- Telemetry is off: the server is spawned with
  `T3CODE_TELEMETRY_ENABLED=false`.

## Trust notes

dohc plugins run with full trust, and t3 is a coding agent: it reads and
writes your workspace and runs the provider CLIs (codex, claude) installed on
your machine.

Two behaviors belong to t3's own UI, and dohc does not trigger or hide them:

- t3 offers **provider CLI updates** inside its interface. Accepting one
  updates that CLI globally on your machine, not just for this plugin.
- dohc never installs the t3 background service and never calls t3's
  self-update operations. The plugin runs only the pinned package.

## Uninstall

Uninstalling deletes the plugin's data directory: every t3 session,
setting, log, and secret stored for this workspace. That data is not part of
the workspace and dohc history holds no copy, so the uninstall dialog names
it as permanently deleted.

## Skipped dependency scripts

dohc installs plugin dependencies with lifecycle scripts disabled. The
packages below declare hooks that were verified unnecessary for this plugin,
so the manifest's `allowSkippedScripts` lists them:

| Package | Skipped hook(s) | Why skipping is safe |
| --- | --- | --- |
| `node-pty` | `install`, `postinstall`, `prepare` | Ships prebuilt binaries per platform (`prebuilds/`); its install script only checks they exist. The runtime loads them directly. |
| `msgpackr-extract` | `install` | `node-gyp-build-optional-packages` locates the platform package (`@msgpackr-extract/*`) at runtime; the installed tree already contains it. |
| `msgpackr` | `prepare` | Repository build step; the registry tarball ships `dist/`. |
| `content-type`, `path-to-regexp` | `prepare` | `ts-scripts install && npm run build` — repository tooling; tarballs ship built output. |
| `eventsource`, `standardwebhooks` | `prepare` | `npm run build` / `yarn run build` — tarballs ship built output. |
| `express-rate-limit`, `undici`, `uuid`, `ip-address` | `prepare` | Husky/lefthook git-hook setup and repository builds; not needed by an installed copy. |
| `regex-utilities` | `prepare` | Runs the package's own tests; not needed by an installed copy. |

Verified against a real isolated install of this lockfile on 2026-08-15: the
server starts, serves its UI, and answers readiness with scripts skipped.

## Icon

`icon.svg` is the T3 Code project's own logo, copied unchanged from
[`assets/prod/logo.svg`](https://github.com/pingdotgg/t3code/blob/6bc6cb6be4ebecd5bd7a3b7b88f07cb61815ded5/assets/prod/logo.svg)
at commit `6bc6cb6be4ebecd5bd7a3b7b88f07cb61815ded5`. The repository is MIT
licensed. It marks which upstream project this plugin wraps; it does not
imply the project endorses the plugin.
