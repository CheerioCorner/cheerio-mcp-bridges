#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { runCodex, CODEX_CWD } from "../lib/codex.mjs";
import { appendAudit } from "../lib/audit.mjs";

/**
 * Truncate a string to maxLen characters, keeping the HEAD (where errors usually are).
 * Appends a visible marker when truncation occurs.
 */
function truncate(s, maxLen) {
  if (!s || s.length <= maxLen) return s || null;
  return s.slice(0, maxLen) + "... (truncated)";
}

const server = new McpServer({ name: "codex-bridge", version: "0.1.0" });

server.registerTool(
  "ask_codex",
  {
    title: "Ask the OpenAI Codex CLI",
    description:
      "Send a prompt to the locally-installed OpenAI Codex CLI running " +
      `headlessly in a fixed working directory (${CODEX_CWD}). Returns Codex's final answer plus the ` +
      "thread_id needed to continue the same conversation. The working directory is pinned by " +
      "the server and CANNOT be changed by the prompt. By default runs in read-only sandbox " +
      "(no file writes).",
    inputSchema: {
      prompt: z.string().min(1).describe("The instruction/question to send to Codex."),
      session_id: z
        .string()
        .optional()
        .describe(
          "Pass the thread_id returned by a previous call to continue that same conversation. " +
            "Omit on the first call; the server generates and returns one."
        ),
      model: z.string().optional().describe("Optional model override (e.g. 'o3', 'codex-mini')."),
      sandbox: z
        .enum(["read-only", "workspace-write", "danger-full-access"])
        .optional()
        .describe("Sandbox policy. Default: read-only (safest)."),
      timeout_ms: z.number().int().positive().optional().describe("Hard timeout in ms."),
    },
  },
  async ({ prompt, session_id, model, sandbox, timeout_ms }) => {
    const threadId = session_id || randomUUID();
    let result;
    try {
      result = await runCodex({
        prompt,
        sessionId: session_id || undefined,
        model,
        sandbox: sandbox || "read-only",
        timeoutMs: timeout_ms,
      });
    } catch (err) {
      await appendAudit("codex", {
        threadId,
        prompt,
        model,
        sandbox: sandbox || "read-only",
        spawnError: String(err?.message || err),
      });
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to launch codex: ${err?.message || err}` }],
      };
    }

    const stderrSnippet = result.stderr ? truncate(result.stderr, 2000) : null;

    await appendAudit("codex", {
      threadId: result.threadId || threadId,
      prompt,
      model,
      sandbox: sandbox || "read-only",
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      hadError: result.hadError,
      stderr: stderrSnippet,
      usage: result.usage,
      durationMs: result.durationMs,
    });

    const meta = {
      thread_id: result.threadId || threadId,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      stderr: stderrSnippet,
      usage: result.usage,
    };
    const body =
      (result.text || stderrSnippet || "(codex returned no text)") +
      "\n\n---\n" +
      "codex-bridge metadata: " +
      JSON.stringify(meta);

    return {
      isError: result.hadError,
      content: [{ type: "text", text: body }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
