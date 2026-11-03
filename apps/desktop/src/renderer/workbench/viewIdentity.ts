import {
  Files,
  History,
  MessageCircle,
  Search,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { ViewId } from "./workbenchState";

// What the rail, the panel header, Settings and the palette call each of
// dohc's own views. The side-panel registry's records carry these too.
export interface ViewIdentity {
  label: string;
  Icon: LucideIcon;
}

export const VIEW_IDENTITY: Readonly<Record<ViewId, ViewIdentity>> = {
  explorer: { label: "Explorer", Icon: Files },
  chats: { label: "Chats", Icon: MessageCircle },
  search: { label: "Search", Icon: Search },
  graph: { label: "Graph", Icon: Workflow },
  history: { label: "History", Icon: History },
};
