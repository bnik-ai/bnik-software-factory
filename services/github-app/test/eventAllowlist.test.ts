import { describe, expect, test } from 'vitest';
import { GITHUB_WEBHOOK_EVENTS, NOISE_DROP_EVENTS } from '../src/eventAllowlist.js';

describe('eventAllowlist — noise isolation', () => {
  test('noise events stay ALLOWED (subscribed — a 400 would mark deliveries failed) but classified for drop', () => {
    for (const noisy of NOISE_DROP_EVENTS) {
      expect(GITHUB_WEBHOOK_EVENTS.has(noisy), `${noisy} must stay in the allowlist`).toBe(true);
    }
  });

  test('CI/dev noise events are classified for the route drop', () => {
    for (const noisy of [
      'push',
      'workflow_run',
      'workflow_job',
      'check_run',
      'check_suite',
      'release',
      'projects_v2_item',
      'repository_dispatch',
    ]) {
      expect(NOISE_DROP_EVENTS.has(noisy), `${noisy} should be noise-dropped`).toBe(true);
    }
  });

  test('FSM-bearing + lifecycle events are never noise-dropped', () => {
    for (const kept of [
      'installation',
      'installation_repositories',
      'issues',
      'issue_comment',
      'pull_request',
      'pull_request_review',
      'pull_request_review_comment',
      'deployment',
      'deployment_status',
      'ping',
    ]) {
      expect(NOISE_DROP_EVENTS.has(kept), `${kept} must not be dropped`).toBe(false);
      expect(GITHUB_WEBHOOK_EVENTS.has(kept), `${kept} must be allowed`).toBe(true);
    }
  });
});
