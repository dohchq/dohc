---
name: codex-computer-use
description: "Ask Codex CLI (gpt-5.6-sol) to run local app verification that needs computer use: browser automation, simulators, screenshots, app launching, or independent runtime inspection. Use when the user asks Claude to test a flow, verify UI behavior, inspect a running app, capture screenshots, or report confirmation and feedback about implemented behavior that benefits from computer use functionality."
---

# Codex Computer Use

Use Codex as a separate local verification agent when the task needs real UI interaction, screenshots, simulator/browser/device state, or an independent runtime check outside Claude's current context.

Do not use this for ordinary code reading, typechecking, linting, or tests Claude can run directly. Launching apps, simulators, or browsers to verify the requested work is fine without asking; ask first only if the run could disrupt the user's environment beyond that, such as closing their apps, changing system settings, acting on real accounts, or modifying real data.

## Workflow

1. Define the exact runtime objective: app/site to open, flow to test, expected result, viewport/device if relevant, and evidence needed.
2. Pin current repo state with `git status --short` if the run is connected to local code changes.
3. Create a temporary artifact directory for screenshots, logs, and Codex's report.
4. Run `codex exec` with a prompt that explicitly asks Codex to use computer-use/browser/simulator capabilities.
5. Read the report and inspect any screenshots or logs before relaying conclusions.
6. If Codex reports a failure, decide whether it is a real product issue, an environment issue, or a task ambiguity before telling the user.

Use this command shape:

```bash
ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-computer-use.XXXXXX")"
REPORT="$ARTIFACT_DIR/report.md"
PROMPT="$ARTIFACT_DIR/prompt.md"

# Write a self-contained prompt to $PROMPT, then run:
codex exec \
  -C "$PWD" \
  --add-dir "$ARTIFACT_DIR" \
  -s danger-full-access \
  -o "$REPORT" \
  "$(cat "$PROMPT")"
```

Use `-s danger-full-access` for true computer-use tasks because app launch, browser control, screenshots, and simulator work often need machine-level access. Keep the prompt narrow and explicit.

## Prompt Requirements

Tell Codex:

- The app, URL, dev server, simulator, or desktop surface to use.
- The exact flow to perform and the expected observable outcome.
- What evidence to collect: screenshots, console logs, network notes, or a written runtime report.
- Where to save artifacts: the artifact directory path.
- Whether it may start or stop local dev servers.
- Whether credentials, real accounts, payments, messages, production data, or destructive actions are out of bounds.
- To stop and report if authentication, captcha, payment, system settings, or irreversible real-world actions are required.
- To return a concise report with steps performed, evidence paths, pass/fail result, and blockers.

## Example Prompt

```text
You are a local verification agent for Claude.

Repository: /absolute/path/to/repo
Artifact directory: /tmp/codex-computer-use.xxxxxx

Objective:
- Verify that the command palette keyboard navigation works in the local web app.

Setup:
- Use the existing dev server if one is running.
- If no dev server is running, start the repo's normal dev command and report the command used.

Flow:
- Open the app in a browser.
- Open the command palette.
- Press ArrowDown, ArrowUp, Enter, and Escape.
- Confirm the highlighted item moves, Enter selects it, Escape closes the palette, and mouse behavior still works.

Evidence:
- Save screenshots or logs to the artifact directory when useful.
- Include the final URL, viewport, browser, and pass/fail result.

Boundaries:
- Do not use real accounts, change production data, send messages, make purchases, or change system settings.
- Stop and report if authentication or captcha blocks the flow.
```

## Reporting Back

Before presenting Codex's conclusion, inspect the screenshots, logs, or report enough to decide whether the result supports the claim.

Separate confirmed product issues from environment problems. For example, "the button did not respond in Chrome at 1440px" is different from "the dev server failed to start."

If `codex` is not installed or the command fails, report the error and run the best direct verification available instead.
