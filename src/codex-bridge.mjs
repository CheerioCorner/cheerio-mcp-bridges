#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCodex, CODEX_CWD } from "../lib/codex.mjs";
import { appendAudit } from "../lib/audit.mjs";
import {
  checkAvailability as defaultCheck,
  recordBlocked as defaultRecord,
  clearBlocked as defaultClear,
  resetProbeClaimedUntil as defaultResetProbe,
} from "../lib/availability.mjs";
import { createAskCodexHandler } from "../lib/codex-handler.mjs";

// ── Production setup ────────────────────────────────────────────────────────

const server = new McpServer({ name: "codex-bridge", version: "0.1.0" });
const askCodex = createAskCodexHandler({
  run: runCodex,
  audit: appendAudit,
  checkAvailability: defaultCheck,
  recordBlocked: defaultRecord,
  clearBlocked: defaultClear,
  resetProbeClaimedUntil: defaultResetProbe,
});

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
  askCodex
);

const transport = new StdioServerTransport();
await server.connect(transport);
