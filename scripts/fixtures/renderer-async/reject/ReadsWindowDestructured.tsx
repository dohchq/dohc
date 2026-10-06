export function A() {
  const { dohcDesktop } = window as any;
  void dohcDesktop.readPage({});
  return null;
}
