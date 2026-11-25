import { createRoot } from "react-dom/client";
import { AppProvider } from "dohc/app";
import { Lock } from "dohc/icons";
import { Reports } from "./shared";
import "./books.css";

function Portal() {
  return (
    <div className="b-portal">
      <Reports
        heading={<h1>Accountant portal</h1>}
        badge={
          <span className="b-pill b-pill-quiet">
            <Lock size={12} aria-hidden />
            Read only
          </span>
        }
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppProvider>
    <Portal />
  </AppProvider>,
);
