# Tool-use eval

This eval runs a real agent against the desktop MCP server and checks which tools it calls. Run it before you change what a model reads: a tool's name, description, input schema, or result.

A unit test cannot check this. The same text can lead a model to the right tool one day and the wrong one after a small edit.

## What a sample is

Each sample starts Claude Code in a temporary copy of the case's workspace, with only the dohc MCP server connected.

- The server is `createDohcMcpServer` from this checkout, so the agent reads the tool list this checkout advertises.
- A stand-in answers for the dohc app (`desktop.ts`). Document and file writes change the temporary workspace. Every other request gets the answer the case lists.
- Claude Code runs with `--restricted` and `--strict-mcp-config`. Your own settings, instructions, plugins, and MCP servers stay out of the run. The agent has `Read`, `Glob`, `Grep`, `Edit`, and `Write` inside the temporary folder, and no shell.
- The run uses the Claude Code sign-in on your machine. It needs no API key. A sample drops every `ANTHROPIC_`, `CLAUDE`, and `T3CODE_` environment variable, so a run started from inside another agent session does not inherit that session's model route or effort.

The grader (`grade.ts`) is plain logic. It checks the calls, the final answer, and the workspace's files against the case. No model judges a result.

## Run

From `packages/mcp`:

```sh
pnpm eval --context
pnpm eval --dry-run
pnpm eval --case <id> --samples 1 --out ../../.agent-artifacts/evals/check
pnpm eval --model claude-haiku-5-5 --out ../../.agent-artifacts/evals/haiku
```

- `--out <folder>` is required for a run. It gets `results.jsonl` and `summary.md`. Keep runs under `.agent-artifacts/`, which git ignores.
- `--model <id>` picks the model. The default is `claude-sonnet-5-5`.
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

- The stand-in for the dohc app models document and file writes on plain files. It has no live editing, sync, permissions, or History.
- The eval measures which tools an agent chooses and how it recovers from a refusal. It does not prove the work is right in the dohc app.
- It runs Claude Code only. Codex is not covered yet: its command-line run loads the MCP servers in the person's own config, and an eval must not reach those.
