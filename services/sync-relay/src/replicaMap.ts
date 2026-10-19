// Persistent AVL nodes let a published view retain its paths while the next delta is applied.
type Node<V> = {key:string; value:V; left?:Node<V>; right?:Node<V>; height:number};
const height = <V>(node?:Node<V>) => node?.height ?? 0;
function node<V>(key:string,value:V,left?:Node<V>,right?:Node<V>):Node<V> {
  return {key,value,left,right,height:1+Math.max(height(left),height(right))};
}
function balance<V>(n:Node<V>):Node<V> {
  if (height(n.left)-height(n.right)>1) {
    let l=n.left!;
    if (height(l.left)<height(l.right)) {
      const r=l.right!; l=node(r.key,r.value,node(l.key,l.value,l.left,r.left),r.right);
    }
    return node(l.key,l.value,l.left,node(n.key,n.value,l.right,n.right));
  }
  if (height(n.right)-height(n.left)>1) {
    let r=n.right!;
    if (height(r.right)<height(r.left)) {
      const l=r.left!; r=node(l.key,l.value,l.left,node(r.key,r.value,l.right,r.right));
    }
    return node(r.key,r.value,node(n.key,n.value,n.left,r.left),r.right);
  }
  return n;
}
function put<V>(n:Node<V>|undefined,key:string,value:V|undefined):Node<V>|undefined {
  if (!n) return value===undefined ? undefined : node(key,value);
  if (key<n.key) return balance(node(n.key,n.value,put(n.left,key,value),n.right));
  if (key>n.key) return balance(node(n.key,n.value,n.left,put(n.right,key,value)));
  if (value!==undefined) return node(key,value,n.left,n.right);
  if (!n.left) return n.right;
  if (!n.right) return n.left;
  let successor=n.right; while(successor.left) successor=successor.left;
  return balance(node(successor.key,successor.value,n.left,put(n.right,successor.key,undefined)));
}
export class ReplicaMap<V> {
  private root?:Node<V>;
  size=0;
  constructor(entries?:Iterable<readonly [string,V]>) {
    if(!entries)return;
    const sorted=[...(entries instanceof Map ? entries : new Map(entries))].sort(([a],[b])=>a<b?-1:a>b?1:0);
    const build=(start:number,end:number):Node<V>|undefined=>{
      if(start===end)return undefined;
      const mid=(start+end)>>>1, [key,value]=sorted[mid]!;
      return node(key,value,build(start,mid),build(mid+1,end));
    };
    this.root=build(0,sorted.length);this.size=sorted.length;
  }
  fork() {const copy=new ReplicaMap<V>();copy.root=this.root;copy.size=this.size;return copy;}
  get(key:string):V|undefined {let n=this.root;while(n){if(key===n.key)return n.value;n=key<n.key?n.left:n.right;}return undefined;}
  has(key:string) {return this.get(key)!==undefined;}
  set(key:string,value:V) {if(!this.has(key))this.size++;this.root=put(this.root,key,value);return this;}
  delete(key:string) {if(!this.has(key))return false;this.size--;this.root=put(this.root,key,undefined);return true;}
  *[Symbol.iterator]():Generator<[string,V]> {
    const stack:Node<V>[]=[];let n=this.root;
    while(n||stack.length){while(n){stack.push(n);n=n.left;}n=stack.pop()!;yield [n.key,n.value];n=n.right;}
  }
  *values() {for(const [,v] of this)yield v;}
  *keys() {for(const [k] of this)yield k;}
}
