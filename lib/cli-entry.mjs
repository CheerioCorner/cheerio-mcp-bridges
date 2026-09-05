/**
 * Locating and invoking a CLI entry point.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * On 2026-09-05 every ask_pi call failed for ~3 hours. pi 0.85.0 shipped an
 * UNBUNDLED entry at `dist/cli.js` that imports a package which is not
 * installed (`@earendil-works/pi-server`), so the process died instantly with
 * ERR_MODULE_NOT_FOUND. The real, dependency-bundled entry is the one the
 * package's own `package.json` "bin" field points at (`dist/bundle/cli.js`).
 *
 * Anything that GUESSES a path — a doc example, a doctor fallback baked to one
 * person's machine — encodes a snapshot of some past install layout and rots
 * silently. So: read the entry from the package's own metadata, or take it
 * from an explicit env var, or fail loudly. Never guess.
 *
 * All I/O is injectable so the resolution order can be unit-tested without a
 * real npm install.
 */

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";

/**
 * Resolve a CLI's entry point.
 *
 * Order (first hit wins):
 *   1. `envVar` — an explicit absolute path the operator configured.
 *   2. The npm package's own `package.json` "bin" field (local resolution
 *      first, then the npm global root). This is the authoritative answer:
 *      it is exactly what `npm` itself would put on PATH.
 *   3. A PATH lookup of `binName` (where/which).
 * Otherwise: `{ path: null }` plus the list of what was tried, so the caller
 * can print an actionable error instead of pretending it found something.
 *
 * @param {object} o
 * @param {string} o.envVar            e.g. "PI_BRIDGE_ENTRY".
 * @param {string} [o.npmPackage]      e.g. "@earendil-works/pi-coding-agent".
 * @param {string} o.binName           Bin/command name, e.g. "pi".
 * @param {object} [o.env]             Env source (default process.env).
 * @param {Function} [o.readPackageJson] async (pkgDir) => object|null.
 * @param {Function} [o.localResolve]  (pkg) => absolute package dir | null.
 * @param {Function} [o.npmGlobalRoot] async () => absolute dir | null.
 * @param {Function} [o.which]         async (cmd) => absolute path | null.
 * @returns {Promise<{path: string|null, source: string|null, tried: string[]}>}
 */
export async function resolveEntry({
  envVar,
  npmPackage,
  binName,
  env = process.env,
  readPackageJson = defaultReadPackageJson,
  localResolve = defaultLocalResolve,
  npmGlobalRoot = defaultNpmGlobalRoot,
  which = defaultWhich,
}) {
  const tried = [];

  const fromEnv = env[envVar];
  if (fromEnv) return { path: fromEnv, source: "env", tried };
  tried.push(`${envVar} (not set)`);

  if (npmPackage) {
    const dirs = [];
    const local = await localResolve(npmPackage);
    if (local) dirs.push(local);
    const globalRoot = await npmGlobalRoot();
    if (globalRoot) dirs.push(joinPkg(globalRoot, npmPackage));

    for (const dir of dirs) {
      const pkg = await readPackageJson(dir);
      const binRel = pickBin(pkg, binName);
      if (binRel) {
        return {
          path: resolvePath(dir, binRel),
          source: "package-bin",
          tried,
        };
      }
    }
    tried.push(`${npmPackage} package.json "bin" (not resolvable)`);
  }

  const onPath = await which(binName);
  if (onPath) return { path: onPath, source: "path", tried };
  tried.push(`${binName} on PATH (not found)`);

  return { path: null, source: null, tried };
}

/**
 * Pull one entry out of a package.json "bin" field, which may be either a
 * bare string (single bin, named after the package) or a name->path map.
 */
export function pickBin(pkg, binName) {
  const bin = pkg?.bin;
  if (!bin) return null;
  if (typeof bin === "string") return bin;
  if (typeof bin === "object") return bin[binName] || null;
  return null;
}

