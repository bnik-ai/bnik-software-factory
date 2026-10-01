// Spec: docs/decisions/0013-planner-agent.md §Decision items 1, 3, 4
// (rename-and-broaden into a continuous triage / dependency-order /
// ready-gate engine; humans declare Priority + committed_*, agents order
// within those bands; event-driven re-evaluation on intake +
// dependency-clear).
// Invariants:
//   - Triggered by any of the routing keys that mark a re-plan event:
//       NEW INTAKE: goal:__initial__→proposed (human-created Goal),
//                   task:__initial__→proposed (human-created Task — also
//                                              served by HUMAN_CREATION_DISPATCH),
//                   design:ready_for_review→ratified (Design fan-out
//                                              entry path — pre-existing
//                                              ProjectAgent trigger).
//       DEP-CLEAR: task:in_review→done, task:*→abandoned (any abandon
//                                              also clears blocks on
//                                              dependent Tasks).
//     The handler is INTAKE-AGNOSTIC: every trigger runs the same backlog
//     re-evaluation. The triggering message is metadata for the audit
//     ledger; the actual work is "scan proposed Tasks, promote whichever
//     have their dependencies cleared, in priority order."
//   - FSM gate: PlannerAgent MUST go through the validator's task
//     proposed→ready transition (taskFsm.ts allowedActors: ['PlannerAgent']).
//     The PlannerSubstrateClient.transitionTask() is the substrate write
//     that fires the validator's inbound flow — PlannerAgent does NOT
//     emit a separate transition message and does NOT bypass the gate
//     (hard constraint per the PR brief).
//   - Humans declare, agents order. Within a single re-evaluation the
//     planner orders by:
//       1. Priority (P0 highest → P3 lowest; unset treated as P3),
//       2. committed_start_at (human hard constraint; earlier first; unset
//          sorts AFTER tasks that DO have a committed time so the
//          committed work is bunched to the front),
//       3. target_start_at (planner-set ordering; same shape as #2),
//       4. createdAt (FIFO tiebreaker).
//     The planner NEVER overrides Priority or committed_*; it only sets
//     target_* within. This v0 implementation reads Priority/committed_*/
//     target_* from PlannerTaskMetadata but does NOT yet write target_*
//     back (that needs a SubstrateClient that can edit Task body fields).
//   - Dependency check: a `proposed` Task is promotable to `ready` iff
//     every recordId in its `blocked-by` list resolves to a Task in `done`.
//     Abandoned blockers also clear the dependency (per ADR 0013 §4 —
//     "any →abandoned" is a dep-clear trigger). Unresolvable blockers
//     (record_not_found from getTaskMetadata) leave the Task in `proposed`
//     with a typed note in the result envelope so operators can see the gap.
//   - Defensive: every recognized trigger is intake-agnostic, but mis-
//     routed transitions return a typed `planner_agent_wrong_transition`
//     failure so the deadletter reason names the specific routing key.
//   - The handler is async; the substrate-client + ordering work is I/O-
//     bound (list + per-task fetch) and the real impl pages through
//     GitHub. v0 stub returns immediately.
//   - DECOMPOSE branch: the `design:ready_for_review→ratified`
//     trigger is NOT a promote-by-dep-order backlog scan. Instead PlannerAgent
//     reads the ratified Design and fans it out into `kind:task` Issues (one
//     per unit of buildable work), each body carrying the ADR 0003 link fields
//     (`parent-goal` / `spec-ref` / `design-ref`) + any `blocked-by` ordering
//     the Design implies. CRITICAL (actor-asymmetry):
//     these Tasks are authored by PlannerAgent (the App), so their
//     `task:__initial__→proposed` webhooks resolve actor=PlannerAgent, which
//     the orchestrator routingTable treats as `no_dispatch_needed` (only
//     HUMAN-created Task initial transitions get the promote-dispatch). So the
//     fan-out webhooks do NOT re-trigger this handler — decompose MUST promote
//     the unblocked roots itself, in this same run, against the recordIds
//     returned by issues.create (search indexing lags → never listTasks here).
//     Blocked Tasks stay proposed and cascade to ready later via the normal
//     `task:in_review→done` re-plan trigger (that key IS routed to PlannerAgent).

