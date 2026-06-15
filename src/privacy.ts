// privacy.ts — Worker-protection + data-privacy GATE (merged from cowork-behavior-harness P1).
//
// Two responsibilities, both enforced by code (see POLICY.md):
//   1. REDACTION (sanitizeText / sanitizeRendered): runs at every LLM EGRESS point
//      (render → judge, calibrate reconstruct → judge). Credentials are DROPPED,
//      PII is MASKED. Nothing unredacted reaches the model. Fail-closed by design.
//   2. OPT-OUT (isExcludedSession): a worker can exclude a session/project from
//      analysis (marker file or path substring) — respected BEFORE any content is read.
//
// Pure + dependency-free. Never throws.

import { existsSync } from "fs";
import { join } from "path";
import type { SessionInfo } from "./types.ts";

// ── Credential rules (DROP value — never let a secret reach the LLM) ──────────
const CRED_RULES: Array<[string, RegExp, string]> = [
  [
    "private_key",
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END[^-]*-----/g,
    "[REDACTED-PRIVATE-KEY]",
  ],
  ["password_kv", /\b(?:pass(?:word|wd)?|mat\s?khau|mk|pwd)\b\s*[:=]\s*\S+/gi, "[REDACTED-PASSWORD]"],
  [
    "api_key_kv",
    /\b(?:api[_\- ]?key|secret[_\- ]?key|access[_\- ]?key|client[_\- ]?secret|auth[_\- ]?token|token)\b\s*[:=]\s*\S+/gi,
    "[REDACTED-APIKEY]",
  ],
  ["bearer_hdr", /bearer\s+[A-Za-z0-9._\-]{12,}/gi, "[REDACTED-BEARER]"],
  ["basic_hdr", /basic\s+[A-Za-z0-9+/=]{16,}/gi, "[REDACTED-BASIC]"],
  [
    "known_secret",
    // sk-[...] allows interior - / _ so hyphenated keys (sk-ant-…, sk-proj-…) are caught,
    // not just the first segment. Stripe sk_live_/rk_/pk_ (underscore form) added.
    /\b(?:sk-[A-Za-z0-9_\-]{12,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_\-]{20,}|xox[baprs]-[A-Za-z0-9\-]{10,}|glpat-[A-Za-z0-9_\-]{16,})\b/g,
    "[REDACTED-SECRET]",
  ],
  ["conn_string", /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s"']+/gi, "[REDACTED-CONNSTRING]"],
  ["jwt", /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g, "[REDACTED-JWT]"],
];

// ── PII rules (MASK — keep shape, drop the identifier) ────────────────────────
const PII_RULES: Array<[string, RegExp, string]> = [
  ["email", /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, "[EMAIL]"],
  ["vn_id", /\b\d{12}\b|\b\d{9}\b/g, "[ID]"],
  ["vn_phone", /(?:(?:\+?84)|0)(?:\d[ \-.]?){8,10}\d/g, "[PHONE]"],
  ["bank_acct", /\b\d{8,19}\b/g, "[ACCT]"],
  // Currency symbol may lead ($100) or trail (100usd / 100$); no trailing \b after
  // "$" (a non-word char) — that boundary never matched, so 100$/$100 used to slip.
  ["money", /\$\s?\d[\d.,]{2,}|\b\d[\d.,]{2,}\s?(?:vnd|vnđ|đ|usd|\$)/gi, "[MONEY]"],
  ["cust_code", /\b(?:KH|HD|MKH|CUS|INV)[\-_]?\d{4,}\b/gi, "[CODE]"],
];

const STRONG_PII = new Set(["email", "vn_id", "vn_phone", "bank_acct", "money", "cust_code"]);

export interface RedactionResult {
  text: string;
  hits: string[]; // rule names that fired
  hadCredential: boolean; // a credential was dropped
  nStrongPii: number; // count of strong-PII rules that fired
}

// Sanitize one string. Credentials are dropped FIRST, then PII masked.
export function sanitizeText(input: string): RedactionResult {
  let text = input ?? "";
  const hits: string[] = [];
  let hadCredential = false;

  for (const [name, re, repl] of CRED_RULES) {
    if (re.test(text)) {
      text = text.replace(re, repl);
      hits.push(name);
      hadCredential = true;
    }
    re.lastIndex = 0; // reset stateful /g regex
  }
  let nStrongPii = 0;
  for (const [name, re, repl] of PII_RULES) {
    if (re.test(text)) {
      text = text.replace(re, repl);
      hits.push(name);
      if (STRONG_PII.has(name)) nStrongPii++;
    }
    re.lastIndex = 0;
  }
  return { text, hits, hadCredential, nStrongPii };
}

// Convenience wrapper for the render → judge egress point.
export function sanitizeRendered(rendered: string): RedactionResult {
  return sanitizeText(rendered);
}

// ── Worker opt-out (consent) ──────────────────────────────────────────────────
const MARKER_FILENAME = ".cwbh-exclude";
const EXCLUDE_SUBSTRINGS = (process.env.CWBH_EXCLUDE ?? "personal,private,ca-nhan,rieng-tu")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// True (+reason) iff a worker has opted this session/project out of analysis.
export function isExcludedSession(session: SessionInfo): { excluded: boolean; reason: string } {
  const hay = `${session.cwd} ${session.jsonlPath} ${session.projectDir} ${session.project}`
    .toLowerCase()
    .replace(/\\/g, "/");
  for (const sub of EXCLUDE_SUBSTRINGS) {
    if (sub && hay.includes(sub)) return { excluded: true, reason: `path contains "${sub}" (opt-out)` };
  }
  // marker file in the session's working directory
  try {
    if (session.cwd && existsSync(join(session.cwd, MARKER_FILENAME))) {
      return { excluded: true, reason: `${MARKER_FILENAME} present in cwd` };
    }
  } catch {
    /* ignore */
  }
  return { excluded: false, reason: "" };
}

// Partition sessions into kept vs excluded (for the pipeline + audit).
export function filterExcluded(sessions: SessionInfo[]): {
  kept: SessionInfo[];
  excluded: { sessionId: string; project: string; reason: string }[];
} {
  const kept: SessionInfo[] = [];
  const excluded: { sessionId: string; project: string; reason: string }[] = [];
  for (const s of sessions) {
    const { excluded: ex, reason } = isExcludedSession(s);
    if (ex) excluded.push({ sessionId: s.sessionId, project: s.project, reason });
    else kept.push(s);
  }
  return { kept, excluded };
}
