// Spec: docs/decisions/0010-multi-model-review-loop.md §"Substrate constraints"
// (model-independence is a policy invariant — `reviewer != author`,
// `adjudicator != author` AND `adjudicator != reviewer`); docs/design/review-agent.md
// §3 ("Model-independence enforcement: the validator compares the model segments
// of `reviewer`/`adjudicator` (from the Review stamps) against `author` (from
// the branch/commit stamp)") + §6 ("a `Review`-record-required-before-merge
// rule"). Two additive rules on existing surfaces (no new FSM states):
//
//   Rule 1 — model-segment comparison. The model segment (everything after `@`
//     in `role@model`, ADR 0008 §2 + ADR 0009 §2) of the Review's reviewer and
//     adjudicator stamps must be pairwise-distinct from each other and from
//     the PR author's model. The parser is the single canonical
//     `attributionStamp` module (ADR 0009 mandate).
//
//   Rule 2 — Review-required-before-merge. An `approved` Review (carrying
//     compliant Rule-1 stamps) is required before `pr:in_review→approved`.
//
// Invariants:
//   - Soft-flag only (mirrors crossRecordAssertions.ts): failures here
//     downgrade the dispatcher's verdict accept→flag in processMessage; they
//     do NOT hard-reject. The webhook fires post-write — the substrate
//     transition already happened — so the right posture is to record the
//     audit gap via the ledger row's verdict.
//   - Single trigger surface: `pr:in_review→approved`. The validator
//     resolves a `pull_request_review` submission with state=approved into
//     exactly that transition (services/validator/src/transitionResolver.ts
//     resolvePullRequestReviewTransition), so this is the one event where a
//     Review's ratification reaches the validator. Other PR transitions and
//     all non-PR kinds are not applicable → silent ok.
//   - Stamp model comes from the substrate, not the message. The message
//     records the FSM transition (toState=approved); the Review record and
//     PR head carry the stamps. We read both from `SubstrateClient`.
//   - Specific inequality failures (`reviewer_model_equals_author`,
//     `adjudicator_model_equals_author`, `adjudicator_model_equals_reviewer`)
//     win over the catch-all `pr_approved_with_noncompliant_review`. The
//     catch-all covers the case where a Review exists but its stamps are
//     missing/malformed/unparseable so no specific inequality can be
//     pinpointed — without this rollup an unstamped Review would silently
//     pass and the model-independence invariant would erode.
//   - When `getReviewsForPr` returns the empty list, we fail
//     `pr_approved_without_review`. When the PR view is undefined OR has
//     neither headRef nor headCommitMessage, the author model is unknown;
//     we cannot make the comparison and stay silent rather than guess
//     (same posture as crossRecordAssertions.ts when the issue body is
//     unseen — upstream resolver gap, not a violation).

import { appBotLoginsFromEnv } from './actorResolution.js';
import {
  parseBranchRef,
  parseCommitTrailers,
  parseStructuralComment,
  resolveActorFromComment,
} from './attributionStamp.js';
import type { ParsedTransitionMessage } from './queueConsumer.js';
import type { MarkerSurfaces, ReviewView, SubstrateClient } from './substrateClient.js';
import type { ReviewLoopAssertionReason } from './types.js';

export type ReviewLoopAssertionResult =
  | { ok: true }
  | { ok: false; assertion: ReviewLoopAssertionReason; detail: string };

// Extracts the model segment (everything after `@`) from a `role@model`
// agent spec. Returns undefined for a malformed spec (no `@`, empty model);
// the caller's check-or-skip decision then keys off that rather than a sentinel.
function extractModelSegment(agentSpec: string): string | undefined {
  const at = agentSpec.indexOf('@');
  if (at <= 0 || at === agentSpec.length - 1) return undefined;
  const model = agentSpec.slice(at + 1);
  if (model.length === 0) return undefined;
  return model;
}

