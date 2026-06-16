// scripts/package.ts — build clean, publishable release archives from the tracked
// git tree. `git archive` exports ONLY committed files, so local DBs (*.db), out/,
// logs/, and node_modules/ are excluded by construction — no manual filtering.
//
// Produces dist/<name>-<version>.tar.gz (mac/linux) and .zip (Windows), then prints
// the `gh release create` command to publish them as a GitHub Release.
//
//   bun run package              # version from package.json, archives HEAD
//   bun run package 0.2.0        # override the version label (→ v0.2.0)
//   bun run package --ref v0.1.0 # archive a specific tag/branch/commit (default HEAD)
import { mkdirSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const pkg = (await Bun.file(join(root, "package.json")).json()) as {
  name: string;
  version: string;
};

// Parse args: optional positional version label; `--ref <gitref>`.
const argv = process.argv.slice(2);
let ref = "HEAD";
let version = `v${pkg.version}`;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--ref") ref = argv[++i] ?? ref;
  else if (!a.startsWith("-")) version = a.startsWith("v") ? a : `v${a}`;
}

const name = pkg.name;
const prefix = `${name}/`; // archives extract into a single top-level dir
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

async function archive(format: string, ext: string): Promise<string> {
  const out = join(dist, `${name}-${version}.${ext}`);
  const proc = Bun.spawn(
    ["git", "archive", `--format=${format}`, `--prefix=${prefix}`, "-o", out, ref],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git archive (${ext}) failed with exit code ${code}`);
  const kb = (Bun.file(out).size / 1024).toFixed(0);
  console.log(`  ${out}  (${kb} KB)`);
  return out;
}

console.log(`Packaging ${name} ${version} from ${ref} ...`);
const tgz = await archive("tar.gz", "tar.gz");
const zip = await archive("zip", "zip");

console.log(`\nDone. Publish a GitHub Release with the gh CLI:\n`);
console.log(`  # tag the commit first if this version isn't tagged yet:`);
console.log(`  git tag ${version} && git push origin ${version}\n`);
console.log(`  gh release create ${version} \\`);
console.log(`    "${tgz}" \\`);
console.log(`    "${zip}" \\`);
console.log(`    --title "${name} ${version}" --generate-notes`);
