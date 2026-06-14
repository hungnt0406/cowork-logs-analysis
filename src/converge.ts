// converge.ts — Cross-machine convergence (merged from cowork-behavior-harness P3b).
//
// Each machine runs the pipeline locally and emits out/state/candidates_<machine>.json
// (written by report.ts). This module gathers those PER-MACHINE exports and merges
// workflow candidates that recur ACROSS machines. A workflow seen on >= 2 machines is
// "cross-validated" → the strongest signal for an org-wide (meta-phase) skill.
//
// Privacy-safe: operates on ranked candidates only (cluster labels + components),
// never raw transcript content. Pure aside from file reads. Never throws on bad input.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import type { RankedCandidate, ConvergedWorkflow, SkillType } from "./types.ts";

const DEFAULT_STATE_DIR = join(import.meta.dir, "..", "out", "state");
const DEFAULT_OUT_DIR = join(import.meta.dir, "..", "out");
const SIM_THRESHOLD = 0.4;

interface MachineCandidate {
  machineId: string;
  candidate: RankedCandidate;
}

// Load every candidates_*.json export under a dir (or explicit paths).
export function loadExports(paths: string[]): MachineCandidate[] {
  const out: MachineCandidate[] = [];
  for (const p of paths) {
    let data: any;
    try {
      data = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    const machineId = typeof data?.machine_id === "string" ? data.machine_id : p;
    const cands = Array.isArray(data?.candidates) ? data.candidates : [];
    for (const c of cands) {
      if (c && typeof c === "object") out.push({ machineId, candidate: c as RankedCandidate });
    }
  }
  return out;
}

export function discoverExportPaths(stateDir = DEFAULT_STATE_DIR): string[] {
  try {
    return readdirSync(stateDir)
      .filter((f) => f.startsWith("candidates_") && f.endsWith(".json"))
      .map((f) => join(stateDir, f));
  } catch {
    return [];
  }
}

// Signature of a candidate for cross-machine matching: label tokens + dominant pattern.
function signature(c: RankedCandidate): Set<string> {
  const s = new Set<string>();
  for (const tok of (c.label ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    s.add(`l:${tok}`);
  }
  if (c.dominant_pattern) s.add(`p:${c.dominant_pattern.toLowerCase()}`);
  return s;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function sha1ish(s: string): string {
  // tiny stable id (no crypto dep needed); good enough for a converged_id
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}

function pickIntervention(members: MachineCandidate[]): SkillType {
  const votes = new Map<SkillType, number>();
  for (const m of members) {
    const t = m.candidate.recommended_intervention;
    if (t) votes.set(t, (votes.get(t) ?? 0) + 1);
  }
  let best: SkillType = "none";
  let bestN = -1;
  for (const [t, n] of votes) {
    if (t !== "none" && n > bestN) {
      bestN = n;
      best = t;
    }
  }
  return best;
}

// Greedy cluster candidates across machines.
export function converge(items: MachineCandidate[]): ConvergedWorkflow[] {
  const allMachines = new Set(items.map((i) => i.machineId));
  const clusters: MachineCandidate[][] = [];
  const sigs: Set<string>[] = [];

  for (const it of items) {
    const sig = signature(it.candidate);
    let bestI = -1;
    let best = 0;
    for (let i = 0; i < sigs.length; i++) {
      const sim = jaccard(sig, sigs[i]);
      if (sim > best) {
        best = sim;
        bestI = i;
      }
    }
    if (bestI >= 0 && best >= SIM_THRESHOLD) {
      clusters[bestI].push(it);
      for (const x of sig) sigs[bestI].add(x);
    } else {
      clusters.push([it]);
      sigs.push(new Set(sig));
    }
  }

  const converged: ConvergedWorkflow[] = clusters.map((members, idx) => {
    const machines = [...new Set(members.map((m) => m.machineId))].sort();
    const perMachine: Record<string, number> = {};
    for (const m of members) {
      perMachine[m.machineId] = (perMachine[m.machineId] ?? 0) + (m.candidate.frequency ?? 0);
    }
    const label = members[0].candidate.label ?? `workflow-${idx}`;
    return {
      converged_id: sha1ish(`conv|${idx}|${label}`),
      label,
      machines,
      n_machines: machines.length,
      total_frequency: Object.values(perMachine).reduce((a, b) => a + b, 0),
      per_machine_frequency: perMachine,
      representative_clusters: members.map((m) => m.candidate.cluster_id),
      recommended_intervention: pickIntervention(members),
      agreement: Number((machines.length / Math.max(1, allMachines.size)).toFixed(3)),
      cross_validated: machines.length >= 2,
    };
  });

  converged.sort(
    (a, b) => Number(b.cross_validated) - Number(a.cross_validated) || b.total_frequency - a.total_frequency
  );
  return converged;
}

export function writeConvergenceReport(converged: ConvergedWorkflow[], outDir = DEFAULT_OUT_DIR): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "convergence.json"),
    JSON.stringify({ generated_at: new Date().toISOString(), converged }, null, 2),
    "utf8"
  );
  const xval = converged.filter((c) => c.cross_validated).length;
  const L: string[] = ["# Cross-machine convergence", ""];
  L.push(`- Converged workflows: **${converged.length}** · cross-validated (≥2 machines): **${xval}**`);
  L.push("");
  L.push("| # | Workflow | #Machines | Cross-validated | Total freq | Per-machine | Rec |");
  L.push("|---|---|---|---|---|---|---|");
  converged.forEach((c, i) => {
    const pm = Object.entries(c.per_machine_frequency)
      .map(([m, n]) => `${m}:${n}`)
      .join(", ");
    L.push(
      `| ${i + 1} | ${c.label} | ${c.n_machines} | ${c.cross_validated ? "✅" : "—"} | ${c.total_frequency} | ${pm} | ${c.recommended_intervention} |`
    );
  });
  L.push("");
  L.push("> Cross-validated workflows are the highest-confidence candidates for the org-wide meta phase.");
  writeFileSync(join(outDir, "convergence.md"), L.join("\n"), "utf8");
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// Usage: bun run src/converge.ts [--inputs a.json b.json ...]
if (import.meta.main) {
  const args = process.argv.slice(2);
  let inputs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--inputs") {
      while (args[i + 1] && !args[i + 1].startsWith("--")) inputs.push(args[++i]);
    }
  }
  if (inputs.length === 0) inputs = discoverExportPaths();
  if (inputs.length === 0) {
    console.error(
      "[converge] no candidates_*.json found. Run the pipeline on each machine first " +
        "(out/state/candidates_<machine>.json), or pass --inputs <files>."
    );
    process.exit(2);
  }
  const items = loadExports(inputs);
  const converged = converge(items);
  writeConvergenceReport(converged);
  const xval = converged.filter((c) => c.cross_validated).length;
  console.log(`[converge] ${inputs.length} machine export(s) → ${converged.length} converged (${xval} cross-validated)`);
  for (const c of converged.slice(0, 12)) {
    const tag = c.cross_validated ? "CROSS-VALIDATED" : "single-machine ";
    console.log(`  [${tag}] ${c.label}  machines=${JSON.stringify(c.machines)} freq=${JSON.stringify(c.per_machine_frequency)}`);
  }
  console.log("[converge] wrote out/convergence.md + out/convergence.json");
}
