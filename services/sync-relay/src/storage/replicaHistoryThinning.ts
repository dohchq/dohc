interface Gap {distance: number; index: number; generation: number}

// Deleting a pin can only increase its neighbors' gaps. A monotone radix queue
// visits each gap at most 53 times, independent of the number of pins.
class Gaps {
  private last = 0;
  private buckets: Gap[][] = Array.from({length:54},()=>[]);
  private bucket(distance: number) {
    const high=(Math.floor(distance/2**32)^Math.floor(this.last/2**32))>>>0;
    return high ? 64-Math.clz32(high) : 32-Math.clz32((distance^this.last)>>>0);
  }
  push(gap: Gap) {this.buckets[this.bucket(gap.distance)]!.push(gap);}
  pop(): Gap | undefined {
    if (!this.buckets[0]!.length) {
      const index=this.buckets.findIndex(bucket=>bucket.length>0);
      if (index<0) return;
      const bucket=this.buckets[index]!;
      this.last=bucket.reduce((min,gap)=>Math.min(min,gap.distance),Number.MAX_SAFE_INTEGER);
      this.buckets[index]=[];
      for (const gap of bucket) this.push(gap);
    }
    return this.buckets[0]!.pop();
  }
}

export function replicaHistoryPinsToDrop<T extends Record<string,unknown>>(rows: T[], budget: {maxBytes: number; maxCount: number}) {
  let bytes=rows.reduce((n,row)=>n+Number(row.bytes),0), count=rows.length;
  const dropped: T[]=[];
  const over=()=>bytes>budget.maxBytes || count>budget.maxCount;
  // Exhaust nonstructural pins first. Within each class keep the endpoints
  // while repeatedly removing the interior pin closest to either neighbor.
  for (const structural of [false,true]) {
    const nodes=rows.filter(row=>(!["quiet","ceiling"].includes(String(row.reason)))===structural)
      .map((row,index)=>({row,previous:index-1,next:index+1,generation:0,removed:false}));
    const queue=new Gaps();
    const enqueue=(index: number)=>{
      const node=nodes[index];
      if (!node) return;
      node.generation++;
      if (node.previous<0 || node.next>=nodes.length) return;
      const time=Number(node.row.pinned_at_ms);
      queue.push({index,generation:node.generation,distance:Math.min(time-Number(nodes[node.previous]!.row.pinned_at_ms),
        Number(nodes[node.next]!.row.pinned_at_ms)-time)});
    };
    const drop=(index: number)=>{
      const node=nodes[index]!;
      node.removed=true; dropped.push(node.row); bytes-=Number(node.row.bytes); count--;
      if (nodes[node.previous]) nodes[node.previous]!.next=node.next;
      if (nodes[node.next]) nodes[node.next]!.previous=node.previous;
      enqueue(node.previous); enqueue(node.next);
    };
    nodes.forEach((_,index)=>enqueue(index));
    while (over()) {
      const gap=queue.pop();
      if (!gap) break;
      const node=nodes[gap.index]!;
      if (!node.removed && node.generation===gap.generation) drop(gap.index);
    }
    for (let i=0;over() && i<nodes.length;i++) if (!nodes[i]!.removed) drop(i);
    if (!over()) break;
  }
  return dropped;
}
