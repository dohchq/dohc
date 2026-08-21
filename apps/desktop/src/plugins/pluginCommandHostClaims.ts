export class PluginCommandHostClaims {
  private readonly counts = new Map<string, number>();

  claim(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  release(key: string): void {
    const count = this.counts.get(key);
    if (count === undefined) return;
    if (count <= 1) {
      this.counts.delete(key);
      return;
    }
    this.counts.set(key, count - 1);
  }

  has(key: string): boolean {
    return this.counts.has(key);
  }
}
