# Sites

Finds the sites in a dohc workspace and previews them.

This is dohc's own worked example of an app plugin: a view in the activity bar,
a tab per thing it shows, servers it starts and dohc supervises. It is the
first conversion of a dohc feature into a plugin, and it takes no path through
core that a plugin of your own could not take.

## What it does

- Lists every site the workspace holds, in the activity bar.
- Opens one preview tab per site, over a loopback origin this plugin serves.
- Serves a static site itself; runs a site's own dev or build command through
  dohc's broker, which owns the process tree and stops it with the plugin.
- Remembers the mode each site last opened in.
- Opens a site's own page as a dohc file.

## How it is put together

| Path | What it is |
| --- | --- |
| `src/main.ts` | The Node half: starts and stops one preview per tab. |
| `src/staticServer.ts` | The loopback server a preview is served on. |
| `src/command.ts` | A site's dev and build commands, and what they may not do. |
| `ui/index.html`, `ui/index.js` | The list, which is the activity-bar view. |
| `ui/dohc.js` | The SDK's postMessage protocol, spelled out. |
| `ui/sites.js` | Detection, shared by both halves. |

Detection lives beside the panel because dohc serves a panel its own directory
and nothing above it, so a module the panel imports has to sit next to the
panel's page. The Node half imports the same file: the list a user sees and
the preview dohc starts read one implementation.

The panel spells out the SDK's postMessage protocol instead of importing
`@dohc/sdk`. A panel is static files with no bundler, so it cannot resolve the
package by name. The plugin has no dependencies.

## The two halves, and the one thing that crosses between them

A panel and its plugin's process do not talk. The panel opens a tab with
`ui.openWebApp(webAppId, instanceKey)`, dohc hands that key back to the
plugin's `startWebApp`, and the key is the whole channel. So it carries both
things the Node half needs to know: `"<mode>:<root>"`.

`auto:` means "the mode this site last opened in, then the setting, then a
guess". Naming a mode outright opens that mode in its own tab, next to the one
already open — which is how you compare a dev server against what a build
produces.

## Modes

- **static** — this plugin serves the site's own directory.
- **dev** — the site's dev or start script, through dohc's broker.
- **build** — the site's build script, then its output, served here.

A build can take longer than dohc allows a web app to start, so a build's tab
opens right away on this plugin's own origin, showing the build's output, and
becomes the site when the build lands. A build that fails says so on that same
page, with its last output.

A site under `shared-with-me/` is served and never run: a share mount holds
another person's code.

A dev command that binds past loopback is refused, by name — a preview is for
the person who opened it, not for every network the machine is on.

## What it cannot do yet

- **Push refresh.** dohc serves `files.watch` to a plugin's own process, and
  the list lives in a panel, which cannot subscribe. The list reads the
  workspace when it opens and when you ask it to.
- **Open a preview in a browser.** dohc has no external-open route a plugin
  can reach.
- **Serve a site inside a read-only workspace**, because no plugin runs in one.
- **Give the previewed site its own dohc SDK.** A site in a plugin's tab gets
  no bridge at all: handing it this plugin's bridge would hand sandboxed site
  code full-trust authority.
