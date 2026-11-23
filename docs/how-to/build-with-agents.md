# Build with agents in dohc

People use this guide to connect Claude Code, Codex, OpenClaw, or another agent to a dohc workspace and give it the public `dohc` Agent Skill.

## Connect your agent to a workspace

1. Open your workspace in the dohc desktop app and keep dohc open.
2. Open **Settings**, then **Agents**.
3. Select **Add agent**, choose **Another agent**, and copy the **MCP config** into your agent tool's MCP configuration.
4. Keep the `--agent-id <id>` flag in the config so History records changes under that agent's name and chat mentions reach that agent.

Agents that run inside a terminal in the workspace folder can also run `dohc` CLI commands directly while dohc is open.

## Install the public dohc Agent Skill

The repository ships a task-oriented public skill at [`skills/dohc/SKILL.md`](../../skills/dohc/SKILL.md) with compact references for Collections, apps, and automations:

- **Claude Code / Codex / OpenClaw**: Copy `skills/dohc/` into your agent's skills folder (such as `~/.claude/skills/dohc` or `~/.codex/skills/dohc`) or install it with your agent's skill loader.
- **Any LLM or web agent**: Point it at `https://dohc.computer/llms.txt` or [`skills/dohc/SKILL.md`](../../skills/dohc/SKILL.md).

## Start with the core building tools

The desktop MCP server exposes over 75 tools, including sync recovery, live-document quarantine, and sharing administration. Most everyday work uses these core tools:

- **Recall, files, and notes**: `dohc_search_workspace`, `dohc_list_files`, `dohc_read_file`, `dohc_search_files`, `dohc_write_file`, `dohc_create_document`, `dohc_read_document`, `dohc_edit_document`
- **Collections and data**: `dohc_query_collection`, `dohc_create_record`, `dohc_set_record_fields`, `dohc_dataset`, `dohc_import_data`, `dohc_query_database`
- **Apps**: `dohc_create_app`, `dohc_test_app`, `dohc_publish_app`
- **Automations, chat, and versions**: `dohc_list_automations`, `dohc_switch_automation`, `dohc_list_groups`, `dohc_start_group_chat`, `dohc_start_file_chat`, `dohc_reply_to_chat`, `dohc_create_version`, `dohc_compare_version`, `dohc_merge_version`

See the [CLI, MCP, and app channel reference](../reference/cli-mcp-sdk.md) for the complete grouped list of tools and commands, and [Build an app connected to a Collection](app-backend.md) for a walkthrough of Collection-backed apps and forms.
