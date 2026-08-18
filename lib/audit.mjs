import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultLogDir = join(here, "..", "logs");

/**
 * Append one audit record as a JSON line to logs/<kind>-YYYYMMDD.jsonl.
 * Auditing must never break a tool call, so all errors are swallowed.
 *
 * @param {string} kind    "pi" | "agy"
 * @param {object} record  Arbitrary serialisable audit payload.
 */
export async function appendAudit(kind, record) {
  try {
    const logDir = process.env.MCP_BRIDGE_LOG_DIR || defaultLogDir;
    await mkdir(logDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const file = join(logDir, `${kind}-${day}.jsonl`);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
    await appendFile(file, line, "utf8");
  } catch {
    // never throw from the audit path
  }
}
