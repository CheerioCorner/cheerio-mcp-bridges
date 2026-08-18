#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { runPi, PI_CWD } from "../lib/pi.mjs";
import { appendAudit } from "../lib/audit.mjs";

const server = new McpServer({ name: "pi-bridge", version: "0.1.0" });

server.registerTool(
  "ask_pi",
  {
    title: "Ask the pi coding agent",
    description:
      "Send a prompt to the locally-installed `pi` coding agent (earendil-works/pi) running " +
      `headlessly in a fixed working directory (${PI_CWD}). Returns pi's final answer plus the ` +
      "session_id needed to continue the same conversation. The working directory is pinned by " +
      "the server and CANNOT be changed by the prompt. By default pi may read AND write files in " +
      "that directory; pass read_only:true to restrict it to read-only tools.",
    inputSchema: {
      prompt: z.string().min(1).describe("The instruction/question to send to pi."),
      session_id: z
        .string()
        .optional()
        .describe(
          "Pass the session_id returned by a previous call to continue that same conversation. " +
            "Omit on the first call; the server generates and returns one."
        ),
      read_only: z
        .boolean()
        .optional()
        .describe("If true, restrict pi to read-only tools (read,grep,find,ls) — no edit/write/bash."),
      model: z.string().optional().describe("Optional model pattern/id override for pi."),
      approve_project: z
        .boolean()
        .optional()
        .describe(
          "If true, trust project-local resources (pi -a). Leave false unless you specifically " +
            "need project-local extensions/skills to load."
        ),
      enable_extensions: z
        .boolean()
        .optional()
        .describe(
          "If true, load pi extensions. OFF by default: interactive extensions (e.g. " +
            "auto-annotate/plannotator) HANG a headless run. Only enable if you know the " +
            "loaded extensions are headless-safe."
        ),
      timeout_ms: z.number().int().positive().optional().describe("Hard timeout in ms."),
    },
  },
  async ({ prompt, session_id, read_only, model, approve_project, enable_extensions, timeout_ms }) => {
    const sessionId = session_id || randomUUID();
    let result;
    try {
      result = await runPi({
        prompt,
        sessionId,
        readOnly: read_only,
        model,
        approveProject: approve_project,
        enableExtensions: enable_extensions,
        timeoutMs: timeout_ms,
      });
    } catch (err) {
      await appendAudit("pi", {
        sessionId,
        prompt,
        read_only: !!read_only,
        model,
        approve_project: !!approve_project,
        spawnError: String(err?.message || err),
      });
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to launch pi: ${err?.message || err}` }],
      };
    }

    await appendAudit("pi", {
      sessionId: result.sessionId,
      prompt,
      read_only: !!read_only,
      model,
      approve_project: !!approve_project,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      hadError: result.hadError,
      toolCalls: result.toolCalls,
      usage: result.usage,
      durationMs: result.durationMs,
    });

    const meta = {
      session_id: result.sessionId,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      tools_used: result.toolCalls.map((t) => t.name),
      usage: result.usage,
    };
    const body =
      (result.text || "(pi returned no text)") +
      "\n\n---\n" +
      "pi-bridge metadata: " +
      JSON.stringify(meta);

    return {
      isError: result.hadError,
      content: [{ type: "text", text: body }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
