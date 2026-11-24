import { createRoot } from "react-dom/client";
import { AppProvider } from "dohc/app";
import { AppShell, PageHeader } from "dohc/ui";
import { RefreshProvider, Reports } from "./shared";
import "./books.css";

function Portal() {
  return (
    <AppShell width="wide">
      <div className="books-no-print">
        <PageHeader
          eyebrow="Read-only link"
          title="Accountant portal"
          subtitle="Reports from these books. This link can read reports and cannot change anything."
        />
      </div>
      <Reports bookName="Books shared for review" />
    </AppShell>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppProvider>
    <RefreshProvider>
      <Portal />
    </RefreshProvider>
  </AppProvider>,
);
