#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runClaude, CLAUDE_CWD } from "../lib/claude.mjs";
import { appendAudit } from "../lib/audit.mjs";
import {
  checkAvailability as defaultCheck,
  recordBlocked as defaultRecord,
  clearBlocked as defaultClear,
  resetProbeClaimedUntil as defaultResetProbe,
} from "../lib/availability.mjs";
import { createAskClaudeHandler } from "../lib/claude-handler.mjs";

// ── Production setup ────────────────────────────────────────────────────────

const server = new McpServer({ name: "claude-bridge", version: "0.1.0" });
const askClaude = createAskClaudeHandler({
  run: runClaude,
  audit: appendAudit,
  checkAvailability: defaultCheck,
  recordBlocked: defaultRecord,
  clearBlocked: defaultClear,
  resetProbeClaimedUntil: defaultResetProbe,
});

server.registerTool(
  "ask_claude",
  {
    title: "Ask the Claude Code CLI",
    description:
      "Send a prompt to the locally-installed Claude Code CLI (`claude`) running headlessly in a " +
      `fixed working directory (${CLAUDE_CWD}). Returns Claude's final answer plus the session_id ` +
      "needed to continue the same conversation. The working directory is pinned by the server and " +
      "CANNOT be changed by the prompt. " +
      "PERMISSIONS: by default Claude may READ but every write/exec is denied automatically — set " +
      "allow_edits:true if it should be able to change files. Denied tool calls are reported in " +
      "the metadata AND called out in the reply, because Claude will otherwise describe work it " +
      "was not permitted to do. " +
      "The bridge runs claude with --safe-mode and --strict-mcp-config, so the user's hooks, " +
      "plugins, CLAUDE.md and MCP servers (including these bridges) are NOT loaded.",
    inputSchema: {
      prompt: z.string().min(1).describe("The instruction/question to send to Claude."),
      session_id: z
        .string()
        .optional()
        .describe(
          "Pass the session_id returned by a previous call to continue that same conversation. " +
            "Omit on the first call; the server generates one and returns it."
        ),
      read_only: z
        .boolean()
        .optional()
        .describe(
          "If true, run with --restricted: removes Bash/PowerShell/REPL and WebFetch entirely and " +
            "confines the file tools to the working directory. Use for pure analysis/review."
        ),
      allow_edits: z
        .boolean()
        .optional()
        .describe(
          "If true, auto-approve file edits (--permission-mode acceptEdits). Default false: reads " +
            "work, writes are denied. Set this when you actually want Claude to change files."
        ),
      dangerously_allow_all: z
        .boolean()
        .optional()
        .describe(
          "DANGER: --permission-mode bypassPermissions — no permission checks at all, including " +
            "arbitrary shell commands in the pinned working directory. Leave false unless that " +
            "directory is disposable."
        ),
      model: z
        .string()
        .optional()
        .describe("Model alias ('haiku', 'sonnet', 'opus') or a full model id."),
      effort: z
        .enum(["low", "medium", "high", "xhigh", "max"])
        .optional()
        .describe("Reasoning effort for this run."),
      max_budget_usd: z
        .number()
        .positive()
        .optional()
        .describe("Hard spending cap for this single call (--max-budget-usd). Unset = no cap."),
      timeout_ms: z.number().int().positive().optional().describe("Hard timeout in ms."),
    },
  },
  askClaude
);

const transport = new StdioServerTransport();
await server.connect(transport);
