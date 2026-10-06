import { reactionStore } from "../workbench/reactionStore";
export async function readWithOwner(desktop: any) { reactionStore(); return desktop.read({}); }
