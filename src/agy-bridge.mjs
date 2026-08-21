#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runAgy, AGY_CWD } from "../lib/agy.mjs";
import { appendAudit } from "../lib/audit.mjs";

/**
 * Truncate a string to maxLen characters, keeping the HEAD where errors usually are.
 * Appends a visible marker when truncation occurs.
 */
function truncate(s, maxLen) {
  if (!s || s.length <= maxLen) return s || null;
  return s.slice(0, maxLen) + "... (truncated)";
}

const server = new McpServer({ name: "agy-bridge", version: "0.1.0" });

server.registerTool(
  "ask_agy",
  {
    title: "Ask the Antigravity (Gemini) coding agent",
    description:
      "Send a prompt to the locally-installed Antigravity CLI `agy` (Google/Gemini) running " +
      `headlessly in a fixed workspace (${AGY_CWD}). Returns agy's final response plus the ` +
      "conversation_id needed to continue the same conversation. The workspace is pinned by the " +
      "server and CANNOT be changed by the prompt. In headless mode, all tool permissions are " +
      "auto-approved by default to avoid intermittent CANCELED/ERROR failures; terminal/shell " +
      "execution remains constrained by --sandbox. Callers can override the defaults with " +
      "dangerously_allow_all: false or sandbox: false.",
    inputSchema: {
      prompt: z.string().min(1).describe("The instruction/question to send to agy."),
      conversation_id: z
        .string()
        .optional()
        .describe(
          "Pass the conversation_id returned by a previous call to continue it. Omit on the first " +
            "call; the server captures and returns one."
        ),
      model: z.string().optional().describe("Optional model slug (see `agy models`)."),
      effort: z
        .enum(["low", "medium", "high"])
        .optional()
        .describe("Reasoning effort level."),
      sandbox: z
        .boolean()
        .optional()
        .describe("If true, run agy with terminal sandbox restrictions (--sandbox)."),
      dangerously_allow_all: z
        .boolean()
        .optional()
        .describe(
          "Default: true. Auto-approve ALL tool permission requests " +
            "(--dangerously-skip-permissions) to prevent headless CANCELED/ERROR failures. " +
            "Set false to restore permission gating; terminal/shell execution is still limited " +
            "by --sandbox unless sandbox is explicitly set to false."
        ),
      timeout_ms: z.number().int().positive().optional().describe("Hard timeout in ms."),
    },
  },
  async ({ prompt, conversation_id, model, effort, sandbox, dangerously_allow_all, timeout_ms }) => {
    const effectiveSandbox = sandbox !== false;
    const effectiveDangerouslyAllowAll = dangerously_allow_all !== false;
    let result;
    try {
      result = await runAgy({
        prompt,
        conversationId: conversation_id,
        model,
        effort,
        sandbox,
        dangerouslyAllowAll: dangerously_allow_all,
        timeoutMs: timeout_ms,
      });
    } catch (err) {
      await appendAudit("agy", {
        conversationId: conversation_id,
        prompt,
        sandbox: effectiveSandbox,
        dangerously_allow_all: effectiveDangerouslyAllowAll,
        spawnError: String(err?.message || err),
      });
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to launch agy: ${err?.message || err}` }],
      };
    }

    const stderrSnippet = truncate(result.stderr, 2000);

    await appendAudit("agy", {
      conversationId: result.conversationId,
      prompt,
      sandbox: effectiveSandbox,
      dangerously_allow_all: effectiveDangerouslyAllowAll,
      status: result.status,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      hadError: result.hadError,
      toolCalls: result.toolCalls,
      numTurns: result.numTurns,
      usage: result.usage,
      durationMs: result.durationMs,
      stderr: stderrSnippet,
    });

    const meta = {
      conversation_id: result.conversationId,
      status: result.status,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      num_turns: result.numTurns,
      tools_used: result.toolCalls,
      usage: result.usage,
      stderr: stderrSnippet,
    };
    const body =
      (result.response?.trim() || result.error || "(agy returned no text)") +
      "\n\n---\n" +
      "agy-bridge metadata: " +
      JSON.stringify(meta);

    return {
      isError: result.hadError,
      content: [{ type: "text", text: body }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