/**
 * Decide HOW to execute a resolved entry.
 *
 * A `.js`/`.mjs`/`.cjs` entry is a script, not an executable — it has to be
 * handed to the current node binary (process.execPath), which is also what the
 * bridges do at runtime. A `.cmd`/`.bat` shim only runs through cmd.exe, and
 * backslashes get eaten there, so they are normalised to forward slashes.
 *
 * @param {string} entry  Absolute path to the entry point.
 * @param {string[]} args
 * @param {object} [o]
 * @param {string} [o.execPath]  node binary (default process.execPath).
 * @returns {{command: string, args: string[], shell: boolean}}
 */
export function buildInvocation(entry, args, { execPath = process.execPath } = {}) {
  if (/\.(c|m)?js$/i.test(entry)) {
    return { command: execPath, args: [entry, ...args], shell: false };
  }
  if (/\.(cmd|bat)$/i.test(entry)) {
    return { command: entry.replace(/\\/g, "/"), args: [...args], shell: true };
  }
  return { command: entry, args: [...args], shell: false };
}

/**
 * The prompt every smoke test sends: short enough to cost almost nothing,
 * specific enough that a non-empty answer proves the whole path worked.
 */
export const SMOKE_PROMPT = 'Reply with exactly the two characters: ok';

/**
 * Build the argv for a real end-to-end smoke run of one CLI.
 *
 * These mirror the flags the bridges use in lib/<cli>.mjs. They are duplicated
 * here on purpose: importing lib/pi.mjs & friends would trigger their
 * top-level requireEnv() calls, and doctor's whole job is to run BEFORE the
 * env is known to be correct. See REVIEW.md for the de-duplication proposal.
 *
 * @param {string} cli    "pi" | "agy" | "codex" | "copilot"
 * @param {string} entry  Resolved entry path.
 * @returns {{command: string, args: string[], shell: boolean}}
 */
export function buildSmokeInvocation(cli, entry) {
  switch (cli) {
    case "pi":
      return buildInvocation(entry, ["--mode", "json", "--no-extensions", "-p", SMOKE_PROMPT]);
    case "agy":
      return buildInvocation(entry, [
        "-p",
        SMOKE_PROMPT,
        "--output-format",
        "stream-json",
        "--sandbox",
        "--dangerously-skip-permissions",
        "--print-timeout",
        "60s",
      ]);
    case "codex":
      return buildInvocation(entry, ["exec", "--json", "--skip-git-repo-check", SMOKE_PROMPT]);
    case "copilot":
      return buildInvocation(entry, [
        "-p",
        SMOKE_PROMPT,
        "--output-format",
        "json",
        "--allow-all-tools",
      ]);
    default:
      throw new Error(`No smoke invocation defined for CLI "${cli}"`);
  }
}

// ── Default I/O implementations ──────────────────────────────────────────────

function joinPkg(root, pkgName) {
  return resolvePath(root, ...pkgName.split("/"));
}

async function defaultReadPackageJson(pkgDir) {
  try {
    const raw = await readFile(resolvePath(pkgDir, "package.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function defaultLocalResolve(pkgName) {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(`${pkgName}/package.json`);
    return dirname(manifest);
  } catch {
    return null;
  }
}

function defaultNpmGlobalRoot() {
  // `npm root -g` is the only supported way to ask npm where global packages
  // live; deriving it from PATH breaks under nvm/volta/fnm/Scoop.
  const isWin = process.platform === "win32";
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(isWin ? "npm.cmd" : "npm", ["root", "-g"], {
        stdio: ["ignore", "pipe", "ignore"],
        shell: isWin,
        windowsHide: true,
      });
    } catch {
      return resolve(null);
    }
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      const dir = out.trim().split(/\r?\n/).at(-1) || "";
      resolve(code === 0 && dir && isAbsolute(dir) ? dir : null);
    });
  });
}

function defaultWhich(cmd) {
  const isWin = process.platform === "win32";
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(isWin ? "where" : "which", [cmd], {
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
        windowsHide: true,
      });
    } catch {
      return resolve(null);
    }
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0 || !out.trim()) return resolve(null);
      const lines = out.trim().split(/\r?\n/);
      // Prefer a .cmd shim on Windows: the bare name may be a shell function
      // or a extension-less shim that CreateProcess cannot execute.
      const preferred = isWin ? lines.find((l) => /\.cmd$/i.test(l)) : null;
      resolve(preferred || lines[0]);
    });
  });
}
