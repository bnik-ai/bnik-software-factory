/**
 * OSS-22: what an attempt cost as the SDK estimated it, and what the reviewer consumed. The
 * model lane accounts its spend from these printed views, never from the database, and a
 * budget figure is an estimate ceiling (evals/qualification-protocol.json `limits`).
 */
export function costView(run: { evidence: Record<string, unknown> }): {
  estimatedUsd: number | null;
  reviewUsage: Record<string, number> | null;
} {
  const estimated = run.evidence.estimatedUsd;
  const usage = run.evidence.reviewUsage;
  return {
    estimatedUsd:
      typeof estimated === 'number' && Number.isFinite(estimated) && estimated >= 0
        ? estimated
        : null,
    reviewUsage:
      usage && typeof usage === 'object' && !Array.isArray(usage)
        ? Object.fromEntries(
            Object.entries(usage as Record<string, unknown>).filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0,
            ),
          )
        : null,
  };
}
