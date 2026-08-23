#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runAgy, AGY_CWD } from "../lib/agy.mjs";
import { appendAudit } from "../lib/audit.mjs";
import {
  checkAvailability as defaultCheck,
  recordBlocked as defaultRecord,
  clearBlocked as defaultClear,
  resetProbeClaimedUntil as defaultResetProbe,
} from "../lib/availability.mjs";
import { createAskAgyHandler } from "../lib/agy-handler.mjs";

// ── Production setup ────────────────────────────────────────────────────────

const server = new McpServer({ name: "agy-bridge", version: "0.1.0" });
const askAgy = createAskAgyHandler({
  run: runAgy,
  audit: appendAudit,
  checkAvailability: defaultCheck,
  recordBlocked: defaultRecord,
  clearBlocked: defaultClear,
  resetProbeClaimedUntil: defaultResetProbe,
});

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
  askAgy
);

const transport = new StdioServerTransport();
await server.connect(transport);
