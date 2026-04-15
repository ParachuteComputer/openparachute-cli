#!/usr/bin/env bun
/**
 * `parachute` — umbrella dispatcher for the @openparachute family.
 *
 * Scans PATH for any executable named `parachute-<subcommand>` and treats
 * each as a subcommand. `parachute <sub> [args...]` execs the matching
 * binary, forwarding stdio and exit code. `parachute` (no args) / `--help`
 * lists the subcommands it found, with each subcommand's npm package
 * description when discoverable.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";

const PKG_PREFIX = "parachute-";

interface Subcommand {
  name: string;
  bin: string;
  description?: string;
}

export interface CliDeps {
  /** Path to this package's own package.json (for `--version`). */
  selfPackageJson: string;
  /** Override PATH entries (primarily for tests). Default: process.env.PATH split. */
  pathEntries?: string[];
  /** stdout/stderr sinks — overridable for tests. */
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /**
   * Exec a subcommand binary. Defaults to spawning with inherited stdio.
   * Returns the exit code. Tests inject a fake.
   */
  execBin?: (bin: string, args: string[]) => Promise<number>;
}

function defaultExec(bin: string, args: string[]): Promise<number> {
  const BunGlobal = (globalThis as { Bun?: { spawn: (o: unknown) => unknown } }).Bun;
  if (!BunGlobal) {
    throw new Error("parachute: Bun runtime required for subcommand exec.");
  }
  const proc = BunGlobal.spawn({
    cmd: [bin, ...args],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }) as { exited: Promise<number> };
  return proc.exited;
}

function listPathEntries(deps: CliDeps): string[] {
  if (deps.pathEntries) return deps.pathEntries;
  const p = process.env.PATH ?? "";
  return p.split(process.platform === "win32" ? ";" : ":").filter(Boolean);
}

/**
 * Walk every PATH entry, find files whose basename starts with `parachute-`,
 * and collect them. First occurrence on PATH wins (matches shell lookup order).
 */
function discoverSubcommands(deps: CliDeps): Subcommand[] {
  const seen = new Map<string, Subcommand>();
  for (const dir of listPathEntries(deps)) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith(PKG_PREFIX)) continue;
      const sub = name.slice(PKG_PREFIX.length);
      if (!sub || seen.has(sub)) continue;
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (!st.isFile() || (st.mode & 0o111) === 0) continue;
      } catch {
        continue;
      }
      seen.set(sub, {
        name: sub,
        bin: full,
        description: describeBin(full),
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * If the binary is an npm-installed bin symlink, walk up from the resolved
 * target to find the package's `package.json` and return its `description`.
 * Skips execution-based probing so the help scan stays fast.
 */
function describeBin(bin: string): string | undefined {
  let resolved: string;
  try {
    resolved = Bun.fileURLToPath(new URL(`file://${bin}`));
  } catch {
    resolved = bin;
  }
  let current = dirname(resolved);
  for (let i = 0; i < 6; i++) {
    const pj = join(current, "package.json");
    try {
      const raw = readFileSync(pj, "utf8");
      const parsed = JSON.parse(raw) as { description?: string };
      if (parsed.description) return parsed.description;
      return undefined;
    } catch {
      /* keep climbing */
    }
    const parent = dirname(current);
    if (parent === current || parent === sep) break;
    current = parent;
  }
  return undefined;
}

function selfVersion(deps: CliDeps): string {
  const raw = readFileSync(deps.selfPackageJson, "utf8");
  const { version } = JSON.parse(raw) as { version: string };
  return version;
}

function printHelp(deps: Required<Pick<CliDeps, "stdout">>, subs: Subcommand[]): void {
  deps.stdout(`parachute — unified CLI for the @openparachute family\n`);
  deps.stdout(`\nUsage: parachute <subcommand> [args...]\n`);
  deps.stdout(`\nSubcommands (discovered on PATH):\n`);
  if (subs.length === 0) {
    deps.stdout(`  (none) — install a \`parachute-*\` binary to add one\n`);
    deps.stdout(`  e.g. \`bun add -g @openparachute/agent\` provides \`parachute-agent\`\n`);
  } else {
    const width = Math.max(...subs.map((s) => s.name.length));
    for (const s of subs) {
      const desc = s.description ? `  ${s.description}` : "";
      deps.stdout(`  ${s.name.padEnd(width)}${desc}\n`);
    }
  }
  deps.stdout(`\nFlags:\n`);
  deps.stdout(`  --help, -h     Show this help\n`);
  deps.stdout(`  --version, -v  Print parachute version\n`);
}

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
  const exec = deps.execBin ?? defaultExec;

  const first = argv[0];

  if (!first || first === "--help" || first === "-h") {
    printHelp({ stdout }, discoverSubcommands(deps));
    return 0;
  }

  if (first === "--version" || first === "-v") {
    stdout(`${selfVersion(deps)}\n`);
    return 0;
  }

  if (first.startsWith("-")) {
    stderr(`parachute: unknown flag \`${first}\`\n`);
    printHelp({ stdout: stderr }, discoverSubcommands(deps));
    return 2;
  }

  const subs = discoverSubcommands(deps);
  const match = subs.find((s) => s.name === first);
  if (!match) {
    stderr(
      `parachute: no subcommand \`${first}\` — install \`@openparachute/${first}\` or another package providing \`parachute-${first}\` on PATH.\n`,
    );
    stderr(`\nAvailable subcommands:\n`);
    if (subs.length === 0) {
      stderr(`  (none found on PATH)\n`);
    } else {
      for (const s of subs) stderr(`  ${s.name}\n`);
    }
    return 1;
  }

  return exec(match.bin, argv.slice(1));
}

const importMeta = import.meta as ImportMeta & { main?: boolean; url: string };
if (importMeta.main) {
  const selfPackageJson = join(
    dirname(Bun.fileURLToPath(new URL(importMeta.url))),
    "..",
    "package.json",
  );
  const code = await main(process.argv.slice(2), { selfPackageJson });
  process.exit(code);
}
