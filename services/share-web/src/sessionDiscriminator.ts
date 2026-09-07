export function isSessionDiscriminator(value: string): boolean {
  return /^[A-Za-z0-9_-]{12}$/u.test(value);
}
