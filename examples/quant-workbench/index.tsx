import { createRoot } from "react-dom/client";
import { AppProvider } from "dohc/app";
import { Workbench } from "./workbench";
import "./theme.css";

createRoot(document.getElementById("root")!).render(
  <AppProvider>
    <Workbench />
  </AppProvider>,
);
