# Workspace file versions

For people and agents editing workspace files, these formats use `version: 1`:

| File | Version syntax | Purpose |
| --- | --- | --- |
| `app.publish.json` | `"version": 1` | App source inputs and data bindings |
| `collection.yaml` | `version: 1` | Collection fields and views |
| `dohc.json` | `"version": 1` | App preview and build settings |
| `.dohc/files.toml` | `version = 1` | File tracking and search rules |

Put the version at the root of each document, before any TOML table headers.
dohc treats a missing version as 1. Generated app and Collection files include the version.
`files.toml` is hand-authored.
A newer version stops that file from applying and names the file with an instruction to update dohc.
An invalid version also stops the file from applying. No migration is needed for unversioned development files.

`app.publish.json` accepts only `version`, `entryPath`, `inputs`, `packageMap`, `collection`, and `dataset`.
It accepts at most one `collection` or `dataset` binding. Retired `backend` declarations remain invalid.
Unknown Collection properties still prevent schema rewrites. An unsupported Collection version prevents record binding and adoption.
Record sync continues. Agent reads name `collection.yaml` and ask for an update; relay refusals ask to update the sync service.
Unreadable and newer file policies hold policy-dependent capture. Malformed policies use the engine's baseline capture rules.
Each of these policy failures stops file search.

In `dohc-settings.json` and `.dohc/settings.local.json`, an unknown key leaves the other settings in effect.
One Notices row names the file and ignored keys. Saves preserve those keys and their values.
Use **Try again** after fixing the file. Dismissing the toast keeps its Notices row.
