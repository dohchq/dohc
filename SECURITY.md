# Security policy

## Report a vulnerability

[Report a vulnerability privately on GitHub](https://github.com/dohc-ai/dohc/security/advisories/new).

Do not report security vulnerabilities in public issues or pull requests. Keep details of how to exploit them out of commit messages and GitHub Discussions too.

Include:

- The affected part of dohc, such as the desktop app, a service, or a package.
- The version or commit you tested.
- Steps to reproduce the problem, with example code if useful.
- What an attacker could read, change, or do because of the problem.

## What to expect

dohc has one maintainer, who will acknowledge your report within seven days. This is a response deadline, not a promise to fix the problem within that time.

dohc does not pay bug bounties. Published security advisories credit reporters unless they ask to remain anonymous.

## What to report

This policy covers the desktop app, the services in `services/`, and all published dohc packages. Examples of security vulnerabilities include:

- Someone can read or change workspace content they do not have access to.
- An app, site, or HTML preview can access data or perform actions its owner did not allow.
- A server accepts a caller's claimed identity or access rights without verifying them.
- The secret in a share link leaks into logs, browser history, or cached data, or stays in the address bar after dohc accepts the link.
- A shared-content page or workspace app gains access reserved for another app or the desktop app.
- Someone keeps access after the owner revokes it or replaces the share link, including through an already-open session.

The project's [security requirements](AGENTS.md#product-invariants) describe these boundaries in more detail.

## What this policy does not cover

- Attacks that require an attacker to have already taken control of the device or operating-system account running dohc.
- Attacks that overwhelm a service with traffic. Bugs that let a caller bypass request limits or abuse controls are still reportable.
- Vulnerabilities in dependencies that an attacker cannot exploit through dohc. Report those to the dependency's maintainers.

## Supported versions

dohc is pre-launch. Only the latest release receives security fixes. If you run dohc services yourself, keep them on the latest release.
