/**
 * What an attempt cost as the SDK estimated it, and what the reviewer consumed. The
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

/**
 * What the autonomy CLI prints when a command fails: the `reason` of an AutonomyError, a GitHub
 * failure or a ConfigurationError (for example
 * base_publication_requires_FACTORY_PUBLICATION_SECRETLESS_CI_attested), otherwise a generic
 * word. A message is never printed, so no library text or token reaches the operator's log.
 */
export function commandFailureReason(error: unknown): string {
  const reason =
    error && typeof error === 'object' ? (error as { reason?: unknown }).reason : undefined;
  return typeof reason === 'string' && /^[A-Za-z0-9_:-]{1,128}$/.test(reason)
    ? reason
    : 'autonomy_command_failed';
}
