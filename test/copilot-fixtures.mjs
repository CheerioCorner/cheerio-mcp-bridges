/**
 * Real copilot --output-format json output captured from
 * `copilot -p "Reply only: pong" --output-format json --allow-all-tools -C C:/Cheerio`.
 *
 * Only the relevant events are included; the full output has many MCP status lines.
 */

/** Successful response fixture (synthesised from observed event types). */
export const COPILOT_SUCCESS = [
  {
    type: "result",
    timestamp: "2026-08-18T00:37:35.224Z",
    sessionId: "1e18e4cd-36af-46ae-8cf2-0ae7517e2445",
    exitCode: 0,
    usage: {
      premiumRequests: 1,
      totalApiDurationMs: 1200,
      sessionDurationMs: 8912,
      codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
    },
  },
]
  .map((o) => JSON.stringify(o))
  .join("\n");

export const COPILOTSessionId = "1e18e4cd-36af-46ae-8cf2-0ae7517e2445";
export const COPILOTUsage = {
  premiumRequests: 1,
  totalApiDurationMs: 1200,
  sessionDurationMs: 8912,
  codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
};

/** Quota exceeded fixture (captured from real output). */
export const COPILOT_QUOTA_ERROR = [
  {
    type: "model.call_failure",
    data: {
      model: "gpt-5-mini",
      statusCode: 402,
      errorMessage: '{"message":"You have exceeded your monthly quota","code":"quota_exceeded"}',
      quotaSnapshots: {
        premium_interactions: {
          isUnlimitedEntitlement: false,
          entitlementRequests: 0,
          usedRequests: 0,
          usageAllowedWithExhaustedQuota: false,
          overage: 0,
          overageAllowedWithExhaustedQuota: false,
          remainingPercentage: 0,
          resetDate: "2026-09-01T00:00:00Z",
        },
        chat: {
          isUnlimitedEntitlement: false,
          entitlementRequests: 200,
          usedRequests: 200,
          usageAllowedWithExhaustedQuota: false,
          overage: 7.2,
          overageAllowedWithExhaustedQuota: false,
          remainingPercentage: 0,
          resetDate: "2026-09-01T00:00:00Z",
        },
      },
    },
  },
  {
    type: "session.error",
    data: {
      errorType: "quota",
      message: "You have exceeded your monthly quota",
      statusCode: 402,
    },
  },
  {
    type: "result",
    sessionId: "1e18e4cd-36af-46ae-8cf2-0ae7517e2445",
    exitCode: 1,
    usage: {
      premiumRequests: 0,
      totalApiDurationMs: 0,
      sessionDurationMs: 8912,
      codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
    },
  },
]
  .map((o) => JSON.stringify(o))
  .join("\n");

export const COPILOT_QuotaError = "You have exceeded your monthly quota";
export const COPILOT_QuotaSnapshots = {
  premium_interactions: {
    isUnlimitedEntitlement: false,
    entitlementRequests: 0,
    usedRequests: 0,
    usageAllowedWithExhaustedQuota: false,
    overage: 0,
    overageAllowedWithExhaustedQuota: false,
    remainingPercentage: 0,
    resetDate: "2026-09-01T00:00:00Z",
  },
  chat: {
    isUnlimitedEntitlement: false,
    entitlementRequests: 200,
    usedRequests: 200,
    usageAllowedWithExhaustedQuota: false,
    overage: 7.2,
    overageAllowedWithExhaustedQuota: false,
    remainingPercentage: 0,
    resetDate: "2026-09-01T00:00:00Z",
  },
};
