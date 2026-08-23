# state/

This directory holds **runtime-only** data for the availability registry.

## Files

| File | In git? | Purpose |
|---|---|---|
| `availability.json` | No | Live state — created and updated automatically by the bridge processes. Never commit this file. |
| `availability.example.json` | Yes | Schema reference — shows what `availability.json` looks like. **Not read by any code.** |
| `availability.lock/` | No | Transient lock directory used for cross-process atomic writes. |

## Availability schema

Each entry in `availability.json` is keyed by `bridge:model` (e.g. `codex:o3`, `codex:default`).

| Field | Type | Description |
|---|---|---|
| `blocked_until` | `string \| null` | ISO 8601 timestamp. `null` only for `human-reported` permanent blocks. |
| `reason` | `string \| null` | Human-readable reason for the block. |
| `confidence` | `"exact" \| "estimated" \| "human-reported"` | How the block was determined. |
| `recorded_by` | `string` | Which bridge or `"human"` recorded this entry. |
| `recorded_at` | `string` | ISO 8601 timestamp of when the entry was written. |
| `probe_claimed_until` | `string \| null` | Internal field — prevents multiple processes from probing simultaneously. |

## Confidence levels

### `exact`

Automatically detected by the rate-limit scanner when the CLI output includes a clear retry-after time (e.g. `Retry-After: 3600`, `retry again in 15 minutes`). The `blocked_until` field is computed from that time.

### `estimated`

Automatically detected when the CLI output signals a rate limit but provides no specific retry time. Defaults to a 1-hour block.

### `human-reported`

Manually inserted by a human who observed a model/host being rate-limited and wants to block it without waiting for automatic detection.

#### How to add a `human-reported` entry

Edit `availability.json` directly and add an entry like:

```json
{
  "version": 1,
  "updated_at": "2026-08-22T08:00:00.000Z",
  "entries": {
    "codex:o3": {
      "blocked_until": null,
      "reason": "Manually observed 429 from OpenAI API dashboard",
      "confidence": "human-reported",
      "recorded_by": "human",
      "recorded_at": "2026-08-22T08:00:00.000Z",
      "probe_claimed_until": null
    }
  }
}
```

- **`blocked_until: null`** means the block is **permanent** — the bridge will keep rejecting calls until a human runs `clearBlocked()` or deletes the entry.
- **`blocked_until: "2026-08-23T00:00:00.000Z"`** means the block expires at that time, after which calls are allowed again (no probe logic for human-reported — the assumption is the human set a reasonable window).

To manually clear a block, delete the entry from `entries` in `availability.json`, or use the `clearBlocked()` API.
