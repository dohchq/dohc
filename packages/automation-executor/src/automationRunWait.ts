/** A temporary dependency failure releases the claim without failing its saved run. */
export class AutomationRunWait extends Error {
  constructor(message: string, readonly reason: "engine" | "roster" | "held" | "moved" = "engine") { super(message); }
}
