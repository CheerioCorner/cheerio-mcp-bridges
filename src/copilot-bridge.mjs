#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { runCopilot, COPILOT_CWD } from "../lib/copilot.mjs";
import { appendAudit } from "../lib/audit.mjs";

const server = new McpServer({ name: "copilot-bridge", version: "0.1.0" });

server.registerTool(
  "ask_copilot",
  {
    title: "Ask the GitHub Copilot CLI",
    description:
      "Send a prompt to the locally-installed GitHub Copilot CLI running " +
      `headlessly in a fixed working directory (${COPILOT_CWD}). Returns Copilot's final answer plus the ` +
      "session_id needed to continue the same conversation. The working directory is pinned by " +
      "the server and CANNOT be changed by the prompt. Non-interactive mode requires " +
      "--allow-all-tools (auto-added); --allow-all (which also enables all paths/URLs) is off " +
      "by default. NOTE: Copilot CLI has no non-interactive command to query remaining " +
      "quota/balance — usage from this call is reported, but the remaining total is not available.",
    inputSchema: {
      prompt: z.string().min(1).describe("The instruction/question to send to Copilot."),
      session_id: z
        .string()
        .optional()
        .describe(
          "Pass the session_id returned by a previous call to continue that same conversation. " +
            "Omit on the first call; the server generates and returns one."
        ),
      model: z.string().optional().describe("Optional model override (e.g. 'claude-haiku-4.5')."),
      effort: z
        .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
        .optional()
        .describe("Reasoning effort level."),
      max_ai_credits: z
        .number()
        .positive()
        .optional()
        .describe("Spending cap for this invocation (--max-ai-credits). Acts as a safety valve."),
      dangerously_allow_all: z
        .boolean()
        .optional()
        .describe(
          "DANGER: add --allow-all which also enables --allow-all-paths and --allow-all-urls " +
            "(not just --allow-all-tools). Leave false unless you fully trust the prompt."
        ),
      timeout_ms: z.number().int().positive().optional().describe("Hard timeout in ms."),
    },
  },
  async ({ prompt, session_id, model, effort, max_ai_credits, dangerously_allow_all, timeout_ms }) => {
    const sessionId = session_id || randomUUID();
    let result;
    try {
      result = await runCopilot({
        prompt,
        sessionId: session_id || undefined,
        model,
        effort,
        maxAiCredits: max_ai_credits,
        dangerouslyAllowAll: dangerously_allow_all,
        timeoutMs: timeout_ms,
      });
    } catch (err) {
      await appendAudit("copilot", {
        sessionId,
        prompt,
        model,
        effort,
        dangerously_allow_all: !!dangerously_allow_all,
        spawnError: String(err?.message || err),
      });
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to launch copilot: ${err?.message || err}` }],
      };
    }

    await appendAudit("copilot", {
      sessionId: result.sessionId || sessionId,
      prompt,
      model,
      effort,
      dangerously_allow_all: !!dangerously_allow_all,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      hadError: result.hadError,
      error: result.error,
      usage: result.usage,
      durationMs: result.durationMs,
      quotaSnapshots: result.quotaSnapshots,
    });

    const meta = {
      session_id: result.sessionId || sessionId,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      error: result.error,
      usage: result.usage,
      quota_snapshots: result.quotaSnapshots,
    };
    const body =
      (result.response?.trim() || result.error || "(copilot returned no text)") +
      "\n\n---\n" +
      "copilot-bridge metadata: " +
      JSON.stringify(meta);

    return {
      isError: result.hadError,
      content: [{ type: "text", text: body }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
