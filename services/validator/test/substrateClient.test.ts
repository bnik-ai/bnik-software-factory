import { describe, expect, test } from 'vitest';
import { InMemorySubstrateClient } from '../src/substrateClient.js';

describe('InMemorySubstrateClient', () => {
  test('getCurrentLabels returns empty array for unseen recordId', async () => {
    const substrate = new InMemorySubstrateClient();
    expect(await substrate.getCurrentLabels('I_unknown')).toEqual([]);
  });

  test('setLabels then getCurrentLabels round-trips the label set', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_1', ['kind:goal', 'status:proposed']);
    const labels = await substrate.getCurrentLabels('I_1');
    expect(new Set(labels)).toEqual(new Set(['kind:goal', 'status:proposed']));
  });

  test('setLabels overwrites prior labels for the same recordId', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_1', ['status:proposed']);
    substrate.setLabels('I_1', ['status:accepted']);
    expect(await substrate.getCurrentLabels('I_1')).toEqual(['status:accepted']);
  });

  test('different records are isolated', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_1', ['status:proposed']);
    substrate.setLabels('I_2', ['status:accepted']);
    expect(await substrate.getCurrentLabels('I_1')).toEqual(['status:proposed']);
    expect(await substrate.getCurrentLabels('I_2')).toEqual(['status:accepted']);
  });

  test('returned labels are a fresh array (mutating it does not affect substrate)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setLabels('I_1', ['status:proposed']);
    const labels = (await substrate.getCurrentLabels('I_1')) as string[];
    labels.push('status:accepted');
    expect(await substrate.getCurrentLabels('I_1')).toEqual(['status:proposed']);
  });

  test('getIssue returns undefined for unseen recordId', async () => {
    const substrate = new InMemorySubstrateClient();
    expect(await substrate.getIssue('I_unknown')).toBeUndefined();
  });

  test('setIssue then getIssue round-trips body + labels', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_1', {
      body: 'parent-goal: I_goal_42\n\nbody',
      labels: ['kind:spec', 'status:drafting'],
    });
    const issue = await substrate.getIssue('I_1');
    expect(issue?.body).toBe('parent-goal: I_goal_42\n\nbody');
    expect(new Set(issue?.labels)).toEqual(new Set(['kind:spec', 'status:drafting']));
  });

  test('getCurrentLabels reflects setIssue labels (single backing store)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_1', { body: 'b', labels: ['kind:goal'] });
    expect(await substrate.getCurrentLabels('I_1')).toEqual(['kind:goal']);
  });

  test('getIssue returned labels are a fresh array (mutating does not affect substrate)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.setIssue('I_1', { body: 'b', labels: ['kind:goal'] });
    const issue = await substrate.getIssue('I_1');
    expect(issue).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: defined-check above.
    (issue!.labels as string[]).push('kind:spec');
    const second = await substrate.getIssue('I_1');
    expect(second?.labels).toEqual(['kind:goal']);
  });

  // Spec: docs/decisions/0010-multi-model-review-loop.md §"Substrate
  // constraints"; docs/design/review-agent.md §3 + §6. Reviews + PR head
  // metadata are read-side surfaces the validator's review-loop assertions
  // consume.

  test('getReviewsForPr returns empty array for an unseen PR', async () => {
    const substrate = new InMemorySubstrateClient();
    expect(await substrate.getReviewsForPr('PR_unknown')).toEqual([]);
  });

  test('seedReview then getReviewsForPr round-trips Review records in insertion order', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.seedReview('PR_1', { recordId: 'REV_a', state: 'changes_requested', body: 'a' });
    substrate.seedReview('PR_1', { recordId: 'REV_b', state: 'approved', body: 'b' });
    const reviews = await substrate.getReviewsForPr('PR_1');
    expect(reviews.map((r) => r.recordId)).toEqual(['REV_a', 'REV_b']);
    expect(reviews.map((r) => r.state)).toEqual(['changes_requested', 'approved']);
  });

  test('different PRs have isolated Review lists', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.seedReview('PR_1', { recordId: 'REV_1', state: 'approved', body: 'x' });
    substrate.seedReview('PR_2', { recordId: 'REV_2', state: 'approved', body: 'y' });
    expect((await substrate.getReviewsForPr('PR_1')).map((r) => r.recordId)).toEqual(['REV_1']);
    expect((await substrate.getReviewsForPr('PR_2')).map((r) => r.recordId)).toEqual(['REV_2']);
  });

  test('getReviewsForPr returned array is a fresh copy (mutating does not affect substrate)', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.seedReview('PR_1', { recordId: 'REV_1', state: 'approved', body: 'x' });
    const reviews = (await substrate.getReviewsForPr('PR_1')) as unknown as Array<{
      recordId: string;
    }>;
    reviews.pop();
    expect(await substrate.getReviewsForPr('PR_1')).toHaveLength(1);
  });

  test('getPullRequest returns undefined for an unseen PR', async () => {
    const substrate = new InMemorySubstrateClient();
    expect(await substrate.getPullRequest('PR_unknown')).toBeUndefined();
  });

  test('seedPullRequest then getPullRequest round-trips head metadata', async () => {
    const substrate = new InMemorySubstrateClient();
    substrate.seedPullRequest('PR_1', {
      headRef: 'sf/T-1/01HZX0000000000000000000AU/build@sonnet-4.5',
      headCommitMessage: 'chore: x\n\nSF-Agent: build@sonnet-4.5',
    });
    const pr = await substrate.getPullRequest('PR_1');
    expect(pr?.headRef).toContain('build@sonnet-4.5');
    expect(pr?.headCommitMessage).toContain('SF-Agent: build@sonnet-4.5');
  });
});
