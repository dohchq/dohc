import { createRoot } from "react-dom/client";
import React from "react";
import { Poll } from "./Poll.tsx";
import { connectCollection } from "./broker.ts";
import "./style.css";

const client = connectCollection();
const root = createRoot(document.getElementById("root")!);
root.render(<Poll client={client} />);
window.addEventListener("pagehide", () => { root.unmount(); client.close(); }, { once: true });
