import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildChildEnv, PROXY_KEYS } from "../lib/run.mjs";

// ── Platform-aware helpers ───────────────────────────────────────────────────
// On Windows, process.env is case-insensitive: HTTP_PROXY and http_proxy refer
// to the same key. We detect the platform and adjust test data accordingly.

const IS_WIN = process.platform === "win32";

// Keys we'll set in process.env to exercise proxy stripping.
// On Windows we use only the UPPER-case variants (they cover both casings).
// On POSIX we set both casings independently.
const PROXY_KEYS_TO_SET = IS_WIN
  ? { HTTP_PROXY: "http://proxy.corp.example:8080", HTTPS_PROXY: "http://proxy.corp.example:8443", ALL_PROXY: "socks5://proxy.corp.example:1080" }
  : { HTTP_PROXY: "http://proxy.corp.example:8080", HTTPS_PROXY: "http://proxy.corp.example:8443", ALL_PROXY: "socks5://proxy.corp.example:1080", http_proxy: "http://proxy.corp.example:8080", https_proxy: "http://proxy.corp.example:8443", all_proxy: "socks5://proxy.corp.example:1080" };

const PROXY_ENV_KEYS = Object.keys(PROXY_KEYS_TO_SET);

const TEST_UNRELATED_KEY = "BRIDGE_TEST_UNRELATED_VAR";

// ── Lifecycle ────────────────────────────────────────────────────────────────

const saved = {};

function saveEnv(keys) {
  for (const k of keys) saved[k] = process.env[k];
}

