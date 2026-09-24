# An automation reaches only what all its editors share

Status: accepted September 24, 2026. It adds to ADR 0008, which still decides where an automation runs.

An automation belongs to its Collection, so anyone who can edit the Collection can edit its automations, as Notion lets anyone with full access edit a database's automations. An automation can therefore reach only what every one of those editors can reach. Nobody gains access by writing or changing one, so there is no approval step. A step that needs one person's own reach, such as waking that person's agent or changing a Collection only that person can edit, is a personal step. It shows its person, only that person can change it, and at launch it is allowed only in a Collection that only that person can edit.

ADR 0008 still decides where an automation runs: on the computer where the triggering change happened, so a button runs on the computer of the person who clicks it. A schedule has no triggering change. It runs on the workspace owner's main computer, or on the owner's server when there is one, and the owner can choose another computer in Advanced settings. A message in a Group runs the same way: the owner's main computer claims each message in the Group exactly once when it applies the message, whoever wrote it, so a member who cannot edit the Collection can still trigger it. No other computer claims Group messages.

## Considered options

- Run with the workspace owner's access on the owner's computer, and have the owner approve every collaborator's automation. Approvals block collaborators, and buttons wait for the owner's computer.
- Trust anyone with Edit and run with the owner's access without approval. Edit on one folder then becomes the owner's full access, including the owner's agent.
- Have each automation act as the person who last saved it. Editing someone else's automation then transfers it and needs a warning, and each person must choose which of their computers runs their automations.

## Consequences

- The owner's computer holds more than any collaborator can reach. Its executor checks every step's target against the common reach of the automation's editors. A collaborator's computer holds only what was shared with them.
- Sharing a Collection can narrow what its automations reach. Steps outside the new reach stop with a notice, and so do personal steps once another person gains Edit on the Collection. The share dialog warns before this happens.
- A missed schedule is skipped, and the owner gets a notice asking whether to run it.
- Removing an editor can widen what an automation reaches, and a step that person wrote could then do what they never could by hand. So when a step's verdict changes from stopped to allowed while its definition stays the same, the step waits until a current editor confirms it. Removing someone never switches on what they wrote.
