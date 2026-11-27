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
