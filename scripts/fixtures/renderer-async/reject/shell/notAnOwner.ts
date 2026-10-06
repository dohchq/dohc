import { bridge } from "../bridge";
export function useSomething() { return bridge().readPage({}); }
