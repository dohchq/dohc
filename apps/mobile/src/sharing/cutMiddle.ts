/** A name cut in the middle to at most `max` characters, so its start and its extension both show. */
export function cutMiddle(name: string, max: number): string {
  const chars = Array.from(name);
  if (chars.length <= max) return name;
  const tail = Math.floor((max - 1) / 2);
  return `${chars.slice(0, max - 1 - tail).join("")}…${chars.slice(chars.length - tail).join("")}`;
}
