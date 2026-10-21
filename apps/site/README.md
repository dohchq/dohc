# dohc marketing site

The dohc marketing site is mostly plain HTML and CSS, with one deliberately
real product surface: the interactive demo mounts the desktop app's actual
WYSIWYG editor inside an isolated shadow root. The editor, its menus, and its
document styling therefore stay in sync with `apps/desktop`.

## Run locally

Install from the repository root, then run the Vite site:

```bash
pnpm install
pnpm --filter @dohc/site dev
```

## Deploy

The site is a Cloudflare Worker, `dohc-site`, that serves `dist` as static
files (`wrangler.jsonc`). The [Site deploy workflow](../../.github/workflows/site-deploy.yml)
tests, builds and deploys it after a change on `main` reaches the site, the
desktop source its demo imports, or a shared package.

The workflow runs only while the repository variable `SITE_DEPLOY_ENABLED` is
`true`. A build job without secrets tests and builds the site. A deploy job
receives only the built files and runs wrangler, with the commit's
`wrangler.jsonc`, using `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` from the `site` environment. The token needs Workers
Scripts: Edit on the dohc account, which can change every Worker in that
account.

Anyone with write access can push a workflow on another branch, so only the
`site` environment keeps the token from it. The environment must allow
deployments from `main` alone, and both values must be environment secrets,
never repository secrets. A merge to `main` deploys, so `main` must stay
protected. `SITE_DEPLOY_ENABLED` turns deploys on and off; it protects nothing.

Set `SITE_DEPLOY_ENABLED` only once this workflow runs on runners that start
fresh for each job, such as GitHub's hosted runners. A persistent runner also
runs pull requests' checks, and what they leave behind can reach the deploy
job.

To deploy by hand, run `pnpm --filter @dohc/site build`, then run
`pnpm dlx wrangler@<version> deploy` from `apps/site` with the version the
workflow pins.

## Design

Brand tokens mirror `packages/brand/src/tokens.css` (warm paper +
graphite, almost monochrome). Fonts are bundled from Fontsource packages,
with no external font requests. `styles.css` embeds `Inter`,
`Source Serif 4`, and the handwriting face `Homemade Apple`. The demo
loads `Inter` and `IBM Plex Mono` in `src/main.tsx` when it mounts.
