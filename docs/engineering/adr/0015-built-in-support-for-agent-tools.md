---
status: accepted
---

# dohc has built-in support for some agent tools, and a command for the rest

This records a design that is built in part. Built, for T3 Code on one computer: a person picks a thread in Settings, and dohc gives it messages, in line or as a steer, reads its state, and answers its questions. Planned: Claude Code and Codex, which dohc still starts with a fixed profile and no knowledge of where the agent keeps its own conversation.

In the plan, dohc knows three tools by name: T3 Code, Claude Code, and Codex. For each it knows how to give a message to an agent thread in that tool. For T3 Code it also lists the person's threads, steers a busy thread, reads its state, and answers its questions. A person picks the tool and the thread in Settings, with no command to type. Every other tool uses "Your command", with a switch that says the agent keeps its own memory.

AGENTS.md says dohc is agent agnostic. It does not provide or supervise people's agents, and any agent that works with ordinary files must stay useful. Built-in support removes no other way to reach dohc. An agent in a tool dohc does not know still works through the CLI, MCP, and "Your command".

We chose built-in support because the setup must work for a person who cannot write a command. Connecting a thread is the first thing a person does with this feature, and a field that asks for a command stops most people there.

dohc reaches T3 Code through an interface T3 Code does not promise to keep. dohc reaches Claude Code and Codex through their command lines. Each can change under dohc.

## Considered options

- **A command for every tool.** One generic field, and a documented command for each tool. Rejected as the only way, because it puts a command between a person and their first connected agent. It stays as the fallback.
- **dohc hosts the agent.** dohc would run Claude Code through its SDK and Codex through its app-server, and would get steering, questions, and session lists from both. Rejected. dohc would answer the agent's approvals and own its session, which is the role #1231 and #1334 removed.
- **One shared protocol.** The Agent Client Protocol reaches Claude Code, Codex, and other agents through one client. Rejected for now. It also makes dohc the host, and steering is not yet part of its standard. dohc reaches every tool through one internal shape so this can replace the per-tool code later.

## Consequences

- Each built-in tool is code dohc must keep working as that tool changes. dohc checks what the tool offers when it connects, and says which version it last worked with when something it needs is gone.
- A tool gets built-in support when people ask for it. Until then its agents use "Your command".
- What people see must not depend on the tool beyond what the tool cannot do. A tool that cannot steer shows no steer setting.
- If a tool gives outside programs a supported way to message an open session, prefer it over starting the tool for each message.
- T3 Code's own page decides the sign-in, and it asks for two things. When the browser that opens it is not signed in to T3 Code, it asks for a sign-in code, which a person gets today from a terminal command. It also asks what the client may do, and dohc can message only a thread that runs with no more than that. A sign-in on November 13, 2026 took both. dohc must not ship a way to connect a T3 Code thread that needs a terminal.
