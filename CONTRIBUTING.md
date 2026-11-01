# Contributing to dohc

dohc is still in development and has one maintainer. Contributions are limited for now.

## What we're accepting

- Small bug fixes, with a test that fails before the fix and passes afterward.
- Small reliability or performance fixes, with measurements that show the improvement.
- Documentation corrections.

We're not accepting pull requests for new features, large changes, refactors, rewrites, new dependencies, or new tooling.

For feature ideas, read [what dohc is trying to build](AGENTS.md#what-dohc-looks-like-in-practice), then start a [Discussion](https://github.com/dohchq/dohc/discussions) before writing code.

## Report a bug

Use [GitHub Issues](https://github.com/dohchq/dohc/issues) for bugs only. Include reproduction steps, expected and actual results, your operating system, and the dohc version or commit.

For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Submit a pull request

Read [AGENTS.md](AGENTS.md) for product boundaries and development rules. Follow the [setup and verification guide](docs/engineering/verify-agent-work.md).

Cloud CI is disabled by default. A maintainer verifies fork PRs locally before merging.
Enabling Blacksmith adds automatic checks for ready branches in this repository; it does not enable checks for forks.

- Keep each pull request focused on one change. Explain the problem and the fix.
- Add a test for any behavior change. Tests must wait for the expected condition, not a fixed delay.
- Run the relevant checks and include their commands and results.
- For UI changes, include before and after screenshots. Include a short video if motion or interaction changes.

For Rust changes, follow the [Rust verification instructions](.agents/skills/rust-gate/SKILL.md) instead of running Cargo directly. All required checks must pass before a pull request can merge.

The maintainer cannot promise to review or accept every submission. Large pull requests may be closed without review.

Agent-written contributions follow the same rules. Name the model or agent used. You are responsible for understanding and checking every change.

## Contributor license agreement

Each contributor must accept the [CLA](CLA.md) before merging. You keep ownership and allow the project owner to relicense your contributions, including commercially. Existing license grants remain valid under their terms.

CLA Assistant handles signing. When you open your first pull request, it comments with a link to the agreement. Open the link and sign with your GitHub account. If you sign for a legal entity, name the entity in the form before you sign. Signing for an entity confirms that you're authorized to sign for it. The pull request's CLA check passes once you've signed. You sign each version of the agreement once. If the agreement changes, CLA Assistant asks you to sign again on your next pull request.

If your employer has rights to your contribution, check section 4 of the agreement before submitting it.
