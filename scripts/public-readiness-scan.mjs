#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const scanRoots = ["README.md", ".env.example", "docs", "examples"]
  .map((path) => join(root, path))
  .filter((path) => { try { return statSync(path); } catch { return false; } });
const allowedUrlHosts = new Set([
  "127.0.0.1",
  "localhost",
  "github.com",
  "docs.openclaw.ai",
  "discord.com",
]);
const placeholderPattern = /<[^>]+>|example|placeholder|masked|redacted|YOUR_|CHANGEME/i;

const findings = [];

function walk(path) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    return readdirSync(path).flatMap((name) => walk(join(path, name)));
  }
  if (!stat.isFile()) return [];
  if (!/\.(md|yml|yaml|json|env|example|txt)$/i.test(path)) return [];
  return [path];
}

function addFinding(file, lineNumber, severity, kind, detail, line) {
  findings.push({
    file: relative(root, file),
    line: lineNumber,
    severity,
    kind,
    detail,
    excerpt: redact(line.trim()),
  });
}

function redact(value) {
  return value
    .replace(/(edge[-_ ]?secret|broker_edge_secret|token|api[_-]?key|authorization|password)([\w .:-]*=\s*)([^\s"'`]+)/gi, "$1$2<redacted>")
    .replace(/x-a2a-edge-secret:\s*[^\s"'`]+/gi, "x-a2a-edge-secret: <redacted>")
    .replace(/-100\d{6,}/g, "<telegram-chat-id>")
    .replace(/\b(seoseo|racknerd[-\w]*)\b/gi, "<private-host>");
}

function inspectUrl(file, lineNumber, line) {
  const urls = line.match(/https?:\/\/[^\s)\]>'"`]+/g) ?? [];
  for (const rawUrl of urls) {
    try {
      const url = new URL(rawUrl.replace(/[.,;:]$/, ""));
      if (allowedUrlHosts.has(url.hostname)) continue;
      if (!url.hostname.includes(".")) continue;
      if (/^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(url.hostname)) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(url.hostname)) {
        addFinding(file, lineNumber, "warn", "private-url", "Private network URL is documented; keep it placeholder-only.", line);
        continue;
      }
      if (!placeholderPattern.test(rawUrl)) {
        addFinding(file, lineNumber, "warn", "external-url", "Non-allowlisted URL; verify it is public and intentional.", line);
      }
    } catch {
      if (!placeholderPattern.test(rawUrl) && !rawUrl.includes("${") && !rawUrl.includes("<") && !line.includes("${")) {
        addFinding(file, lineNumber, "warn", "url-parse", "URL-like text could not be parsed.", line);
      }
    }
  }
}

/**
 * Test for secret-like concrete values in assignments.
 *
 * Covers two key-name styles:
 * 1. UPPER_CASE  (ENV_VAR style):  EDGE_SECRET=...,  BROKER_TOKEN=...
 * 2. camelCase / PascalCase (JSON / YAML / doc style):
 *    edgeSecret: ...,  apiToken: ...,  brokerPassword=...
 *
 * Both `=` and `:` separators are checked.
 * Boolean-like values (true, false, yes, no) are excluded to avoid false
 * positives on feature flags like ENABLE_SECRET=true, but camelCase secret-key
 * names ARE still flagged even when the value is a boolean so that public-card
 * documentation does not weaken detection.
 */
function inspectSecretAssignment(file, lineNumber, line) {
  // ---- 1) UPPER_CASE with =  (existing behaviour from #438) ----
  const upperAssignment = line.match(
    /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)[A-Z0-9_]*)\s*=\s*([^\s#]+)/i,
  );
  if (upperAssignment) {
    const key = upperAssignment[1];
    const value = upperAssignment[2]
      .replace(/^['"]|['"]$/g, "")
      .replace(/[)\]`'".,;:]+$/, "");
    if (concreteSecretValue(key, value)) {
      addFinding(file, lineNumber, "fail", "secret-value", "Secret-like setting has a concrete value.", line);
    }
    return; // already handled this key
  }

  // ---- 2) camelCase / PascalCase with = or :  (new after #438) ----
  // Detect any key containing a secret-related substring (case-insensitive)
  // followed by = or : and a value.
  const secretSubstrings = /secret|token|password|api[_-]?key|edge[_-]?secret|auth[_-]?token|access[_-]?token|bearer[_-]?token|refresh[_-]?token|client[_-]?secret|jwt[_-]?secret|oauth[_-]?token|api[_-]?secret/i;
  const mixedAssignment = line.match(
    /\b([a-z][a-z0-9_]*(?:[a-z0-9_]*))\s*[:=]\s*([^\s#,]+)/i,
  );
  if (mixedAssignment && secretSubstrings.test(mixedAssignment[1])) {
    const key = mixedAssignment[1];
    const value = mixedAssignment[2]
      .replace(/^['"]|['"]$/g, "")
      .replace(/[)\]`'".,;:]+$/, "");
    if (concreteSecretValue(key, value)) {
      addFinding(file, lineNumber, "fail", "secret-value", "Secret-like camelCase property has a concrete value.", line);
    }
  }
}

/**
 * Returns true when `value` looks like a concrete (non-placeholder, non-boolean,
 * non-shell-expansion, non-file-pointer) assignment that should be flagged.
 */
function concreteSecretValue(key, value) {
  if (!value) return false;
  const isShellExpansion = value.includes("${") || value.startsWith("$");
  const isFilePointer = /_(?:FILE|PATH)$/i.test(key);
  const isBooleanLiteral = /^(?:true|false|yes|no)$/i.test(value);
  if (isShellExpansion || isFilePointer || isBooleanLiteral) return false;
  if (placeholderPattern.test(value)) return false;
  return true;
}

function inspectLine(file, lineNumber, line) {
  if (/\b(seoseo|racknerd[-\w]*)\b/i.test(line) && !/<(?:private|broker|worker|notifier)-host>/i.test(line)) {
    addFinding(file, lineNumber, "warn", "host-alias", "Private host alias should be replaced with a role placeholder in public docs.", line);
  }

  if (/-100\d{6,}/.test(line)) {
    addFinding(file, lineNumber, "fail", "telegram-target", "Telegram chat targets must not appear in public docs/examples.", line);
  }

  inspectSecretAssignment(file, lineNumber, line);

  inspectUrl(file, lineNumber, line);
}

for (const file of scanRoots.flatMap((path) => walk(path))) {
  const text = readFileSync(file, "utf8");
  text.split(/\r?\n/).forEach((line, index) => inspectLine(file, index + 1, line));
}

const summary = findings.reduce(
  (acc, finding) => {
    acc[finding.severity] += 1;
    acc.total += 1;
    return acc;
  },
  { total: 0, fail: 0, warn: 0 },
);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ summary, findings }, null, 2));
} else {
  console.log(`public-readiness-scan: ${summary.fail} fail, ${summary.warn} warn, ${summary.total} total`);
  for (const finding of findings) {
    console.log(`${finding.severity.toUpperCase()} ${finding.file}:${finding.line} ${finding.kind} - ${finding.detail}`);
    console.log(`  ${finding.excerpt}`);
  }
}

process.exitCode = summary.fail > 0 ? 1 : 0;
