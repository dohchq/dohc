# Social assets

Reader: whoever updates the GitHub organization avatar or the repository social preview.

Nothing in the codebase reads these files. The PNGs are uploaded by hand through GitHub's settings pages: the avatars for the organization profile, `dohc-social-banner.png` for the repository social preview. The marks are spares for third-party listings.

Each PNG renders from the HTML file beside it. To regenerate after a brand change, install Google Chrome, run `pnpm install` at the repository root, and run `_render.sh` from this directory. The banner takes its fonts and engine image from `apps/site`. It rasterizes every HTML file with headless Chrome at the sizes GitHub expects.
