export interface AppSourceOptions {
  title: string;
  appRoot?: string;
  withDohcJson?: boolean;
}

export interface AppSourceFile {
  path: string;
  content: string;
}

export function generateAppSource({ title }: AppSourceOptions): AppSourceFile[] {
  return [
    {
      path: "app.publish.json",
      content: `${JSON.stringify({ version: 1, entryPath: "src/App.tsx" }, null, 2)}\n`,
    },
    {
      path: "src/App.tsx",
      content: `import { createRoot } from "react-dom/client";
import { AppShell, PageHeader } from "dohc/ui";

function App() {
  return (
    <AppShell>
      <PageHeader title={${JSON.stringify(title)}} />
    </AppShell>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
`,
    },
  ];
}

export function appTitleFromRoot(root: string): string {
  const name = root.split("/").pop() || "App";
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

export type NewAppFolder = "missing" | "file" | { entryCount: number };

export type NewAppPlan =
  | { ok: true; appRoot: string; files: AppSourceFile[] }
  | { ok: false; reason: string };

export function planNewApp(input: {
  appRoot: string;
  folder: NewAppFolder;
  title?: string | undefined;
}): NewAppPlan {
  const { appRoot, folder } = input;
  if (!appRoot) return { ok: false, reason: "appRoot must name a folder" };
  if (folder === "file") return { ok: false, reason: `appRoot is not a directory: ${appRoot}` };
  if (folder !== "missing" && folder.entryCount > 0) {
    return { ok: false, reason: `app folder already exists and is not empty: ${appRoot}` };
  }
  const title = input.title?.trim() || appTitleFromRoot(appRoot);
  return {
    ok: true,
    appRoot,
    files: generateAppSource({ title }).map((file) => ({
      ...file,
      path: `${appRoot}/${file.path}`,
    })),
  };
}