// Recover the author's model from the PR head. ADR 0008 §2: feeder branch
// last segment is `<role>@<model>` (build|design). ADR 0009 §2: head commit
// carries `SF-Agent: <role>@<model>` trailer. Ref wins when both are present
// — they MUST agree per ADR 0009 rule 4, and the branch parse is cheaper
// and more permissive (covers PRs without commit message access).
function authorModelFromPr(pr: { headRef?: string; headCommitMessage?: string }):
  | string
  | undefined {
  if (pr.headRef !== undefined) {
    const parsed = parseBranchRef(pr.headRef);
    if (parsed.ok) {
      const model = extractModelSegment(parsed.segments.agent);
      if (model !== undefined) return model;
    }
  }
  if (pr.headCommitMessage !== undefined) {
    const agent = parseCommitTrailers(pr.headCommitMessage).get('SF-Agent');
    if (agent !== undefined) {
      const model = extractModelSegment(agent);
      if (model !== undefined) return model;
    }
  }
  return undefined;
}

interface ReviewStamps {
  reviewerModel?: string;
  adjudicatorModel?: string;
}

// A `Review` carries TWO structural-comment stamps (review-agent.md §3 + §6):
// one for the reviewer's independent-review run, one for the adjudicator's
// run. Both are `<!-- sf:structural sf:agent=review@<model> run=<run> -->`
// per ADR 0009 §D; the role segment is `review` for both — they are
// distinguished by being separate comments, not by role name. The Review
// body is the audit carrier; the structuralComments field, when the
// substrate impl exposes it, lets us scan comments individually. v0
// fallback when only `body` is set: parse the first structural comment from
// the body as the reviewer's, and the second occurrence as the adjudicator's.
function parseReviewStamps(review: ReviewView): ReviewStamps {
  const sources: string[] = [];
  if (review.structuralComments !== undefined) {
    sources.push(...review.structuralComments);
  } else {
    // Body carrier fallback: split on the comment-open token. Each segment
    // (after the first) starts inside an HTML comment; reattach the opening
    // so resolveActorFromComment's regex sees a full `<!-- … -->`. This is
    // intentionally tolerant — the canonical parser then enforces the
    // sf:structural carve-out.
    const parts = review.body.split('<!--');
    for (let i = 1; i < parts.length; i++) {
      sources.push(`<!--${parts[i]}`);
    }
  }

  const stamps: ReviewStamps = {};
  for (const src of sources) {
    const parsed = resolveActorFromComment(src);
    if (!parsed.ok) continue;
    if (parsed.actor !== 'ReviewAgent') continue;
    // The model segment lives behind the structural-comment parser; re-parse
    // the source to pull out the raw `role@model` attribute. The canonical
    // parser already validated shape + role, so the slice is safe.
    const agentMatch = /sf:agent=(\S+)/.exec(src);
    if (agentMatch === null) continue;
    const agentSpec = agentMatch[1];
    if (agentSpec === undefined) continue;
    const model = extractModelSegment(agentSpec);
    if (model === undefined) continue;
    if (stamps.reviewerModel === undefined) {
      stamps.reviewerModel = model;
    } else if (stamps.adjudicatorModel === undefined) {
      stamps.adjudicatorModel = model;
    }
    // Third+ structural review stamps on a single Review are not specified;
    // ignore — the first two satisfy the §3 pairwise-distinct invariant.
  }
  return stamps;
}

// Pick the canonical approved Review to enforce stamps against. The loop
// can emit many `changes_requested` rounds; only the terminal `approved`
// Review gates `pr:in_review→approved`. When multiple `approved` rows
// exist (post-approval regression then re-approval), the LAST one is the
// one that authorized the transition the validator is now seeing.
function findRulingApprovedReview(reviews: readonly ReviewView[]): ReviewView | undefined {
  for (let i = reviews.length - 1; i >= 0; i--) {
    const review = reviews[i];
    if (review !== undefined && review.state === 'approved') return review;
  }
  return undefined;
}

function fail(assertion: ReviewLoopAssertionReason, detail: string): ReviewLoopAssertionResult {
  return { ok: false, assertion, detail };
}