import type { AgentResult } from '../agentRegistry.js';
import type { ContentRequest, ContentResult } from '../runtime/contentAgent.js';
import type { IssueTool } from '../tools/issueTool.js';
import type {
  PlannerSubstrateClient,
  PlannerTaskMetadata,
} from '../tools/plannerSubstrateClient.js';
import type { ParsedTransitionMessage } from '../types.js';

// Injectable content brain (same shape designAgent/specAgent use). Real path
// binds runtime/contentAgent.generateContent (curried with a model); absent
// on the stub/CI path so decompose falls back to a single templated Task.
export type GenerateContentFn = (req: ContentRequest) => Promise<ContentResult>;

export interface PlannerAgentDeps {
  substrate: PlannerSubstrateClient;
  // Per-run ULID per ADR 0008. Threaded into the result envelope and
  // (when wired) the substrate's structural-comment attribution.
  runId: string;
  repo: string;
  // Per-record write seam for the DECOMPOSE branch (design:ratified → Tasks).
  // The promote branch uses `substrate` (backlog query); decompose reads the
  // Design + creates Task issues via the same IssueTool the other authoring
  // agents use. Optional so the existing promote-only deps + tests stay valid.
  issues?: IssueTool;
  // Real content brain. When present, the decompose branch model-authors the
  // Task list from the Design; when absent (stub/CI boot), it falls back to a
  // single templated Task so the loop stays exercisable. Gated on definedness
  // exactly like designAgent/specAgent.
  generateContent?: GenerateContentFn;
}

const ROLE = 'PlannerAgent' as const;

// The one trigger key that DECOMPOSES (Design → Tasks) instead of promoting.
const DECOMPOSE_TRIGGER_KEY = 'design:ready_for_review→ratified' as const;

// Link-field prefixes carried in the Design body (producer: DesignAgent) and
// re-emitted into each Task body (consumer: validator crossRecordAssertions +
// PlannerAgent dep-clear). Match the ADR 0003 / ADR 0007 issue-body carrier.
const PARENT_GOAL_PREFIX = 'parent-goal: ';
const SPEC_REF_PREFIX = 'spec-ref: ';

const UNKNOWN_PARENT_GOAL = '(unknown — Design body missing parent-goal field)';
const UNKNOWN_SPEC_REF = '(unknown — Design body missing spec-ref field)';

const DECOMPOSE_AUTHOR_SYSTEM =
  'You are PlannerAgent, a software-factory task planner. Given a ratified ' +
  'Design, decompose it into the minimal set of independently-buildable Tasks ' +
  '(one Task ↔ one PR). Return ONLY a JSON array; each element is an object ' +
  '{"title": string, "whatToBuild": string, "blockedBy": number[]}. "title" is ' +
  'a short imperative Task title. "whatToBuild" is an actionable markdown ' +
  'description derived strictly from the Design scope (do not invent work ' +
  'outside it). "blockedBy" lists the zero-based indices of OTHER Tasks in this ' +
  'same array that must complete first (use it only when the Design implies ' +
  'ordering); omit or use [] when there are no intra-Design dependencies. ' +
  'Output the JSON array and nothing else — no preamble, no code fences.';

// Priority rank — lower number = higher priority. Unset Priority sorts
// after P3 (treated as the lowest-priority bucket). Matches ADR 0013 §3
// "humans declare Priority; agents order within."
const PRIORITY_RANK: Record<'P0' | 'P1' | 'P2' | 'P3', number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};
const UNSET_PRIORITY_RANK = 4;

// Recognized re-plan trigger keys. The handler treats every one the same
// (a re-evaluation request) — the key is metadata for the audit ledger,
// not a branch in the agent logic.
const REPLAN_TRIGGER_KEYS: ReadonlySet<string> = new Set([
  // New intake.
  'goal:__initial__→proposed',
  'task:__initial__→proposed',
  'design:ready_for_review→ratified',
  // Dependency-clear. ready→done is driven by OpsAgent (v0 post-merge
  // bookkeeping) OR BuildAgent (already-satisfied empty-diff settle — v0
  // BuildAgent never drives the intermediate states); both done edges replan
  // identically regardless of actor.
  'task:ready→done',
  'task:in_review→done',
  'task:proposed→abandoned',
  'task:ready→abandoned',
  'task:in_progress→abandoned',
  'task:in_review→abandoned',
]);

