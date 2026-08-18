#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runAgy, AGY_CWD } from "../lib/agy.mjs";
import { appendAudit } from "../lib/audit.mjs";

const server = new McpServer({ name: "agy-bridge", version: "0.1.0" });

server.registerTool(
  "ask_agy",
  {
    title: "Ask the Antigravity (Gemini) coding agent",
    description:
      "Send a prompt to the locally-installed Antigravity CLI `agy` (Google/Gemini) running " +
      `headlessly in a fixed workspace (${AGY_CWD}). Returns agy's final response plus the ` +
      "conversation_id needed to continue the same conversation. The workspace is pinned by the " +
      "server and CANNOT be changed by the prompt. Reading and writing files inside the workspace " +
      "is auto-allowed; shell commands stay gated unless dangerously_allow_all is set.",
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
          "DANGER: auto-approve ALL tool permission requests including shell commands " +
            "(--dangerously-skip-permissions). Leave false unless you fully trust the prompt."
        ),
      timeout_ms: z.number().int().positive().optional().describe("Hard timeout in ms."),
    },
  },
  async ({ prompt, conversation_id, model, effort, sandbox, dangerously_allow_all, timeout_ms }) => {
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
        sandbox: !!sandbox,
        dangerously_allow_all: !!dangerously_allow_all,
        spawnError: String(err?.message || err),
      });
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to launch agy: ${err?.message || err}` }],
      };
    }

    await appendAudit("agy", {
      conversationId: result.conversationId,
      prompt,
      sandbox: !!sandbox,
      dangerously_allow_all: !!dangerously_allow_all,
      status: result.status,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      hadError: result.hadError,
      toolCalls: result.toolCalls,
      numTurns: result.numTurns,
      usage: result.usage,
      durationMs: result.durationMs,
    });

    const meta = {
      conversation_id: result.conversationId,
      status: result.status,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      num_turns: result.numTurns,
      tools_used: result.toolCalls,
      usage: result.usage,
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
