import { test } from "node:test";
import assert from "node:assert/strict";
import { killProcessTree, taskkillPath, spawnCapture } from "../lib/run.mjs";

// A stand-in for a ChildProcess. Records what was asked of it.
function fakeChild(pid = 4242) {
  return {
    pid,
    killed: [],
    kill(sig) {
      this.killed.push(sig);
      return true;
    },
  };
}

// A stand-in for a spawned taskkill. `fail` makes it emit 'error'
// asynchronously — the exact Node-24 PATH-lookup failure mode this guards.
function fakeKiller({ fail = false } = {}) {
  const handlers = {};
  const obj = {
    on(evt, fn) {
      handlers[evt] = fn;
      if (evt === "error" && fail) fn(new Error("spawn taskkill ENOENT"));
      return obj;
    },
  };
  return obj;
}

// ── taskkillPath ─────────────────────────────────────────────────────────────

test("taskkillPath: absolute, from %SystemRoot% — never a bare PATH lookup", () => {
  assert.equal(taskkillPath({ SystemRoot: "C:\\Windows" }), "C:\\Windows\\System32\\taskkill.exe");
  assert.equal(taskkillPath({ SystemRoot: "D:\\Win" }), "D:\\Win\\System32\\taskkill.exe");
});

test("taskkillPath: falls back to C:\\Windows when SystemRoot is missing", () => {
  assert.equal(taskkillPath({}), "C:\\Windows\\System32\\taskkill.exe");
});

test("taskkillPath: the returned path is never just 'taskkill'", () => {
  assert.notEqual(taskkillPath({}), "taskkill");
  assert.ok(taskkillPath({}).endsWith("taskkill.exe"));
});

// ── killProcessTree on Windows ───────────────────────────────────────────────

test("windows: kills the whole tree with /T /F at an absolute path", () => {
  const child = fakeChild(1234);
  const calls = [];
  const r = killProcessTree(child, {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    spawnFn: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return fakeKiller();
    },
  });

  assert.equal(r, "taskkill");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "C:\\Windows\\System32\\taskkill.exe");
  assert.deepEqual(calls[0].args, ["/PID", "1234", "/T", "/F"]);
  // /T is the whole point: pi 0.85 spawns server / session-worker grandchildren.
  assert.ok(calls[0].args.includes("/T"), "must walk the process tree");
  assert.equal(calls[0].opts.shell, false, "no shell — the path is already absolute");
  assert.equal(calls[0].opts.windowsHide, true);
  // child.kill() alone would have orphaned the grandchildren.
  assert.deepEqual(child.killed, []);
});

test("windows: an async spawn 'error' falls back to child.kill instead of crashing", () => {
  const child = fakeChild();
  const r = killProcessTree(child, {
    platform: "win32",
    env: {},
    spawnFn: () => fakeKiller({ fail: true }),
  });
  assert.equal(r, "taskkill");
  assert.deepEqual(child.killed, ["SIGKILL"], "the child must still be killed");
});

test("windows: a synchronous spawn throw also falls back, and never propagates", () => {
  const child = fakeChild();
  assert.doesNotThrow(() =>
    killProcessTree(child, {
      platform: "win32",
      env: {},
      spawnFn: () => {
        throw new Error("EACCES");
      },
    })
  );
  assert.deepEqual(child.killed, ["SIGKILL"]);
});

test("windows: an error handler is always attached (unhandled 'error' would crash the bridge)", () => {
  let attached = false;
  killProcessTree(fakeChild(), {
    platform: "win32",
    env: {},
    spawnFn: () => ({
      on(evt) {
        if (evt === "error") attached = true;
      },
    }),
  });
  assert.ok(attached);
});

test("windows: a child with no pid is a no-op, not a taskkill on 'undefined'", () => {
  let spawned = false;
  const r = killProcessTree(
    { pid: undefined, kill: () => {} },
    { platform: "win32", env: {}, spawnFn: () => ((spawned = true), fakeKiller()) }
  );
  assert.equal(r, "noop");
  assert.equal(spawned, false);
});

// ── killProcessTree on POSIX ─────────────────────────────────────────────────

test("posix: signals the child directly and never shells out to taskkill", () => {
  const child = fakeChild();
  let spawned = false;
  const r = killProcessTree(child, {
    platform: "linux",
    spawnFn: () => ((spawned = true), fakeKiller()),
  });
  assert.equal(r, "signal");
  assert.deepEqual(child.killed, ["SIGTERM"]);
  assert.equal(spawned, false);
});

test("posix: honours an explicit signal, and survives killing a dead process", () => {
  const child = fakeChild();
  killProcessTree(child, { platform: "linux", signal: "SIGKILL" });
  assert.deepEqual(child.killed, ["SIGKILL"]);

  const dead = {
    pid: 1,
    kill() {
      throw new Error("ESRCH");
    },
  };
  assert.doesNotThrow(() => killProcessTree(dead, { platform: "linux" }));
});

// ── the timeout path, end to end ─────────────────────────────────────────────

test("spawnCapture: a timeout still resolves with timedOut and captured output", async () => {
  const res = await spawnCapture(
    process.execPath,
    ["-e", "process.stdout.write('partial');setTimeout(()=>{},60000)"],
    { timeoutMs: 700 }
  );
  assert.equal(res.timedOut, true);
  assert.equal(res.stdout, "partial");
  assert.notEqual(res.code, 0, "a killed run must not look successful");
});

test("spawnCapture: a clean run reports code 0 and is not marked timed out", async () => {
  const res = await spawnCapture(process.execPath, ["-e", "process.stdout.write('done')"], {
    timeoutMs: 20000,
  });
  assert.equal(res.code, 0);
  assert.equal(res.timedOut, false);
  assert.equal(res.stdout, "done");
});

test("spawnCapture: stderr is captured even when the process dies immediately", async () => {
  // This is the shape of the pi failure: instant crash, empty stdout, real stderr.
  const res = await spawnCapture(
    process.execPath,
    ["-e", "process.stderr.write('ERR_MODULE_NOT_FOUND');process.exit(1)"],
    { timeoutMs: 20000 }
  );
  assert.equal(res.code, 1);
  assert.equal(res.stdout, "");
  assert.match(res.stderr, /ERR_MODULE_NOT_FOUND/);
});