export async function runPlannerAgent(
  message: ParsedTransitionMessage,
  deps: PlannerAgentDeps,
): Promise<AgentResult> {
  const transitionKey = `${message.kind}:${message.fromState}→${message.toState}`;

  if (!REPLAN_TRIGGER_KEYS.has(transitionKey)) {
    return {
      ok: false,
      reason: `planner_agent_wrong_transition:${transitionKey}`,
    };
  }

  // DECOMPOSE branch: a ratified Design fans out into kind:task Issues. This
  // is NOT the promote-by-dep-order path (no proposed Tasks exist yet at
  // decomposition time); the new Tasks fire their own task:__initial__→proposed
  // webhooks which re-trigger the PROMOTE path below on a later dispatch.
  if (transitionKey === DECOMPOSE_TRIGGER_KEY) {
    return decomposeDesign(message, deps);
  }

  // PROMOTE branch (every other recognized trigger): scan the proposed
  // backlog, promote whichever Tasks have their dependencies cleared.
  // 1. Pull the proposed-state backlog from the substrate.
  const proposedTaskIds = await deps.substrate.listTasks('proposed');
  if (!proposedTaskIds.ok) {
    return {
      ok: false,
      reason: `planner_agent_list_backlog_failed:${proposedTaskIds.reason}`,
    };
  }

  if (proposedTaskIds.value.length === 0) {
    return {
      ok: true,
      result: `${ROLE}: backlog empty; trigger=${transitionKey} promoted=0 run=${deps.runId}`,
    };
  }

  // 2. Fetch metadata for every backlog Task so we can evaluate deps + order.
  const proposedMetadata: PlannerTaskMetadata[] = [];
  const fetchFailures: string[] = [];
  for (const taskId of proposedTaskIds.value) {
    const meta = await deps.substrate.getTaskMetadata(taskId);
    if (!meta.ok) {
      fetchFailures.push(`${taskId}:${meta.reason}`);
      continue;
    }
    proposedMetadata.push(meta.value);
  }

  if (proposedMetadata.length === 0) {
    return {
      ok: false,
      reason: `planner_agent_metadata_fetch_failed:${fetchFailures.join(',')}`,
    };
  }

  // 3. Evaluate the dependency frontier: a Task is promotable iff every
  //    blocker is in `done` OR `abandoned`. Abandoned blockers clear the
  //    dep per ADR 0013 §4. record_not_found blockers do NOT clear (the
  //    Task body cites a non-existent record — leave the Task in
  //    `proposed` and surface the gap in the result envelope).
  const promotable: PlannerTaskMetadata[] = [];
  const blockedReasons: string[] = [];
  for (const meta of proposedMetadata) {
    const evalResult = await evaluateBlockers(meta, deps.substrate);
    if (evalResult.kind === 'cleared') {
      promotable.push(meta);
    } else {
      blockedReasons.push(`${meta.recordId}:${evalResult.detail}`);
    }
  }

  // 4. Order the promotable set per ADR 0013 §3 (priority → committed_* →
  //    target_* → createdAt). Stable wrt insertion via Array.prototype.sort
  //    (Node 12+ specifies stable sort).
  promotable.sort(compareForPromotion);

  // 5. Effect the proposed→ready transition for each promotable Task via
  //    the FSM (PlannerSubstrateClient.transitionTask is the substrate
  //    write the validator's inbound flow then evaluates — see the
  //    plannerSubstrateClient.ts header for the no-bypass invariant).
  const promoted: string[] = [];
  const promoteFailures: string[] = [];
  for (const meta of promotable) {
    const transition = await deps.substrate.transitionTask({
      taskId: meta.recordId,
      fromState: 'proposed',
      toState: 'ready',
      actor: ROLE,
    });
    if (transition.ok) {
      promoted.push(meta.recordId);
    } else {
      promoteFailures.push(`${meta.recordId}:${transition.reason}`);
    }
  }

  // Compose a single-line result summary so the audit ledger has the
  // counts at-a-glance + a comma list of promoted recordIds for tracing.
  const summaryParts: string[] = [
    `${ROLE}: trigger=${transitionKey}`,
    `backlog=${proposedMetadata.length}`,
    `promoted=${promoted.length}`,
    `blocked=${blockedReasons.length}`,
  ];
  if (fetchFailures.length > 0) {
    summaryParts.push(`metadata_fetch_failures=${fetchFailures.length}`);
  }
  if (promoteFailures.length > 0) {
    summaryParts.push(`promote_failures=${promoteFailures.length}`);
  }
  if (promoted.length > 0) {
    summaryParts.push(`ids=${promoted.join(',')}`);
  }
  summaryParts.push(`run=${deps.runId}`);
  const summary = summaryParts.join(' ');

  // Partial-failure surfacing: any non-empty
  // fetchFailures / promoteFailures means substrate reads or FSM
  // transitions did not all succeed. Returning ok:true here would cause
  // the consumer to ack-and-forget — hiding the gap in the audit ledger
  // until some unrelated re-plan trigger happens to fire again. Instead
  // return ok:false so the consumer deadletters with a specific reason
  // (consumerLoop.ts: ok:false → deadletter); the planner's idempotent
  // backlog scan means the next legitimate re-plan trigger naturally
  // re-tries the stranded Tasks, while the DLQ row gives operators
  // visibility into the underlying substrate/validator issue.
  if (fetchFailures.length > 0 || promoteFailures.length > 0) {
    const failureDetail = [
      ...(fetchFailures.length > 0 ? [`metadata_fetch:${fetchFailures.join('|')}`] : []),
      ...(promoteFailures.length > 0 ? [`transition:${promoteFailures.join('|')}`] : []),
    ].join(';');
    return {
      ok: false,
      reason: `planner_agent_partial_failure:${failureDetail};summary=${summary}`,
    };
  }

  return {
    ok: true,
    result: summary,
  };
}

