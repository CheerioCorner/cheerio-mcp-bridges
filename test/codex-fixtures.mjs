/**
 * Real codex --json output captured from `codex exec --json --skip-git-repo-check -C C:/Cheerio "Reply only: pong"`.
 */

export const CODEX_SUCCESS = [
  { type: "thread.started", thread_id: "01a0124c-3216-7320-9b51-0ba93ab6fbca" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "pong" } },
  {
    type: "turn.completed",
    usage: {
      input_tokens: 17359,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
    },
  },
]
  .map((o) => JSON.stringify(o))
  .join("\n");

export const CODEXThreadId = "01a0124c-3216-7320-9b51-0ba93ab6fbca";
export const CODEXText = "pong";
export const CODEXUsage = {
  input_tokens: 17359,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 5,
  reasoning_output_tokens: 0,
};

/** Minimal error fixture (thread.failed). */
export const CODEX_ERROR = [
  { type: "thread.started", thread_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
  { type: "thread.failed", error: "rate limit exceeded" },
]
  .map((o) => JSON.stringify(o))
  .join("\n");
