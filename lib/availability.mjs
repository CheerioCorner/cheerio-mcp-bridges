/**
 * Availability registry — shared across all four MCP bridge processes.
 *
 * Every bridge records rate-limit events here so that a subsequent request
 * can bail out early instead of spawning a CLI that is known to be blocked.
 *
 * Threading model:
 *   Four independent Node processes may read/write the same JSON file.
 *   We use an fs.mkdir()-based lock (atomic on all platforms) to serialise
 *   writes.  Reads take a fast path (no lock) unless they need to perform
 *   a probe claim (which is a write).
 */

import { readFile, writeFile, mkdir, rm, stat, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

// ── Path constants (relative to *this* file, not cwd) ──────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const STATE_DIR = join(__dir, "..", "state");
const STATE_FILE = join(STATE_DIR, "availability.json");
const LOCK_DIR = join(STATE_DIR, "availability.lock");

// ── Helpers ─────────────────────────────────────────────────────────────────

function emptyState() {
  return { version: 1, updated_at: new Date().toISOString(), entries: {} };
}

function isExpired(entry, now) {
  if (!entry.blocked_until) return false; // null = permanent (human-reported)
  return now >= new Date(entry.blocked_until);
}

function isHumanReportedActive(entry, now) {
  if (entry.confidence !== "human-reported") return false;
  return entry.blocked_until === null || now < new Date(entry.blocked_until);
}

// ── Lock helpers ────────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 60_000;
const LOCK_JSON_MISSING_THRESHOLD_MS = 10_000;

async function acquireLock(lockDir, maxWaitMs = 2000) {
  const start = Date.now();
  // Ensure parent exists (on Windows, temp dirs can be cleaned up between tests).
  await mkdir(dirname(lockDir), { recursive: true }).catch(() => {});
  while (true) {
    try {
      await mkdir(lockDir);
      const lockFile = join(lockDir, "lock.json");
      await writeFile(
        lockFile,
        JSON.stringify({ pid: process.pid, recorded_at: new Date().toISOString() }),
        "utf8"
      );
      return;
    } catch (err) {
      if (!isLockError(err)) throw err;

      try {
        const st = await stat(lockDir);
        const age = Date.now() - st.mtimeMs;
        if (age > STALE_THRESHOLD_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
        try {
          await readFile(join(lockDir, "lock.json"), "utf8");
        } catch {
          if (age > LOCK_JSON_MISSING_THRESHOLD_MS) {
            await rm(lockDir, { recursive: true, force: true });
            continue;
          }
        }
      } catch {
        // stat failed, retry
      }

      if (Date.now() - start >= maxWaitMs) {
        throw new Error(`Could not acquire availability lock after ${maxWaitMs}ms`);
      }
      await sleep(25 + Math.random() * 50);
    }
  }
}

async function releaseLock(lockDir) {
  await rm(lockDir, { recursive: true, force: true });
}

function isLockError(err) {
  if (err.code === "EEXIST") return true;
  if (process.platform === "win32" && (err.code === "EACCES" || err.code === "EPERM")) {
    return true;
  }
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an isolated availability store (useful for tests).
 *
 * @param {object} opts
 * @param {string} [opts.stateFile]  Path to the JSON state file.
 * @param {string} [opts.lockDir]    Path to the lock directory.
 * @param {() => Date} [opts.now]    Clock function (default: `() => new Date()`).
 */
export function createAvailabilityStore({ stateFile = STATE_FILE, lockDir = LOCK_DIR, now } = {}) {
  const getNow = now || (() => new Date());

  async function readState() {
    const raw = await readFile(stateFile, "utf8");
    return JSON.parse(raw);
  }

  async function readStateSafe() {
    try {
      return await readState();
    } catch (err) {
      if (err.code === "ENOENT") return emptyState();
      return { _corrupt: true, _error: err };
    }
  }

  async function writeState(state) {
    state.updated_at = new Date().toISOString();
    const tmp = `${stateFile}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
        await rename(tmp, stateFile);
        return;
      } catch (err) {
        if (attempt < 2) {
          await sleep(10 + Math.random() * 20);
        } else {
          throw err;
        }
      }
    }
  }

  async function backupCorrupt() {
    const backupPath = `${stateFile}.corrupt.${Date.now()}`;
    try {
      const raw = await readFile(stateFile, "utf8");
      await writeFile(backupPath, raw, "utf8");
    } catch {
      // skip
    }
  }

  // ── Lock + read-modify-write ────────────────────────────────────────────

  async function withLock(fn) {
    await acquireLock(lockDir);
    try {
      return await fn();
    } finally {
      await releaseLock(lockDir);
    }
  }

  /**
   * Read state under lock, let caller mutate, then write back.
   * @param {(state: object, wasCorrupt: boolean) => object} fn  Must return the (possibly mutated) state.
   */
  async function readModifyWrite(fn) {
    return withLock(async () => {
      let state = await readStateSafe();
      if (state._corrupt) {
        state = emptyState();
        const result = await fn(state, true);
        // If fn returned a reject-result, don't write.
        if (result && result.action === "reject") return result;
        await writeState(state);
        return result || state;
      }
      const result = await fn(state, false);
      if (result && result.action === "reject") return result;
      await writeState(state);
      return result || state;
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async function checkAvailability(name) {
    const now = getNow();

    // Fast read path (no lock).
    let state;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        state = await readStateSafe();
        break;
      } catch {
        if (attempt < 2) await sleep(5 + Math.random() * 10);
      }
    }
    if (!state) {
      return { allowed: false, blocked: false, probe: false, entry: null, stateError: true };
    }
    if (state._corrupt) {
      return { allowed: false, blocked: false, probe: false, entry: null, stateError: true };
    }

    const entry = state.entries[name];
    if (!entry) {
      return { allowed: true, blocked: false, probe: false, entry: null };
    }

    // ── Human-reported ──────────────────────────────────────────────────
    if (entry.confidence === "human-reported") {
      if (entry.blocked_until === null) {
        return { allowed: false, blocked: true, probe: false, entry };
      }
      if (now < new Date(entry.blocked_until)) {
        return { allowed: false, blocked: true, probe: false, entry };
      }
      // Expired human-reported → allowed, no probe logic.
      return { allowed: true, blocked: false, probe: false, entry };
    }

    // ── Exact ───────────────────────────────────────────────────────────
    if (entry.confidence === "exact") {
      if (now < new Date(entry.blocked_until)) {
        return { allowed: false, blocked: true, probe: false, entry };
      }
      // Expired → auto-clear and allow.
      await readModifyWrite((state) => {
        delete state.entries[name];
        return state;
      });
      return { allowed: true, blocked: false, probe: false, entry: null };
    }

    // ── Estimated ───────────────────────────────────────────────────────
    if (entry.confidence === "estimated") {
      if (now < new Date(entry.blocked_until)) {
        return { allowed: false, blocked: true, probe: false, entry };
      }
      // Expired → try to claim probe via lock.
      const claimed = await withLock(async () => {
        const s = await readStateSafe();
        if (s._corrupt) return false;
        const e = s.entries[name];
        if (!e) return false;
        if (e.probe_claimed_until && now < new Date(e.probe_claimed_until)) {
          return false;
        }
        e.probe_claimed_until = new Date(now.getTime() + 60_000).toISOString();
        await writeState(s);
        return true;
      });
      if (claimed) {
        // Re-read to get the updated entry for the return value.
        const finalState = await readStateSafe().catch(() => null);
        const finalEntry = finalState?.entries?.[name] || entry;
        return { allowed: true, blocked: true, probe: true, entry: finalEntry };
      }
      return { allowed: false, blocked: true, probe: false, entry };
    }

    // Unknown confidence → fail closed.
    return { allowed: false, blocked: false, probe: false, entry: null, stateError: true };
  }

  async function recordBlocked(name, {
    reason,
    confidence = "estimated",
    blockedUntil = null,
    retryAfterSeconds,
    recordedBy = name,
  } = {}) {
    const now = getNow();

    // Resolve blockedUntil from retryAfterSeconds if provided.
    if (retryAfterSeconds != null && retryAfterSeconds > 0) {
      blockedUntil = new Date(now.getTime() + retryAfterSeconds * 1000).toISOString();
    }

    // exact requires blockedUntil — if missing, downgrade to estimated.
    if (confidence === "exact" && !blockedUntil) {
      confidence = "estimated";
    }

    // estimated without blockedUntil → default 1 hour.
    if (confidence === "estimated" && !blockedUntil) {
      blockedUntil = new Date(now.getTime() + 3600_000).toISOString();
    }

    return readModifyWrite((state, wasCorrupt) => {
      if (wasCorrupt) {
        // Will be backed up by caller after this returns.
        state.entries[name] = {
          blocked_until: blockedUntil,
          reason: reason || null,
          confidence,
          recorded_by: recordedBy,
          recorded_at: now.toISOString(),
          probe_claimed_until: null,
        };
        return { action: "write", backupNeeded: true };
      }

      const existing = state.entries[name];

      // No existing entry or expired (non human-reported) → write new.
      if (!existing || isExpired(existing, now)) {
        state.entries[name] = {
          blocked_until: blockedUntil,
          reason: reason || null,
          confidence,
          recorded_by: recordedBy,
          recorded_at: now.toISOString(),
          probe_claimed_until: null,
        };
        return { action: "write" };
      }

      // 1. Active human-reported → reject override.
      if (isHumanReportedActive(existing, now)) {
        return { action: "reject", reason: "human-reported entry active" };
      }

      // 2. Active exact → only newer exact can override.
      if (existing.confidence === "exact") {
        if (confidence === "exact" && new Date(blockedUntil) > new Date(existing.blocked_until)) {
          state.entries[name] = {
            blocked_until: blockedUntil,
            reason: reason || null,
            confidence,
            recorded_by: recordedBy,
            recorded_at: now.toISOString(),
            probe_claimed_until: null,
          };
          return { action: "write" };
        }
        return { action: "reject", reason: "active exact entry cannot be overridden by estimated" };
      }

      // 3. Active estimated → any exact wins; estimated keeps later time.
      if (existing.confidence === "estimated") {
        if (confidence === "exact") {
          state.entries[name] = {
            blocked_until: blockedUntil,
            reason: reason || null,
            confidence,
            recorded_by: recordedBy,
            recorded_at: now.toISOString(),
            probe_claimed_until: null,
          };
          return { action: "write" };
        }
        // Both estimated: keep the later blocked_until.
        if (new Date(blockedUntil) > new Date(existing.blocked_until)) {
          state.entries[name] = {
            blocked_until: blockedUntil,
            reason: reason || null,
            confidence,
            recorded_by: recordedBy,
            recorded_at: now.toISOString(),
            probe_claimed_until: null,
          };
          return { action: "write" };
        }
        return { action: "reject", reason: "existing estimated has later blocked_until" };
      }

      // Fallback: write.
      state.entries[name] = {
        blocked_until: blockedUntil,
        reason: reason || null,
        confidence,
        recorded_by: recordedBy,
        recorded_at: now.toISOString(),
        probe_claimed_until: null,
      };
      return { action: "write" };
    }).then(async (result) => {
      if (result?.action === "reject") {
        return { overridden: false, reason: result.reason };
      }
      if (result?.backupNeeded) {
        await backupCorrupt();
      }
      return { overridden: true };
    });
  }

  async function clearBlocked(name) {
    await readModifyWrite((state) => {
      delete state.entries[name];
      return state;
    });
  }

  async function resetProbeClaimedUntil(name) {
    await readModifyWrite((state) => {
      const entry = state.entries[name];
      if (entry) {
        entry.probe_claimed_until = null;
      }
      return state;
    });
  }

  return { checkAvailability, recordBlocked, clearBlocked, resetProbeClaimedUntil };
}

// ── Production singleton ────────────────────────────────────────────────────

const store = createAvailabilityStore();

export function availabilityKey(bridgeName, model) {
  return `${bridgeName}:${model || "default"}`;
}

export async function checkAvailability(name, options) {
  return store.checkAvailability(name, options);
}

export async function recordBlocked(name, options) {
  return store.recordBlocked(name, options);
}

export async function clearBlocked(name) {
  return store.clearBlocked(name);
}

export async function resetProbeClaimedUntil(name) {
  return store.resetProbeClaimedUntil(name);
}
