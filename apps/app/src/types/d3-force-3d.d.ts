// d3-force-3d ships no type declarations and there is no @types package for
// it, so a bare `import` from it fails `tsc --noEmit` under strict mode
// (TS7016). force-graph (which GraphView uses) depends on it transitively;
// we import only `forceCollide` to register the graph's non-overlap force.
// This ambient shim types just that one export — enough for type-safe call
// sites without pulling in an untyped `any`.
declare module 'd3-force-3d' {
  export interface ForceCollide<NodeDatum> {
    (alpha: number): void
    initialize(nodes: NodeDatum[], ...args: unknown[]): void
    radius(): (node: NodeDatum, i: number, nodes: NodeDatum[]) => number
    radius(
      radius: number | ((node: NodeDatum, i: number, nodes: NodeDatum[]) => number),
    ): this
    strength(): number
    strength(strength: number): this
    iterations(): number
    iterations(iterations: number): this
  }

  export function forceCollide<NodeDatum>(
    radius?: number | ((node: NodeDatum, i: number, nodes: NodeDatum[]) => number),
  ): ForceCollide<NodeDatum>
}
