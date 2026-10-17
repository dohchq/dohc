// Prints the desktop vitest projects as `vitest run --maxWorkers=1` resolves them.
import { relative } from "node:path";
import { createVitest, parseCLI } from "vitest/node";

const { options } = parseCLI("vitest run --maxWorkers=1");
const context = await createVitest("test", { ...options, config: "./vitest.config.ts", watch: false });
try {
  const specifications = await context.globTestSpecifications();
  console.log(JSON.stringify(context.projects.map((project) => ({
    name: project.name,
    maxWorkers: project.config.maxWorkers ?? context.config.maxWorkers,
    isolate: project.config.isolate,
    files: specifications
      .filter((specification) => specification.project === project)
      .map((specification) => relative(process.cwd(), specification.moduleId).replaceAll("\\", "/")),
  }))));
} finally {
  await context.close();
}