function restoreEnv(keys) {
  for (const k of keys) {
    if (saved[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = saved[k];
    }
    delete saved[k];
  }
}

beforeEach(() => {
  saveEnv([...PROXY_ENV_KEYS, TEST_UNRELATED_KEY, "BRIDGE_BYPASS_PROXY"]);
  // Populate proxy keys and an unrelated key.
  for (const [k, v] of Object.entries(PROXY_KEYS_TO_SET)) {
    process.env[k] = v;
  }
  process.env[TEST_UNRELATED_KEY] = "keep-me";
  // Default: bypass proxy ON (strip proxy keys).
  delete process.env.BRIDGE_BYPASS_PROXY;
});

afterEach(() => {
  restoreEnv([...PROXY_ENV_KEYS, TEST_UNRELATED_KEY, "BRIDGE_BYPASS_PROXY"]);
});

// ── Tests ────────────────────────────────────────────────────────────────────

test("buildChildEnv: default strips all proxy keys, keeps unrelated vars", () => {
  const childEnv = buildChildEnv();

  for (const k of PROXY_ENV_KEYS) {
    assert.equal(childEnv[k], undefined, `${k} should be stripped`);
  }
  assert.equal(childEnv[TEST_UNRELATED_KEY], "keep-me");
});

test("buildChildEnv: BRIDGE_BYPASS_PROXY=undefined strips proxy (default is ON)", () => {
  // BRIDGE_BYPASS_PROXY is already deleted in beforeEach.
  const childEnv = buildChildEnv();

  for (const k of PROXY_ENV_KEYS) {
    assert.equal(childEnv[k], undefined, `${k} should be stripped when unset`);
  }
});

test("buildChildEnv: BRIDGE_BYPASS_PROXY=true strips proxy", () => {
  process.env.BRIDGE_BYPASS_PROXY = "true";
  const childEnv = buildChildEnv();

  for (const k of PROXY_ENV_KEYS) {
    assert.equal(childEnv[k], undefined, `${k} should be stripped when BRIDGE_BYPASS_PROXY=true`);
  }
});

test("buildChildEnv: BRIDGE_BYPASS_PROXY=false preserves proxy keys", () => {
  // Explicitly set everything RIGHT BEFORE the call to avoid test-ordering issues.
  for (const [k, v] of Object.entries(PROXY_KEYS_TO_SET)) {
    process.env[k] = v;
  }
  process.env.BRIDGE_BYPASS_PROXY = "false";

  const childEnv = buildChildEnv();

  for (const [k, v] of Object.entries(PROXY_KEYS_TO_SET)) {
    assert.equal(childEnv[k], v, `${k} should be preserved when BRIDGE_BYPASS_PROXY=false`);
  }
  assert.equal(childEnv[TEST_UNRELATED_KEY], "keep-me");
});

test("buildChildEnv: BRIDGE_BYPASS_PROXY=anythingOtherThanFalse also strips (not just 'true')", () => {
  for (const val of ["1", "yes", "TRUE", "on", ""]) {
    process.env.BRIDGE_BYPASS_PROXY = val;
    const childEnv = buildChildEnv();
    for (const k of PROXY_ENV_KEYS) {
      assert.equal(childEnv[k], undefined, `${k} should be stripped when BRIDGE_BYPASS_PROXY=${JSON.stringify(val)}`);
    }
  }
});

test("buildChildEnv: process.env is NEVER mutated (critical regression test)", () => {
  // Record the values before calling buildChildEnv.
  const before = {};
  for (const k of [...PROXY_ENV_KEYS, TEST_UNRELATED_KEY]) {
    before[k] = process.env[k];
  }

  // Default mode: buildChildEnv will strip proxy keys from the RETURNED object.
  const childEnv = buildChildEnv();

  // Verify the returned object had proxy keys stripped.
  for (const k of PROXY_ENV_KEYS) {
    assert.equal(childEnv[k], undefined, `returned object should not have ${k}`);
  }

  // Verify process.env is completely untouched.
  for (const k of [...PROXY_ENV_KEYS, TEST_UNRELATED_KEY]) {
    assert.equal(process.env[k], before[k], `process.env.${k} was mutated!`);
  }
});

test("buildChildEnv: envOverride is merged on top of process.env", () => {
  const childEnv = buildChildEnv({ MY_CUSTOM_VAR: "hello", HTTPS_PROXY: "http://override:9999" });

  // Custom var should be present.
  assert.equal(childEnv.MY_CUSTOM_VAR, "hello");
  // HTTPS_PROXY override should be stripped by proxy bypass (default ON).
  assert.equal(childEnv.HTTPS_PROXY, undefined);

  // But if bypass is off, the override should win.
  process.env.BRIDGE_BYPASS_PROXY = "false";
  const childEnv2 = buildChildEnv({ MY_CUSTOM_VAR: "hello", HTTPS_PROXY: "http://override:9999" });
  assert.equal(childEnv2.HTTPS_PROXY, "http://override:9999");
  assert.equal(childEnv2.MY_CUSTOM_VAR, "hello");
});

test("buildChildEnv: PROXY_KEYS constant covers expected keys", () => {
  assert.ok(PROXY_KEYS.includes("HTTP_PROXY"));
  assert.ok(PROXY_KEYS.includes("HTTPS_PROXY"));
  assert.ok(PROXY_KEYS.includes("ALL_PROXY"));
  assert.ok(PROXY_KEYS.includes("http_proxy"));
  assert.ok(PROXY_KEYS.includes("https_proxy"));
  assert.ok(PROXY_KEYS.includes("all_proxy"));
  assert.equal(PROXY_KEYS.length, 6);
  // NO_PROXY is intentionally excluded.
  assert.ok(!PROXY_KEYS.includes("NO_PROXY"));
  assert.ok(!PROXY_KEYS.includes("no_proxy"));
});

test("buildChildEnv: returns a plain object (not a reference to process.env)", () => {
  const childEnv = buildChildEnv();
  assert.notEqual(childEnv, process.env);
  // It should be a different object identity.
  childEnv.__TEST_INJECTED = "should-not-affect-parent";
  assert.equal(process.env.__TEST_INJECTED, undefined);
  delete childEnv.__TEST_INJECTED;
});
