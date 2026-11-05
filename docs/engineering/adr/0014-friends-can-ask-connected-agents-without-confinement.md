---
status: accepted
---

# A friend can ask your connected agent, and dohc doesn't confine that request

When someone else asks your agent in a shared chat, dohc asks you first, and a run you allow reaches only what the asker can reach. dohc can enforce that limit for an agent it starts, because it controls the run's tools, setup and token. It can't for a connected agent such as an always-on cloud orchestrator. That agent has its own tools and the reach of its personal agent link. We still let a friend ask a connected agent through the same Allow, Always allow and Decline answers, because asking each other's agents is the core of the shared-work loop. Allow passes the friend's message to the agent and says plainly: "<agent> runs outside dohc. dohc can't limit what it does for <person>." Always allow is offered only after the owner has seen that warning for that agent.

## Considered options

- **Only the owner can ask a connected agent.** Honest and simple, but friends can't ask each other's agents directly, which is the scenario this work starts from.
- **Give the request a token limited to the friend's reach.** Rejected. The agent can still use its own personal agent link, so the limit would look real without being real. AGENTS.md rules out bluffing about isolation.

## Consequences

- dohc's confinement promise covers only agents dohc starts. Interface copy and docs must never claim more for a connected agent.
- If dohc later gets a way to confine a connected agent, such as a per-request link it can verify the agent uses exclusively, revisit this decision.