// One planned Task before it is materialized into an Issue. `blockedBy`
// holds zero-based indices into the same plan array (intra-Design ordering
// the Design implies); they are resolved to created recordIds AFTER all
// Tasks exist so a Task can block on a later one without a forward-reference
// problem.
interface PlannedTask {
  title: string;
  whatToBuild: string;
  blockedBy: ReadonlyArray<number>;
}

// DECOMPOSE: read a ratified Design, fan it out into kind:task Issues.
// Each Task body carries the ADR 0003 link fields (parent-goal/spec-ref
// forwarded from the Design body + design-ref = the Design recordId) and any
// blocked-by ordering the Design implies. kind:task is the ONLY label —
// `proposed` is the implicit initial state (no status label; the validator
// derives it). The newly-created Tasks fire their own
// task:__initial__→proposed webhooks which re-trigger the promote path.
async function decomposeDesign(
  message: ParsedTransitionMessage,
  deps: PlannerAgentDeps,
): Promise<AgentResult> {
  if (deps.issues === undefined) {
    // No write seam wired — cannot create Tasks. Typed failure so the
    // deadletter reason is specific (the entrypoint always threads issues
    // on both real + stub paths; this guards a misconfigured binder).
    return { ok: false, reason: 'planner_agent_decompose_no_issues_tool' };
  }

  const design = await deps.issues.read(message.recordId);
  if (!design.ok) {
    return { ok: false, reason: `planner_agent_design_read_failed:${design.reason}` };
  }

  const parentGoal = extractLinkField(design.value.body, PARENT_GOAL_PREFIX, UNKNOWN_PARENT_GOAL);
  const specRef = extractLinkField(design.value.body, SPEC_REF_PREFIX, UNKNOWN_SPEC_REF);
  const designRef = message.recordId;

  // Real path: model-author the Task list from the Design. Stub path (no
  // brain): a single templated Task so the loop stays exercisable end-to-end.
  let plan: PlannedTask[];
  if (deps.generateContent !== undefined) {
    const generated = await deps.generateContent({
      system: DECOMPOSE_AUTHOR_SYSTEM,
      prompt: `Design:\n\n${design.value.body}\n\nDecompose into Tasks (JSON array).`,
    });
    if (!generated.ok) {
      return {
        ok: false,
        reason: `planner_agent_decompose_content_failed:${generated.stopReason ?? 'empty'}`,
      };
    }
    const parsed = parsePlannedTasks(generated.text);
    if (!parsed.ok) {
      return { ok: false, reason: `planner_agent_decompose_parse_failed:${parsed.reason}` };
    }
    plan = parsed.value;
  } else {
    plan = [renderStubPlannedTask(design.value.body)];
  }

  // Create each Task in dependency-respecting order so a blocker is created
  // before any Task that lists it (`blocked-by:` cites the blocker's recordId,
  // embedded at create time — GitHub issue bodies are not patched here).
  // createdIds[i] = the recordId once plan[i] is created, else undefined.
  const createdIds: Array<string | undefined> = new Array(plan.length).fill(undefined);
  const createFailures: string[] = [];
  // A Task whose blocker FAILED to create (or was itself skipped) MUST NOT
  // be materialized — otherwise its `blocked-by:` line silently drops the
  // missing blocker, yielding an apparently-unblocked Task that could be
  // promoted/built out of order. Track which plan indices were skipped for
  // this reason so dependents transitively skip + the gap surfaces in the
  // result.
  const skippedDependents: string[] = [];
  for (const planIndex of creationOrder(plan)) {
    const planned = plan[planIndex];
    if (planned === undefined) continue;
    const blockedByRefs: string[] = [];
    let missingBlocker: number | undefined;
    for (const blockerIndex of planned.blockedBy) {
      // Out-of-range index is a brain bug, not a dependency we can honor — it
      // names no real Task, so there is nothing to block on; ignore it.
      if (blockerIndex < 0 || blockerIndex >= plan.length) continue;
      const blockerId = createdIds[blockerIndex];
      if (blockerId === undefined) {
        // The blocker did not get a recordId (failed create or was itself
        // skipped). Materializing this Task without the link would let it run
        // ahead of its dependency — skip it instead.
        missingBlocker = blockerIndex;
        break;
      }
      blockedByRefs.push(blockerId);
    }
    if (missingBlocker !== undefined) {
      skippedDependents.push(`${planIndex}:blocker_${missingBlocker}_not_created`);
      continue; // createdIds[planIndex] stays undefined → its dependents skip too.
    }
    const body = renderTaskBody({
      parentGoal,
      specRef,
      designRef,
      whatToBuild: planned.whatToBuild,
      blockedBy: blockedByRefs,
    });
    const created = await deps.issues.create({
      repo: deps.repo,
      title: planned.title,
      body,
      // kind:task ONLY — `proposed` is the implicit initial state (the
      // validator derives it; no status:* label is written here).
      labels: ['kind:task'],
      structural: { role: ROLE, run: deps.runId },
    });
    if (!created.ok) {
      createFailures.push(`${planIndex}:${created.reason}`);
      continue; // createdIds[planIndex] stays undefined → its dependents skip.
    }
    createdIds[planIndex] = created.value.recordId;
  }

  const createdRecordIds = createdIds.filter((id): id is string => id !== undefined);

  // Stranded-tasks guard (actor-asymmetry): the Tasks we just created are
  // authored by PlannerAgent (the App), so their `task:__initial__→proposed`
  // webhooks resolve actor=PlannerAgent, which the orchestrator routingTable
  // treats as `no_dispatch_needed` (only HUMAN-created Task initial
  // transitions get the promote-dispatch). Nothing would ever promote them —
  // so we promote the unblocked ROOTS here, in this same run, against the
  // recordIds we just got back (NOT via listTasks — search indexing lags).
  // Blocked Tasks stay in `proposed` and cascade to `ready` later via the
  // normal `task:in_review→done` re-plan trigger (that key IS routed to
  // PlannerAgent), so only the roots need promoting now.
  const promotedRoots: string[] = [];
  const promoteFailures: string[] = [];
  for (let planIndex = 0; planIndex < plan.length; planIndex++) {
    const recordId = createdIds[planIndex];
    if (recordId === undefined) continue; // not created (failed or skipped).
    const planned = plan[planIndex];
    if (planned === undefined) continue;
    // A root has no INTRA-DESIGN blocker that was actually created. (Out-of-
    // range indices were ignored above and carry no real blocker; a created
    // blocker means this Task must wait — leave it proposed.)
    const hasLiveBlocker = planned.blockedBy.some((blockerIndex) => {
      if (blockerIndex < 0 || blockerIndex >= plan.length) return false;
      return createdIds[blockerIndex] !== undefined;
    });
    if (hasLiveBlocker) continue;
    const transition = await deps.substrate.transitionTask({
      taskId: recordId,
      fromState: 'proposed',
      toState: 'ready',
      actor: ROLE,
    });
    if (transition.ok) {
      promotedRoots.push(recordId);
    } else {
      promoteFailures.push(`${recordId}:${transition.reason}`);
    }
  }

  const summaryParts = [
    `${ROLE}: decomposed design=${designRef}`,
    `created_tasks=${createdRecordIds.length}`,
    `promoted_roots=${promotedRoots.length}`,
  ];
  if (createFailures.length > 0) summaryParts.push(`create_failures=${createFailures.length}`);
  if (skippedDependents.length > 0) {
    summaryParts.push(`skipped_dependents=${skippedDependents.length}`);
  }
  if (promoteFailures.length > 0) summaryParts.push(`promote_failures=${promoteFailures.length}`);
  if (createdRecordIds.length > 0) summaryParts.push(`ids=${createdRecordIds.join(',')}`);
  summaryParts.push(`run=${deps.runId}`);
  const summary = summaryParts.join(' ');

  // Partial-failure surfacing (mirrors the promote branch): any create
  // failure, skipped dependent, or promote failure → ok:false so the consumer
  // deadletters with a typed reason and the gap is auditable. The summary is
  // preserved so operators see what DID get created + promoted.
  if (createFailures.length > 0 || skippedDependents.length > 0 || promoteFailures.length > 0) {
    const failureDetail = [
      ...(createFailures.length > 0 ? [`create:${createFailures.join('|')}`] : []),
      ...(skippedDependents.length > 0 ? [`skipped:${skippedDependents.join('|')}`] : []),
      ...(promoteFailures.length > 0 ? [`promote:${promoteFailures.join('|')}`] : []),
    ].join(';');
    return {
      ok: false,
      reason: `planner_agent_decompose_partial_failure:${failureDetail};summary=${summary}`,
    };
  }

  return { ok: true, result: summary };
}

