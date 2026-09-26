// GENERATED-ADJACENT STATIC MODEL for gen-architecture-diagrams.mjs.
// Holds the bespoke ASCII layout (the parts that are not enumerable from code).
// Enumerable facts (agent set, FSM/record counts) are derived at generation time
// and substituted into / verified against this template — see the generator.
//
// To intentionally change the diagram's LAYOUT, edit BODY_TEMPLATE here and
// regenerate. To change an enumerable FACT, change its source of truth (an agent
// file, an FSM file, the azure-adapter / architecture tables) — never hand-edit the
// rendered numbers here.

// Agent display order for the L3 row (pipeline order — Goal→…→Deploy).
// This is LAYOUT (order), not membership: the generator verifies this set equals
// the agent roles globbed from services/agents/src/agents/*Agent.ts, and fails
// loud on any add/remove. Short names are ROLE with the 'Agent' suffix stripped.
export const AGENT_ORDER = ['Spec', 'Design', 'Planner', 'Build', 'Review', 'Ops', 'SRE'];

// Exact code-point length of each rendered L3 agent-row line (asserted in tests).
export const AGENT_ROW_LINE_LEN = 101;

// Azure resource names the diagram depends on. The generator verifies each still
// appears in docs/design/azure-adapter.md (a rename there → fail-loud drift). These
// names are wrapped/split across box lines in the art, so they cannot be grepped
// back out of the rendered ASCII — hence this explicit dependency declaration.
export const AZURE_REFS = {
  containerApps: ['ca-admin', 'ca-agent', 'ca-cf-tunnel', 'ca-terraform', 'ca-webhook'],
  jobs: ['caj-orchestrator', 'caj-tf-apply', 'caj-validator'],
  queues: ['agent-runs-dispatch', 'validator-events'],
};

// Source-of-truth files whose most-recent commit stamps the Snapshot line.
export const SOURCE_PATHS = [
  'docs/architecture.md',
  'docs/design/azure-adapter.md',
  'docs/decisions/0011-agent-dispatch-topology.md',
  'services/agents/src/agents',
  'services/validator/src',
];

export const BODY_TEMPLATE = "## Source flow\n\n```text\nGitHub webhook -> intake -> validator + audit -> verdict gate -> role dispatcher\n                                                            -> agent -> GitHub PR\n```\n\n{{FSM_COUNT}} per-kind FSMs; {{PRIM_COUNT}} prims · {{KIND_COUNT}} kinds.\n\n## Agent roles present in source\n\n```text\n{{AGENT_ROW}}\n```\n\nThe role inventory includes experimental planning and operations handlers.\nIt does not imply all roles are deployed or supported. The intended initial\nworkflow uses Build and Review with CI and human-controlled merge.\n\n## Experimental Azure roles\n\nThe logical HTTP roles are ca-webhook, ca-agent, ca-admin, ca-cf-tunnel and\nca-terraform. Consumer roles include caj-validator, caj-orchestrator and\ncaj-tf-apply. validator-events carries intake; agent-runs-dispatch carries\nverdicts. These names identify roles, not a configured cloud environment.\n";
