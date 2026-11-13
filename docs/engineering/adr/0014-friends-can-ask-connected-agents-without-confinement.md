---
status: accepted
---

# A friend can ask your connected agent, and dohc doesn't confine that request

This records a planned design. None of it is built yet. Today your own messages and your automations can wake your agents, and a friend naming your agent wakes nothing.

In the plan, another person's message makes a request when it mentions your agent or replies under its message. dohc forwards no other message of theirs. Only a message a person wrote can become a request. An agent's post never does. Nothing is forwarded until you answer Allow or Decline. The request shows the exact text of the message dohc will forward. Allow covers that one revision of that one message. An edit or a delete before you answer cancels the request, and a later message from the same person is a new request. The person who asked sees nothing until you allow. A request does not expire.

dohc does not limit what the agent does for the person who asked. dohc can build such a limit only where it controls the agent's tools, settings and credentials. It doesn't fully control them today. A Claude Code run keeps the owner's own Claude Code settings for actions outside the workspace, and a custom command runs with no launch profile. dohc can never control them for a connected agent, such as an always-on cloud orchestrator, which has its own tools and its own sign-in.

We still let a friend ask, because asking each other's agents is the core of the shared-work loop. Every request carries a warning in place of a limit. For a connected agent it says: "<agent> runs outside dohc. dohc can't limit what it does for <person>." For an agent dohc starts it names the computer: "<agent> runs on <computer> as you. dohc can't limit what it does for <person>."

A person can let named people ask without approval. That list lives on the agent's page, in a danger zone, and the request never offers it. An entry is one server account, never a name or an email. It applies in every chat the owner shares with that person, in every workspace the agent serves. Adding a person opens a danger confirmation. Turning on a workspace for an agent whose list has people opens a confirmation that names each listed person who will be able to ask the agent there. A listed person's message is forwarded only when it would have made a request.

A link holder can ask. Their name is unverified, so Allow opens a second confirmation that says so, and the agent is told the sender is an unverified link holder. A link holder can never be added to the list.

The server fixes who sent a message, and only the owner's signed-in account can answer a request.

[ADR 0016](0016-chat-forwards-to-an-agent-thread.md) records how dohc forwards a message to an agent.

## Considered options

- **Only the owner can ask a connected agent.** Honest and simple, but friends can't ask each other's agents directly, which is the scenario this work starts from.
- **Give the request a token limited to the friend's reach.** Rejected. The agent can still use its own sign-in, so the limit would look real without being real. AGENTS.md rules out bluffing about isolation.
- **Limit a run dohc starts to what the asker can reach.** Rejected for now. dohc doesn't fully control such a run's tools, settings and credentials, so the limit would cover part of what the run can do and read as covering all of it.
- **Offer Always allow in the request.** Rejected. Letting another person drive an agent with the owner's access, without asking, is a larger decision than answering one message. It belongs on the agent's page, behind a confirmation.

## Consequences

- Interface copy and docs must never claim that dohc limits what an agent does for another person. If dohc later controls a run's tools, settings and credentials, it may limit that run to what the asker can reach, and only then may it say so.
- Allow controls forwarding only. An agent that reads a chat with dohc's tools sees every message its owner can see, including one the owner has not allowed or has declined. Interface copy must not say that Decline keeps a message from the agent.
- If dohc later gets a way to confine a connected agent, such as a per-request link it can verify the agent uses exclusively, revisit this decision.
