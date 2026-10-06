let reads = 0;
export async function readCounted(desktop: any) { reads += 1; return desktop.read({ reads }); }
