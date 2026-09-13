---
name: workspace-cleanup
description: Clean task-owned resources after completion, merge, or abandonment, or inventory development resources when asked to free disk space.
---

## Inspect resources

Account for task-owned processes, worktrees, temporary files, and build outputs before reporting completion.
Stop task-started processes by recorded PID after verifying their identity.
Preserve deliverables, uncommitted work, required evidence, shared caches, and resources another session needs.
Before deletion, verify active sessions, open PR branches, ignored evidence, and other users of each resource.
A missing recorded run does not prove inactivity. A merged commit does not prove the task finished.
Preserve ambiguous resources and record what evidence is missing.

## Reclaim disk space

Refresh the target ref, then run the read-only inventory from the repository root:

```powershell
node tools/cleanup-workspace.mjs --repo . --base origin/main --dry-run > "$env:TEMP/dohc-cleanup.json"
```

Add `--sizes` when build sizes will guide cleanup. Scanning large builds can take several minutes.
The inventory includes registered worktrees and their immediate `target` and `target-*` paths.
It continues after individual inspection failures. Preserve entries with inspection failures.
Its output is evidence for review, not authorization to delete.

## Remove verified resources

For worktree removal, use `node ~/dev/garage/tools/worktree.mjs --help` and its `finish` command.
Supply the existing receipt's owner and a refreshed base containing the worktree's commits.
The command rechecks Git state and takes an ownership lease.
Inspect its deletion plan before using `--apply`.
Keep required ignored reports and profiles outside the deletion target before removing the worktree.

Inspect standalone build targets separately. Confirm their producing task, resolved path, contents, and active use before deleting them.
Recheck those facts immediately before deleting each explicit path. Preserve links and paths outside the verified resource root.
Do not substitute broad recursive deletion or infer ownership from names or age.
After an approval rejection, report it and reassess the scope; do not retry the same deletion through another tool.

Verify each removal completed. Report removed resources and deferred cleanup, including each reason.
For disk cleanup, report actual free-space change separately from apparent file sizes.
Retain required cleanup evidence and remove task-owned inventory scratch files when they are no longer needed.