// Topological-ish creation order: a Task's intra-Design blockers are created
// before it so the blocked-by body line can cite a real recordId. Falls back
// to plan order on a cycle / unresolved index (defensive — the brain should
// not emit cycles, but we must terminate). Returns plan indices.
function creationOrder(plan: ReadonlyArray<PlannedTask>): number[] {
  const ordered: number[] = [];
  const placed = new Set<number>();
  const visiting = new Set<number>();
  const visit = (index: number): void => {
    if (placed.has(index) || visiting.has(index)) return;
    visiting.add(index);
    const planned = plan[index];
    if (planned !== undefined) {
      for (const blockerIndex of planned.blockedBy) {
        if (blockerIndex >= 0 && blockerIndex < plan.length) visit(blockerIndex);
      }
    }
    visiting.delete(index);
    if (!placed.has(index)) {
      placed.add(index);
      ordered.push(index);
    }
  };
  for (let index = 0; index < plan.length; index++) visit(index);
  return ordered;
}

// Parse the brain's JSON array into PlannedTasks. Tolerant of a leading/
// trailing code fence the model may emit despite the instruction. Each
// element must have a non-empty title + whatToBuild; blockedBy defaults to [].
function parsePlannedTasks(
  raw: string,
): { ok: true; value: PlannedTask[] } | { ok: false; reason: string } {
  const stripped = stripCodeFence(raw).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'not_an_array' };
  }
  if (parsed.length === 0) {
    return { ok: false, reason: 'empty_array' };
  }
  const tasks: PlannedTask[] = [];
  for (let index = 0; index < parsed.length; index++) {
    const element = parsed[index] as Record<string, unknown> | null;
    if (element === null || typeof element !== 'object') {
      return { ok: false, reason: `element_${index}_not_object` };
    }
    const title = typeof element.title === 'string' ? element.title.trim() : '';
    const whatToBuild = typeof element.whatToBuild === 'string' ? element.whatToBuild.trim() : '';
    if (title.length === 0 || whatToBuild.length === 0) {
      return { ok: false, reason: `element_${index}_missing_title_or_body` };
    }
    const blockedBy = Array.isArray(element.blockedBy)
      ? element.blockedBy.filter(
          (value): value is number => typeof value === 'number' && Number.isInteger(value),
        )
      : [];
    tasks.push({ title, whatToBuild, blockedBy });
  }
  return { ok: true, value: tasks };
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  // Drop the opening fence line (``` or ```json) and a trailing fence.
  const withoutOpen = trimmed.replace(/^```[a-zA-Z]*\n?/, '');
  return withoutOpen.replace(/\n?```\s*$/, '');
}

