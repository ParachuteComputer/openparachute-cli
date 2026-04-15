import { expect, test, afterAll } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type CliDeps } from "../src/cli.js";

const tmp = mkdtempSync(join(tmpdir(), "parachute-cli-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function makeFakeBin(
  dir: string,
  name: string,
  opts: { description?: string; packageJson?: boolean; executable?: boolean } = {},
): string {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, name);
  writeFileSync(bin, "#!/bin/sh\necho fake\n");
  chmodSync(bin, opts.executable === false ? 0o644 : 0o755);

  if (opts.packageJson) {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: `@openparachute/${name.replace("parachute-", "")}`, description: opts.description ?? "fake description" }),
    );
  }
  return bin;
}

function mkFixture(selfVersion = "0.1.0"): string {
  const dir = join(tmp, `case-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const selfPkg = join(dir, "package.json");
  writeFileSync(
    selfPkg,
    JSON.stringify({ name: "@openparachute/cli", version: selfVersion }),
  );
  return selfPkg;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
    } satisfies Pick<CliDeps, "stdout" | "stderr">,
    outText: () => out.join(""),
    errText: () => err.join(""),
  };
}

test("--version prints the package version", async () => {
  const selfPackageJson = mkFixture("0.2.3");
  const cap = capture();
  const code = await main(["--version"], {
    selfPackageJson,
    pathEntries: [],
    ...cap.deps,
  });
  expect(code).toBe(0);
  expect(cap.outText().trim()).toBe("0.2.3");
});

test("--help lists discovered parachute-* bins with descriptions", async () => {
  const selfPackageJson = mkFixture();
  const binDir = join(tmp, `bins-${Math.random().toString(36).slice(2, 8)}`);
  makeFakeBin(binDir, "parachute-hello", {
    packageJson: true,
    description: "Greet the world",
  });
  makeFakeBin(binDir, "parachute-zeta");
  // Non-matching file — must be ignored.
  makeFakeBin(binDir, "unrelated-binary");

  const cap = capture();
  const code = await main(["--help"], {
    selfPackageJson,
    pathEntries: [binDir],
    ...cap.deps,
  });
  expect(code).toBe(0);
  const out = cap.outText();
  expect(out).toContain("hello");
  expect(out).toContain("Greet the world");
  expect(out).toContain("zeta");
  expect(out).not.toContain("unrelated-binary");
  expect(out.indexOf("hello")).toBeLessThan(out.indexOf("zeta"));
});

test("help with empty PATH explains how to add subcommands", async () => {
  const selfPackageJson = mkFixture();
  const cap = capture();
  const code = await main([], { selfPackageJson, pathEntries: [], ...cap.deps });
  expect(code).toBe(0);
  expect(cap.outText()).toContain("(none)");
  expect(cap.outText()).toContain("bun add -g");
});

test("parachute <sub> execs parachute-<sub> and forwards args + exit", async () => {
  const selfPackageJson = mkFixture();
  const binDir = join(tmp, `bins-${Math.random().toString(36).slice(2, 8)}`);
  const binPath = makeFakeBin(binDir, "parachute-hello");

  const calls: Array<{ bin: string; args: string[] }> = [];
  const cap = capture();
  const code = await main(["hello", "world", "--flag"], {
    selfPackageJson,
    pathEntries: [binDir],
    ...cap.deps,
    execBin: async (bin, args) => {
      calls.push({ bin, args });
      return 42;
    },
  });
  expect(code).toBe(42);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.bin).toBe(binPath);
  expect(calls[0]!.args).toEqual(["world", "--flag"]);
});

test("unknown subcommand exits 1 and lists available bins on stderr", async () => {
  const selfPackageJson = mkFixture();
  const binDir = join(tmp, `bins-${Math.random().toString(36).slice(2, 8)}`);
  makeFakeBin(binDir, "parachute-alpha");
  makeFakeBin(binDir, "parachute-beta");

  const cap = capture();
  const code = await main(["nonexistent"], {
    selfPackageJson,
    pathEntries: [binDir],
    ...cap.deps,
  });
  expect(code).toBe(1);
  const err = cap.errText();
  expect(err).toContain("no subcommand `nonexistent`");
  expect(err).toContain("alpha");
  expect(err).toContain("beta");
});

test("unknown flag exits 2", async () => {
  const selfPackageJson = mkFixture();
  const cap = capture();
  const code = await main(["--bogus"], {
    selfPackageJson,
    pathEntries: [],
    ...cap.deps,
  });
  expect(code).toBe(2);
  expect(cap.errText()).toContain("unknown flag");
});

test("first PATH entry wins when two dirs provide the same subcommand", async () => {
  const selfPackageJson = mkFixture();
  const dirA = join(tmp, `a-${Math.random().toString(36).slice(2, 8)}`);
  const dirB = join(tmp, `b-${Math.random().toString(36).slice(2, 8)}`);
  const winner = makeFakeBin(dirA, "parachute-dup");
  makeFakeBin(dirB, "parachute-dup");

  const calls: Array<{ bin: string }> = [];
  const cap = capture();
  const code = await main(["dup"], {
    selfPackageJson,
    pathEntries: [dirA, dirB],
    ...cap.deps,
    execBin: async (bin) => {
      calls.push({ bin });
      return 0;
    },
  });
  expect(code).toBe(0);
  expect(calls[0]!.bin).toBe(winner);
});

test("explicit pathEntries bypasses OS separator parsing (cross-platform safe)", async () => {
  // When pathEntries is provided directly, we never split PATH — so the same
  // test works on Windows and Unix without branching on platform.
  const selfPackageJson = mkFixture();
  const binDir = join(tmp, `bins-${Math.random().toString(36).slice(2, 8)}`);
  makeFakeBin(binDir, "parachute-xplat");

  const cap = capture();
  await main(["--help"], { selfPackageJson, pathEntries: [binDir], ...cap.deps });
  expect(cap.outText()).toContain("xplat");
});

test("non-executable parachute-* files are ignored", async () => {
  const selfPackageJson = mkFixture();
  const binDir = join(tmp, `bins-${Math.random().toString(36).slice(2, 8)}`);
  makeFakeBin(binDir, "parachute-readonly", { executable: false });
  makeFakeBin(binDir, "parachute-real");

  const cap = capture();
  await main(["--help"], { selfPackageJson, pathEntries: [binDir], ...cap.deps });
  const out = cap.outText();
  expect(out).toContain("real");
  expect(out).not.toContain("readonly");
});