// Newest-first, App-author-authenticated scan of the PR's comment markers for
// a ReviewAgent structural stamp; returns its model segment. Mirrors
// actorResolution.resolveActorFromMarkers' trust rule (only App-bot-authored
// markers count — comments are human-writable, so anything else is forgeable).
// Throw-tolerant: getStructuralMarkers IS implemented live, but a transient
// substrate failure must degrade to "no structural evidence", never crash the
// consumer into a redelivery loop.
async function structuralReviewerModelFromMarkers(
  message: ParsedTransitionMessage,
  substrate: SubstrateClient,
  configuredAppBotLogins?: ReadonlySet<string>,
): Promise<string | undefined> {
  let surfaces: MarkerSurfaces | undefined;
  try {
    surfaces = await substrate.getStructuralMarkers(message.recordId);
  } catch {
    return undefined;
  }
  if (surfaces === undefined) return undefined;
  // rev11: trust the SAME login set the parser/resolver were configured with;
  // env fallback only when the caller didn't thread one (tests/boot).
  const appBotLogins = configuredAppBotLogins ?? appBotLoginsFromEnv();
  for (let i = surfaces.comments.length - 1; i >= 0; i--) {
    const comment = surfaces.comments[i];
    if (comment === undefined) continue;
    if (comment.authorLogin === undefined || !appBotLogins.has(comment.authorLogin)) continue;
    const resolved = resolveActorFromComment(comment.body);
    if (!resolved.ok || resolved.actor !== 'ReviewAgent') continue;
    // Issue #178 rev6+rev7: ONLY the NEWEST ReviewAgent marker counts, and
    // only when it carries verdict=approve. A newer claim (no verdict) or
    // request-changes marker means the CURRENT review round has not approved
    // — an older approve marker from a previous round must never satisfy the
    // assertion (stale-approval). So: stop at the first (newest) ReviewAgent
    // marker; approve → evidence, anything else → no structural evidence.
    const attrs = parseStructuralComment(comment.body).attributes;
    if (attrs.get('verdict') !== 'approve') return undefined;
    const agentSpec = attrs.get('sf:agent');
    if (agentSpec === undefined) return undefined;
    return extractModelSegment(agentSpec);
  }
  return undefined;
}

// getPullRequest is GraphQL-wired on the live GithubSubstrateClient (issue
// #170), but a transient substrate failure can still throw. Tolerate:
// undefined = author model unknown → the caller stays silent on author-relative
// inequalities (the documented crossRecordAssertions posture).
async function tolerantGetPullRequest(
  substrate: SubstrateClient,
  recordId: string,
): ReturnType<SubstrateClient['getPullRequest']> {
  try {
    return await substrate.getPullRequest(recordId);
  } catch {
    return undefined;
  }
}

