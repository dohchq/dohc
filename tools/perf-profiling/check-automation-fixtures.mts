// Checks the automation benchmark's fixtures against the product's own contracts: automations.yaml for
// both Collection kinds, the document Collection's schema, and the generated dataset definition. Prints
// one JSON line: every problem found, or an empty list.
import { automationCases, automationsYaml, datasetAutomationDefinition, documentAutomationFiles, DEFAULT_LIMITS } from './packaged-collection-automations.mjs';
import { parseAutomationsFile } from '../../packages/workspace-contracts/src/automations';
import { parseCollectionSchema } from '../../packages/workspace-contracts/src/collectionValues';
import { unsupportedReason } from '../../packages/automation-executor/src/automationPlan';
import { datasetAutomationProblem } from '../../packages/automation-executor/src/datasetAutomationPlan';
import { generateDatasetSources } from '../../apps/desktop/src/workspaces/datasetGenerator';

const cases = automationCases(DEFAULT_LIMITS);
const problems: unknown[] = [];
const { definition } = generateDatasetSources(datasetAutomationDefinition(cases));
for (const kind of ["document", "dataset"] as const) {
  const parsed = parseAutomationsFile(automationsYaml(cases, kind));
  if (parsed.status !== "read") { problems.push({ kind, file: parsed.diagnostic }); continue; }
  if (parsed.entries.length !== cases.length) problems.push({ kind, entries: parsed.entries.length });
  for (const entry of parsed.entries) {
    if (entry.status === "invalid") { problems.push({ kind, id: entry.id, diagnostics: entry.diagnostics }); continue; }
    const problem = kind === "document" ? unsupportedReason(entry.automation) : datasetAutomationProblem(entry.automation, { definition, generated: true });
    if (problem !== null) problems.push({ kind, id: entry.automation.id, problem });
  }
}
const schema = parseCollectionSchema(documentAutomationFiles(cases)[0]!.content);
if (schema.status !== "valid") problems.push({ schema: schema.reasons });
console.log(JSON.stringify({ problems }));
