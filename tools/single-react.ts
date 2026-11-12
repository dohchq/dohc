// A page gets one React and one React DOM. With a second React, hooks called
// through it find no dispatcher and the component never renders (#3730).
// This fails the build instead, naming the chunks that carry each copy.
// It takes no Vite types, so Vite 7 (desktop) and Vite 8 (share page) both use it.
const reactModule = /[\\/]node_modules[\\/](react|react-dom)[\\/]cjs[\\/]\1\.(?:production|development)\.js$/u;

interface BuiltFile {
  type: string;
  fileName: string;
  moduleIds?: readonly string[];
}

export function singleReact() {
  return {
    name: "single-react",
    generateBundle(this: { error(message: string): never }, _options: unknown, bundle: Record<string, BuiltFile>) {
      const copies = new Map<string, string[]>([["react", []], ["react-dom", []]]);
      for (const file of Object.values(bundle)) {
        for (const id of file.type === "chunk" ? (file.moduleIds ?? []) : []) {
          const name = reactModule.exec(id)?.[1];
          if (name) copies.get(name)?.push(`${file.fileName} (${id})`);
        }
      }
      const problems = [...copies].flatMap(([name, found]) =>
        found.length === 1
          ? []
          : found.length === 0
            ? [`found no ${name} module; update the pattern in tools/single-react.ts`]
            : [`${name} is bundled ${found.length} times:\n  ${found.join("\n  ")}`],
      );
      if (problems.length > 0) this.error(`This build must carry exactly one React and one React DOM (#3730):\n${problems.join("\n")}`);
    },
  };
}
