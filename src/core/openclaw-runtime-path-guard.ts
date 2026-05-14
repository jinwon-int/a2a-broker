/**
 * Shared guard for OpenClaw runtime/bootstrap context file paths.
 *
 * These file names and paths must never appear in Terminal Brief dispatch
 * content because they leak private agent workspace state and would expose
 * the agent's identity and memory structure to the origin broker.
 *
 * Both `cross-broker-terminal-brief.ts` (origin dispatch guard) and
 * `terminal-brief-evidence.ts` (GitHub evidence guard) use this module.
 */

/** Pattern that matches OpenClaw runtime file references and `.openclaw/` paths. */
export const UNSAFE_OPENCLAW_RUNTIME_PATH_RE =
  /(^|[\s([{"'`])((?:\.openclaw\/[^\s)\]}'"`<>]+)|AGENTS\.md|SOUL\.md|USER\.md|TOOLS\.md|HEARTBEAT\.md|IDENTITY\.md)(?=$|[\s)\]},.'"`<>])/g;

/**
 * Returns true when `text` contains an OpenClaw runtime/bootstrap context
 * file path that must not enter Terminal Brief evidence.
 */
export function containsOpenClawRuntimeTextPath(text: string): boolean {
  UNSAFE_OPENCLAW_RUNTIME_PATH_RE.lastIndex = 0;
  return UNSAFE_OPENCLAW_RUNTIME_PATH_RE.test(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively visit a value (string, object, array) and return every
 * OpenClaw runtime/bootstrap path found. Matches the original logic
 * from terminal-brief-evidence.ts: checks both object keys and values.
 */
export function findOpenClawRuntimePaths(value: unknown): string[] {
  const found = new Set<string>();
  function visit(v: unknown): void {
    if (typeof v === "string") {
      for (const match of v.matchAll(UNSAFE_OPENCLAW_RUNTIME_PATH_RE)) {
        found.add(match[2]);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (!isRecord(v)) return;
    for (const [key, raw] of Object.entries(v)) {
      visit(key);
      visit(raw);
    }
  }
  visit(value);
  return [...found].sort();
}

/**
 * Throw when `value` contains any OpenClaw runtime/bootstrap context path.
 */
export function assertNoOpenClawRuntimePaths(value: unknown): void {
  const offendingPaths = findOpenClawRuntimePaths(value);
  if (offendingPaths.length > 0) {
    throw new Error(
      `refusing to project OpenClaw runtime/bootstrap paths into evidence: ${offendingPaths.join(", ")}`,
    );
  }
}
