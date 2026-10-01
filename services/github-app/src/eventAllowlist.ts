// Allowed `X-GitHub-Event` values for the SF webhook ingestion route.
//
// Two sources, intentionally merged into one set:
//
// 1. The 17 SUBSCRIBED events from docs/design/github-app.md. Keep these in
//    sync with that table; any addition/removal there must update this set in
//    the same PR.
//
// 2. The `ping` event, which GitHub sends on webhook create and on every
//    "Redeliver → Ping" click in the webhook settings UI, regardless of
//    subscription. Not in the design doc's subscription table because it's
//    not a selectable subscription, but rejecting it would make the
//    operator-facing webhook setup UI report failed deliveries on first
//    install — see https://docs.github.com/en/webhooks/webhook-events-and-payloads#ping.
//    Downstream consumers (SB enqueue) decide whether to act on it.
//
// NOISE ISOLATION: on an
// actively-developed target repo (e.g. sample-app), CI/dev events carry NO
// factory FSM transition — every commit/CI run would otherwise flood the
// session-ordered `validator-events` queue, contend with the factory's own
// issue/PR transitions, and break per-record ordering. These events STAY in
// the allowlist (they are still SUBSCRIBED — rejecting them with 400 would
// mark every delivery failed in the App dashboard); the webhook route
// signature-verifies them, then DROPS them with a 2xx before the ledger/
// enqueue (`app.ts` noise-drop branch). Re-classify an event out of this set
// only when an FSM consumes it.
export const NOISE_DROP_EVENTS = new Set<string>([
  'push',
  'release',
  'projects_v2_item',
  'repository_dispatch',
  'workflow_run',
  'workflow_job',
  'check_run',
  'check_suite',
]);

export const GITHUB_WEBHOOK_EVENTS = new Set<string>([
  'installation',
  'installation_repositories',
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'push',
  'release',
  'deployment',
  'deployment_status',
  'projects_v2_item',
  'repository_dispatch',
  'workflow_run',
  'workflow_job',
  'check_run',
  'check_suite',
  'ping',
]);