// Extract a `field: value` line from the Design body. Returns the fallback
// when absent. Mirrors designAgent.extractParentGoal.
function extractLinkField(body: string, prefix: string, fallback: string): string {
  for (const line of body.split('\n')) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trim();
    }
  }
  return fallback;
}

// Render one Task body carrying the ADR 0003 link fields + an actionable
// "What to build" section + any blocked-by ordering. Field shape matches the
// validator's crossRecordAssertions parser
// (`parent-goal:` / `spec-ref:` / `design-ref:` / `blocked-by:`).
function renderTaskBody(args: {
  parentGoal: string;
  specRef: string;
  designRef: string;
  whatToBuild: string;
  blockedBy: ReadonlyArray<string>;
}): string {
  const lines = [
    `parent-goal: ${args.parentGoal}`,
    `spec-ref: ${args.specRef}`,
    `design-ref: ${args.designRef}`,
  ];
  if (args.blockedBy.length > 0) {
    lines.push(`blocked-by: ${args.blockedBy.join(', ')}`);
  }
  lines.push('', '## What to build', args.whatToBuild);
  return lines.join('\n');
}

// Stub path (no brain): a single Task covering the whole Design so the
// orchestrator → PlannerAgent → Task → BuildAgent loop is exercisable
// end-to-end without a model. Mirrors the templated-placeholder convention
// designAgent/specAgent use on the no-brain path.
function renderStubPlannedTask(designBody: string): PlannedTask {
  return {
    title: `Task: implement ${extractDesignSummary(designBody)}`,
    whatToBuild:
      'TODO: PlannerAgent (no content brain) ships a single Task covering the whole Design. ' +
      'The real path model-decomposes the Design into independently-buildable Tasks.',
    blockedBy: [],
  };
}

