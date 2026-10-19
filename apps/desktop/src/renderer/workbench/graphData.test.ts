import { describe, expect, it } from "vitest";
import { graphWalk } from "./graphData";

describe("graph walk accumulation", () => {
  it("keeps snapshots immutable, deduplicates degrees and enriches targets", () => {
    const walk = graphWalk();
    const edge = { source:"a.md", target:"b.md", kind:"wikilink" as const, ordinal:0 };
    const page = {versionId:"main",files:[{path:"a.md",objectId:"a",title:"A"}],entries:[edge],
      complete:true,indexBuilding:false,mountsCovered:true,unchecked:[],nextCursor:"next"};
    walk.append(page);
    const first = walk.snapshot();
    walk.append({...page,files:[{path:"b.md",objectId:"b",title:"B"}],entries:[edge,{source:"b.md",target:"a.md",kind:"markdown",ordinal:1}]});
    const last = walk.snapshot();
    expect(first.nodes.find(n=>n.path==="b.md")).toMatchObject({title:"b.md",incoming:1,outgoing:0});
    expect(last.nodes.find(n=>n.path==="b.md")).toMatchObject({title:"B",objectId:"b",incoming:1,outgoing:1});
    expect(last.edges).toHaveLength(2);
  });
});