export async function runReviewLoopAssertions(
  message: ParsedTransitionMessage,
  substrate: SubstrateClient,
  appBotLogins?: ReadonlySet<string>,
): Promise<ReviewLoopAssertionResult> {
  // Not-applicable path: only `pr:in_review→approved` is the surface where
  // the validator sees a Review's ratification of a PR. Issue/Goal/Spec/
  // Design/Task/Deployment/Decision kinds and other PR transitions silently
  // pass.
  if (message.kind !== 'pr') return { ok: true };
  if (message.fromState !== 'in_review' || message.toState !== 'approved') {
    return { ok: true };
  }

  // STRUCTURAL review evidence (issue #178): under the single App identity
  // (ADR 0009 §1) the App cannot create a native approved Review on its own PR
  // (GitHub 422), so ReviewAgent's verdict rides an App-authenticated
  // structural findings COMMENT (`sf:agent=review@<model> run=<ulid>`) +
  // `status:approved`. That comment IS the Review-equivalent: when present,
  // enforce Rule 1 against ITS reviewer model and skip the native-Review
  // lookup. Newest-first, App-author-authenticated scan — same trust rule as
  // actorResolution.resolveActorFromMarkers (markers are forgeable otherwise).
  // rev11: the structural path applies ONLY to ReviewAgent-actor approvals.
  // ReviewAgent applies status:approved in the SAME run that posts the
  // verdict=approve marker, so actor=ReviewAgent ⇒ the newest marker is THIS
  // round's evidence. A human-actor approval (native review or label apply)
  // must NOT be satisfied by a stale marker from an earlier round — it takes
  // the native-evidence path below.
  const structuralReviewerModel =
    message.actor === 'ReviewAgent'
      ? await structuralReviewerModelFromMarkers(message, substrate, appBotLogins)
      : undefined;
  if (structuralReviewerModel !== undefined) {
    const prView = await tolerantGetPullRequest(substrate, message.recordId);
    // rev13: the live getPullRequest is GraphQL-wired (#170) but tolerant
    // (undefined on a transient substrate failure); the labeled PR webhook also
    // carries the head branch on the message — parse the author model from it
    // (preferring the substrate read) so Rule 1 is ENFORCED for
    // structural approvals, not silently skipped (build@X approved by
    // review@X must flag).
    const author =
      (prView !== undefined
        ? authorModelFromPr({
            headRef: prView.headRef,
            headCommitMessage: prView.headCommitMessage,
          })
        : undefined) ??
      (message.headBranch !== undefined
        ? authorModelFromPr({ headRef: message.headBranch })
        : undefined);
    // Author model unknown → cannot compare; stay silent (same posture as the
    // native path below). v0 has no adjudicator stamp on the structural path
    // (single-model review; the ADR 0010 multi-model loop is deferred).
    if (author !== undefined && structuralReviewerModel === author) {
      return fail(
        'reviewer_model_equals_author',
        `structural reviewer model "${structuralReviewerModel}" equals author model on PR "${message.recordId}"`,
      );
    }
    return { ok: true };
  }

  // NATIVE Review path (human approvals / pre-#178 flows). The live
  // GithubSubstrateClient now GraphQL-wires getReviewsForPr/getPullRequest
  // (issue #170), but a transient substrate failure can still throw. A thrown
  // read must not crash the consumer into a redelivery loop — but it must NOT
  // pass either (rev10):
  // with no structural approve marker AND unreadable native evidence, an
  // evidence-less status:approved (human label-apply, misbehaving agent)
  // would otherwise satisfy the gate. FAIL CLOSED: soft-flag
  // pr_approved_without_review — the transition is still recorded, the
  // orchestrator verdict-gates OpsAgent, and a human completes the merge
  // manually (a human approving by label can also click merge). Agent
  // approvals are unaffected: they always carry the verdict=approve marker
  // handled above.
  let reviews: readonly ReviewView[];
  try {
    reviews = await substrate.getReviewsForPr(message.recordId);
  } catch {
    return fail(
      'pr_approved_without_review',
      `PR "${message.recordId}" approved with no structural approve marker and unreadable native Review evidence`,
    );
  }
  const approved = findRulingApprovedReview(reviews);

  // Rule 2 — `approved` Review must exist. Zero approved Reviews on the PR
  // → `pr_approved_without_review`. (Even if `changes_requested` rounds
  // exist, none of them carries the convergent verdict; only an `approved`
  // Review gates merge.)
  if (approved === undefined) {
    return fail(
      'pr_approved_without_review',
      `PR "${message.recordId}" transitioned in_review→approved with no approved Review record`,
    );
  }

  const pr = await tolerantGetPullRequest(substrate, message.recordId);
  const authorModel =
    pr === undefined
      ? undefined
      : authorModelFromPr({ headRef: pr.headRef, headCommitMessage: pr.headCommitMessage });

  const stamps = parseReviewStamps(approved);

  // Rule 1 catch-all: if the approved Review's stamps cannot be parsed at
  // all (no reviewer model recovered), the model-independence invariant
  // cannot be checked and the Review is non-compliant by construction. The
  // adjudicator stamp may legitimately be missing in v0 (external codex
  // operator-run loop, ADR 0010 §"Field evidence") — we tolerate that and
  // only fail the catch-all when the reviewer stamp itself is missing.
  if (stamps.reviewerModel === undefined) {
    return fail(
      'pr_approved_with_noncompliant_review',
      `approved Review "${approved.recordId}" lacks a parseable reviewer model stamp`,
    );
  }

  // Rule 1 — pairwise inequalities. Author model is recoverable from the PR
  // head; if it's not, we cannot check author-relative inequalities (stay
  // silent on those, same posture as crossRecordAssertions when the issue
  // body is unseen — upstream resolver gap).
  if (authorModel !== undefined) {
    if (stamps.reviewerModel === authorModel) {
      return fail(
        'reviewer_model_equals_author',
        `reviewer model "${stamps.reviewerModel}" equals author model on PR "${message.recordId}"`,
      );
    }
    if (stamps.adjudicatorModel !== undefined && stamps.adjudicatorModel === authorModel) {
      return fail(
        'adjudicator_model_equals_author',
        `adjudicator model "${stamps.adjudicatorModel}" equals author model on PR "${message.recordId}"`,
      );
    }
  }

  if (stamps.adjudicatorModel !== undefined && stamps.adjudicatorModel === stamps.reviewerModel) {
    return fail(
      'adjudicator_model_equals_reviewer',
      `adjudicator model "${stamps.adjudicatorModel}" equals reviewer model on PR "${message.recordId}"`,
    );
  }

  return { ok: true };
}