function extractDesignSummary(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith(PARENT_GOAL_PREFIX)) continue;
    if (trimmed.startsWith(SPEC_REF_PREFIX)) continue;
    if (trimmed.startsWith('##')) continue;
    return trimmed;
  }
  return '(empty design body)';
}

// Returns `cleared` iff every blocker is in done OR abandoned. Returns
// `blocked` with a human-readable detail naming the first unresolved
// blocker so operators can act on it. We stop at the first unresolved
// blocker — we don't need a full enumeration to know the Task can't
// promote this round.
async function evaluateBlockers(
  meta: PlannerTaskMetadata,
  substrate: PlannerSubstrateClient,
): Promise<{ kind: 'cleared' } | { kind: 'blocked'; detail: string }> {
  if (meta.blockedBy.length === 0) {
    return { kind: 'cleared' };
  }
  for (const blockerId of meta.blockedBy) {
    const blocker = await substrate.getTaskMetadata(blockerId);
    if (!blocker.ok) {
      // Citing a non-existent record is a substrate-shape problem the
      // human owner needs to fix; the planner does not promote.
      return { kind: 'blocked', detail: `blocker_not_found:${blockerId}` };
    }
    if (blocker.value.state !== 'done' && blocker.value.state !== 'abandoned') {
      return {
        kind: 'blocked',
        detail: `blocker_${blockerId}_in_${blocker.value.state}`,
      };
    }
  }
  return { kind: 'cleared' };
}

// Compare two promotable Tasks per ADR 0013 §3 ordering:
//   1. Priority (lower rank = higher priority; unset is lowest).
//   2. committed_start_at (human hard constraint; earlier first; tasks
//      with committed_* sort BEFORE tasks without).
//   3. target_start_at (planner ordering; same shape).
//   4. createdAt (FIFO tiebreaker).
// Pure function — exported for unit tests.
export function compareForPromotion(a: PlannerTaskMetadata, b: PlannerTaskMetadata): number {
  const priorityCompare = priorityRankOf(a) - priorityRankOf(b);
  if (priorityCompare !== 0) return priorityCompare;

  const committedCompare = compareOptionalTimestamp(a.committedStartAt, b.committedStartAt);
  if (committedCompare !== 0) return committedCompare;

  const targetCompare = compareOptionalTimestamp(a.targetStartAt, b.targetStartAt);
  if (targetCompare !== 0) return targetCompare;

  // createdAt is required — straight ISO-8601 lexical compare orders
  // chronologically (the property of the ISO format).
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  return 0;
}

function priorityRankOf(meta: PlannerTaskMetadata): number {
  if (meta.priority === undefined) return UNSET_PRIORITY_RANK;
  return PRIORITY_RANK[meta.priority];
}

// undefined sorts AFTER any defined value (defined timestamps bunch to
// the front). When both are undefined, return 0 so the caller falls
// through to the next comparator.
function compareOptionalTimestamp(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
