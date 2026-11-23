# Tool-use eval

This eval runs a real agent against the desktop MCP server and checks which tools it calls. Run it before you change what a model reads: a tool's name, description, input schema, or result.

A unit test cannot check this. The same text can lead a model to the right tool one day and the wrong one after a small edit.

## What a sample is

Each sample starts Claude Code or Codex CLI in a temporary copy of the case's workspace, with only the dohc MCP server connected.

- The server is `createDohcMcpServer` from this checkout, so the agent reads the tool list this checkout advertises.
- For `tool-use` cases, a stand-in answers for the dohc app (`desktop.ts`): document and file writes change the temporary workspace, and every other request gets the answer the case lists.
- For `everyday` cases (`everydayDesktop.ts`, `everydayCases.ts`), a stateful stand-in validates real Collection definitions, app publication manifests, and `automations.yaml` files and executes SQLite schemas and sandboxed operation code.
- Claude Code (`--harness claude`, default) runs with `--restricted` and `--strict-mcp-config`. Your own settings, instructions, plugins, and MCP servers stay out of the run. The agent has `Read`, `Glob`, `Grep`, `Edit`, and `Write` inside the temporary folder, and no shell.
- Codex CLI (`--harness codex`) runs with `--ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --json --approve-for-me` and `sandbox_mode="workspace-write"`, injecting only the dohc stdio MCP server via `-c mcp_servers.dohc.*`. Your personal `~/.codex/config.toml` and other MCP servers never load.
- Claude Code enforces its sandbox, not this eval. With Claude Code 2.1.322 on Windows, a sample asked to read, write, and edit a file beside its workspace was refused each time, and the file was unchanged. A test keeps the flags on every sample. Check the limit again when you move to a Claude Code version that changes `--restricted`.
- The run uses the Claude Code or Codex CLI sign-in on your machine. It needs no API key. A Claude sample drops every `ANTHROPIC_`, `CLAUDE`, and `T3CODE_` environment variable, so a run started from inside another agent session does not inherit that session's model route or effort.

The grader (`grade.ts`) is plain logic. It checks the calls, the final answer, and the workspace's files against the case. No model judges a result.

## Run

From `packages/mcp`:

```sh
pnpm eval --context
pnpm eval --dry-run
pnpm eval --suite everyday --harness codex --samples 1 --out ../../.agent-artifacts/evals/everyday-baseline
pnpm eval --suite everyday --harness codex --skill ../../skills/dohc/SKILL.md --baseline ../../.agent-artifacts/evals/everyday-baseline/results.jsonl --out ../../.agent-artifacts/evals/everyday-with-skill
pnpm eval --case <id> --samples 1 --out ../../.agent-artifacts/evals/check
pnpm eval --model claude-haiku-5-5 --out ../../.agent-artifacts/evals/haiku
```

- `--out <folder>` is required for a run. It gets `results.jsonl` and `summary.md`. Keep runs under `.agent-artifacts/`, which git ignores.
- `--harness <claude|codex>` selects Claude Code (default) or Codex CLI.
- `--suite <tool-use|everyday|all>` picks the case suite. Default is `tool-use`.
- `--skill <path>` injects a `SKILL.md` file (and sibling `references/*.md` files) into the run's agent prompt for before/after comparisons.
- `--model <id>` picks the model. Defaults to `claude-sonnet-5-5` for Claude and `gpt-6.2-sol` for Codex.
- `--case <ids>` runs only those cases, separated by commas.
- `--samples <n>` sets samples per case. The default is 2, and a third runs when the first two disagree.
- `--concurrency <n>` sets how many cases run at once. The default is 2.
- `--baseline <results.jsonl>` compares with an earlier run. The command exits with status 1 when a case that passed every baseline sample now fails.
- `--keep-session-route` keeps those environment variables. Use it when your sign-in goes through a proxy that the enclosing session sets up. A proxy can rename tools on the way to the model, so compare such a run only with runs made the same way. The summary marks them.
- `--context` prints the size of the tool list and calls no model.
- `--dry-run` prints each sample's command and calls no model.

A misspelled flag, a flag without its value, or a count below 1 stops the run before it starts.

A case passes when more than half of its graded samples pass. A sample that cannot be graded is an error: the harness failed, or the case lists no answer for a request the agent made. Errors are listed and left out of every pass count.

## What a run uses

Every sample sends the whole tool list, so a sample uses about 150,000 input tokens on a short task. The summary reports the tokens and what they would cost at API prices. A run on a subscription uses plan quota and is not billed that amount.

Run the cases your change touches first. Run every case once your change passes them.

## Change model-facing text

1. Add a case that fails on the text as it is. Run it to see it fail.
2. Change the text.
3. Run the case again, then every case with `--baseline` set to a run from before your change.
4. Put both summaries in the pull request.

Compare runs on the same model. A pass rate means little alone, because a model's output varies from run to run.

## Add a case

Cases are in `cases.ts`. `case.ts` describes every field.

- A case reproduces a real mistake (`bad`), protects behavior that works (`guard`), or is ordinary work that needs no dohc tool (`control`). Controls catch a fix that makes agents reach for dohc tools too often.
- `experience` says what happened in a sentence, and `source` names the pull request, issue, or commit.
- `files` is the workspace. `desktop` lists what the dohc app answers, by request verb.
- `expect` lists the checks. Name a dohc tool without its server prefix, such as `dohc_edit_document`.
- Use made-up names and data. Put no person's data in a case.

## Limits

- The stand-in for `tool-use` cases models document and file writes on plain files and has no live editing, sync, permissions, or History. The stand-in for `everyday` cases executes real Collection contracts, SQLite schemas, and sandboxed operations, but still omits real desktop sync, relay, and OS UI flows.
- The eval measures how an agent chooses tools, writes valid workspace files, and recovers from refusals. It does not replace desktop QA.
