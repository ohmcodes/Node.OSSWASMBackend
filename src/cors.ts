/** Turns origin patterns like "https://*.itch.zone" or "http://localhost:*" into a matcher. */
export function originMatcher(patterns: string[]): (origin: string) => boolean {
  if (patterns.includes("*")) return () => true;
  const regexes = patterns.map((p) => {
    const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
    return new RegExp(`^${escaped}$`, "i");
  });
  return (origin) => regexes.some((r) => r.test(origin));
}
