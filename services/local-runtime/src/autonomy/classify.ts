import { SECRET_MATERIAL_CONTENT, SECRET_MATERIAL_PATH } from '../worker/secrets.js';
import type { AutonomyPolicy, CriticalCategory } from './policy.js';
import { pathWithin, requireAutonomy, requireRecord, requireRepositoryPath } from './schema.js';

export type GitMode = '100644' | '100755' | '120000' | '160000';
/**
 * One file in the complete change between the verified base tree and the frozen
 * candidate tree. Produced only by the trusted collector from Git objects, never
 * from worker-reported diffs. Content is the full file text on each side.
 */
export interface FileChange {
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath: string | null;
  newPath: string | null;
  oldMode: GitMode | null;
  newMode: GitMode | null;
  /** Null when that side is absent, binary, a symlink or a submodule. */
  oldContent: string | null;
  newContent: string | null;
  binary: boolean;
}
export interface ChangeManifest {
  /** False when the collector could not read every changed file. Never classified. */
  complete: boolean;
  files: FileChange[];
}
export type ReasonCategory = CriticalCategory | 'out_of_scope' | 'uninspectable';
export interface Reason {
  code: string;
  category: ReasonCategory;
  path?: string;
}
export interface Classification {
  risk: 'routine' | 'critical';
  reasons: Reason[];
  /** Decided on the full reason set, before any truncation of `reasons`. */
  publicationHold: boolean;
  changedFiles: number;
  changedBytes: number;
}
/**
 * Publication is itself an external effect: pushing to the base repository runs
 * its automation and installs its dependencies with that repository's CI
 * privileges, and anything pushed is disclosed to everyone with read access.
 * These reasons, and anything that could not be inspected (and so could hide
 * them), need approval before publish, not only before merge.
 */
const PUBLICATION_HOLD_CODES: readonly string[] = [
  'ci_or_repository_automation',
  'developer_hooks',
  'test_runner_configuration',
  'dependency_manifest',
  'dependency_manifest_executable',
  'dependency_configuration',
  'vendored_dependency',
  'code_execution_primitive',
  'secret_material',
  'secret_material_path',
  'environment_dump',
];
export function holdsPublication(reason: Reason): boolean {
  return reason.category === 'uninspectable' || PUBLICATION_HOLD_CODES.includes(reason.code);
}

/** Parse-time safety bounds, far above any policy limit, so parsing itself stays bounded. */
const MANIFEST_MAX_FILES = 10_000;
const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
const MAX_REASONS = 500;
const GIT_MODES: readonly string[] = ['100644', '100755', '120000', '160000'];

export function parseChangeManifest(value: unknown): ChangeManifest {
  requireRecord(value, ['complete', 'files'], 'change_manifest_invalid');
  requireAutonomy(value.complete === true, 'change_manifest_incomplete');
  requireAutonomy(
    Array.isArray(value.files) && value.files.length <= MANIFEST_MAX_FILES,
    'change_manifest_too_large',
  );
  let totalBytes = 0;
  const seenPaths = new Set<string>();
  for (const file of value.files as unknown[]) {
    requireRecord(
      file,
      ['status', 'oldPath', 'newPath', 'oldMode', 'newMode', 'oldContent', 'newContent', 'binary'],
      'change_manifest_invalid',
    );
    const change = file as unknown as FileChange;
    const hasOld = change.oldPath !== null;
    const hasNew = change.newPath !== null;
    requireAutonomy(
      (change.status === 'added' && !hasOld && hasNew) ||
        (change.status === 'deleted' && hasOld && !hasNew) ||
        (change.status === 'modified' && hasOld && hasNew && change.oldPath === change.newPath) ||
        (change.status === 'renamed' && hasOld && hasNew && change.oldPath !== change.newPath),
      'change_manifest_status_invalid',
    );
    requireAutonomy(typeof change.binary === 'boolean', 'change_manifest_invalid');
    for (const side of ['old', 'new'] as const) {
      const sidePath = change[`${side}Path`];
      const sideMode = change[`${side}Mode`];
      const sideContent = change[`${side}Content`];
      if (sidePath === null) {
        requireAutonomy(
          sideMode === null && sideContent === null,
          'change_manifest_absent_side_invalid',
        );
        continue;
      }
      requireRepositoryPath(sidePath, 'change_manifest_path_invalid');
      requireAutonomy(
        typeof sideMode === 'string' && GIT_MODES.includes(sideMode),
        'change_manifest_mode_invalid',
      );
      const inspectable = !change.binary && (sideMode === '100644' || sideMode === '100755');
      // A text side must carry its complete content; an uninspectable side carries none.
      requireAutonomy(
        inspectable
          ? typeof sideContent === 'string' && !sideContent.includes('\0')
          : sideContent === null,
        'change_manifest_content_invalid',
      );
      if (typeof sideContent === 'string') totalBytes += Buffer.byteLength(sideContent);
      const slot = `${side}:${sidePath.toLowerCase()}`;
      requireAutonomy(!seenPaths.has(slot), 'change_manifest_duplicate_path');
      seenPaths.add(slot);
    }
  }
  requireAutonomy(totalBytes <= MANIFEST_MAX_BYTES, 'change_manifest_too_large');
  return structuredClone(value as unknown as ChangeManifest);
}

interface PathRule {
  code: string;
  category: CriticalCategory;
  pattern: RegExp;
}
/**
 * Built-in and always on. A policy may add critical paths but never remove these.
 * Matched against the lowercased path; `CAMEL_CASE_SECURITY_NAME` covers
 * identifiers such as `requireAuth.js` on the original path.
 */
export const BUILT_IN_PATH_RULES: readonly PathRule[] = [
  {
    code: 'ci_or_repository_automation',
    category: 'governance',
    pattern:
      /^\.github\/|^\.gitlab\/|^\.gitea\/|^\.forgejo\/|^\.woodpecker(\/|\.ya?ml$)|(^|\/)\.gitlab-ci\.ya?ml$|^\.circleci\/|(^|\/)jenkinsfile$|^\.buildkite\/|(^|\/)azure-pipelines[^/]*\.ya?ml$|^\.travis\.ya?ml$|(^|\/)bitbucket-pipelines\.ya?ml$|^\.drone\.ya?ml$|^\.semaphore\/|^\.teamcity\/|(^|\/)(\.cirrus|appveyor|\.appveyor|cloudbuild|buildspec|bitrise|codemagic|\.mergify|mergify|\.kodiak|codecov|\.codecov|\.readthedocs)\.ya?ml$|(^|\/)(\.?renovate(rc)?|\.renovaterc|\.kodiak)(\.json5?|\.toml)?$|(^|\/)\.renovaterc$|(^|\/)action\.ya?ml$/,
  },
  { code: 'code_ownership', category: 'governance', pattern: /(^|\/)codeowners$/ },
  {
    code: 'developer_hooks',
    category: 'governance',
    pattern: /(^|\/)\.pre-commit-config\.ya?ml$|^\.husky\/|^\.githooks\/|(^|\/)\.gitattributes$/,
  },
  {
    code: 'test_runner_configuration',
    category: 'governance',
    pattern:
      /(^|\/)(jest[^/]*|vitest|vitest\.workspace|vite|karma\.conf|playwright|cypress|ava|wdio\.conf)(\.config)?\.[cm]?[jt]s(on)?$|(^|\/)(pytest\.ini|tox\.ini|noxfile\.py|phpunit\.xml(\.dist)?|\.mocharc(\.[a-z]+)?|\.nycrc(\.[a-z]+)?|\.c8rc(\.[a-z]+)?)$|(^|\/)(conftest\.py|babel\.config\.[cm]?[jt]s(on)?|\.babelrc(\.[a-z]+)?|jest\.setup\.[cm]?[jt]s|vitest\.setup\.[cm]?[jt]s|setuptests\.[cm]?[jt]s)$/,
  },
  { code: 'factory_configuration', category: 'governance', pattern: /(^|\/)\.factory(\/|$)/ },
  { code: 'security_policy', category: 'governance', pattern: /(^|\/)security\.md$/ },
  {
    // Data manifests and lockfiles: routine only with a passing dependency receipt.
    code: 'dependency_manifest',
    category: 'security_auth',
    pattern:
      /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|requirements[^/]*\.(txt|in)|constraints[^/]*\.txt|pipfile(\.lock)?|pyproject\.toml|poetry\.lock|uv\.lock|setup\.cfg|environment\.ya?ml|go\.mod|go\.sum|go\.work(\.sum)?|cargo\.toml|cargo\.lock|gemfile\.lock|pom\.xml|gradle\.properties|composer\.(json|lock)|packages\.lock\.json|pubspec\.(yaml|lock)|mix\.lock|bun\.lockb?|deno\.jsonc?|deno\.lock|libs\.versions\.toml|pdm\.lock|package\.resolved|podfile\.lock|cartfile(\.resolved|\.private)?|vcpkg(-configuration)?\.json|conanfile\.txt|conan\.lock|renv\.lock|rebar\.lock|paket\.(lock|dependencies|references)|packages\.config|module\.bazel\.lock|flake\.lock|shard\.(yml|lock)|stack\.yaml(\.lock)?|cabal\.project(\.freeze)?|elm\.json)$/,
  },
  {
    // Manifests that are programs: executed at install or build time, never made routine.
    code: 'dependency_manifest_executable',
    category: 'security_auth',
    pattern:
      /(^|\/)(setup\.py|gemfile|[^/]*\.gemspec|podfile|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|mix\.exs|[^/]*\.csproj|[^/]*\.fsproj|[^/]*\.vbproj|directory\.build\.(props|targets)|directory\.packages\.props|[^/]*\.(props|targets)|build\.sbt|project\.clj|deps\.edn|rebar\.config|package\.swift|conanfile\.py|module\.bazel|workspace(\.bazel|\.bzlmod)?|flake\.nix|default\.nix|shell\.nix|[^/]*\.cabal|vcpkg\.cmake)$/,
  },
  {
    // Registry, mirror, toolchain, wrapper, patch and install-hook configuration: never made routine.
    code: 'dependency_configuration',
    category: 'security_auth',
    pattern:
      /(^|\/)(\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.c?js|bunfig\.toml|nuget\.config|pip\.conf|\.pypirc|\.piprc|uv\.toml|\.condarc|\.gemrc|\.gitmodules|\.tool-versions|\.nvmrc|\.python-version|\.node-version|\.ruby-version|\.go-version|\.java-version|\.terraform-version|rust-toolchain(\.toml)?|global\.json|gradlew(\.bat)?|mvnw(\.cmd)?|gradle-wrapper\.properties|maven-wrapper\.properties|verification-metadata\.xml|verification-keyring\.keys)$|(^|\/)(\.cargo|\.m2|\.gradle|\.mvn|\.yarn|\.bundle|patches)\/|^[^/]+\.patch$/,
  },
  {
    // Committed third-party code: an edit here is an edit to a dependency.
    code: 'vendored_dependency',
    category: 'security_auth',
    pattern: /(^|\/)(vendor|vendored|third[_-]?party|node_modules|bower_components)\//,
  },
  {
    code: 'auth_or_security_module',
    category: 'security_auth',
    pattern:
      /(^|\/|[-_.])(auth(?!ors?([-_./]|$))[a-z0-9]*|oauth[a-z0-9]*|oidc|saml|sso|login[a-z0-9]*|logout|signin|signup|passport|jwt|security|crypto[a-z0-9]*|rbac|acl|session|sessions|permission|permissions|access[-_]?control)([-_./]|$)/,
  },
  {
    code: 'secret_material_path',
    category: 'secrets_permissions',
    pattern: SECRET_MATERIAL_PATH,
  },
  {
    code: 'deployment_definition',
    category: 'production_deployment',
    pattern:
      /(^|\/)(deploy|deploys|deployment|deployments|release|releases|k8s|kubernetes|helm|charts|kustomize|argocd|flux)(\/|$)|(^|\/)(dockerfile[^/]*|[^/]*\.dockerfile|containerfile|docker-compose[^/]*\.ya?ml|compose[^/]*\.ya?ml|procfile|app\.ya?ml|fly\.toml|vercel\.json|netlify\.toml|render\.ya?ml|serverless\.ya?ml|skaffold\.ya?ml)$/,
  },
  {
    code: 'infrastructure_definition',
    category: 'infrastructure_spend',
    pattern:
      /(^|\/)(infra|infrastructure|terraform|pulumi|cdk|cloudformation|bicep|ansible)(\/|$)|\.(tf|tfvars|hcl|bicep|tofu)$|\.tf\.json$/,
  },
  {
    code: 'data_schema_or_migration',
    category: 'destructive_data',
    pattern: /(^|\/)(migrations?|migrate|seeds?|alembic|prisma)(\/|$)|\.sql$|(^|\/)schema\.prisma$/,
  },
  {
    code: 'license_or_notice',
    category: 'release_licensing',
    pattern:
      /(^|\/)(licen[cs]e|copying|notice|patents)([.-][^/]*)?$|(^|\/)(third[_-]party[^/]*|provenance\.md)$/,
  },
];
const CAMEL_CASE_SECURITY_NAME =
  /[a-z0-9](Auth(?!ors?([A-Z0-9_.-]|$))|Oauth|OAuth|Login|Logout|Signin|SignIn|Passport|Jwt|JWT|Session|Permission|Rbac|RBAC|Acl|ACL|Crypto)([A-Z0-9_.-]|$)/;

type Side = 'added' | 'removed' | 'both';
interface ContentRule {
  code: string;
  category: CriticalCategory;
  side: Side;
  pattern: RegExp;
  /** Also match unchanged lines adjacent to a change (moved or reordered guards). */
  context?: boolean;
  /** Only in test files, where it means disabling a test rather than an API call. */
  testFilesOnly?: boolean;
  /** Not applied to prose, where the words describe rather than act. */
  skipProse?: boolean;
  /** A second pattern the same line must also match; two linear tests instead of one backtracking one. */
  requires?: RegExp;
}
/** Built from code points so no formatter can turn the class into invisible characters. */
const HIDDEN_DIRECTION_CONTROLS = new RegExp(
  `[${[
    0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  ]
    .map((codePoint) => `\\u${codePoint.toString(16).padStart(4, '0')}`)
    .join('')}]`,
);
/**
 * Best-effort tripwires over changed lines (plus adjacent context for security
 * guards), not whole files, so an unrelated mention elsewhere does not escalate.
 * Security stems are unanchored so camelCase identifiers still match. They can
 * be evaded and cannot prove safety; the separate reviewer and the protected
 * acceptance suite are required as well.
 */
export const CONTENT_RULES: readonly ContentRule[] = [
  {
    code: 'auth_or_crypto_code',
    category: 'security_auth',
    side: 'both',
    context: true,
    pattern:
      /(authenticat|authoriz|oauth|openid|saml|jwt|jsonwebtoken|csrf|xsrf|passw(or)?d|passphrase|bcrypt|argon2|scrypt|pbkdf2|createhmac|createsign|createverify|timingsafeequal|setuid|seteuid|permission|isallowed|isadmin|hasrole|requirerole|checkaccess|accesscontrol|forbidden|unauthori[sz]ed|authn|authz)/i,
  },
  {
    code: 'code_execution_primitive',
    category: 'security_auth',
    side: 'added',
    pattern:
      /\b(child_process|execsync|spawnsync|execfile|execfilesync|execa|subprocess|os\.system|os\.popen|shell\s*[:=]\s*true|dangerouslysetinnerhtml|pickle\.loads?|exec\.command|command::new|processbuilder|process\.start|runtime\.getruntime|shell_exec|passthru|proc_open|kernel\.system|io\.popen)\b|\b(eval|exec|spawn|fork|system|popen)\s*\(|\bnew\s+function\s*\(|\bfunction\s*\(\s*["'`]|`[^`]*\$\(|\beval\b/i,
  },
  {
    code: 'transport_verification_disabled',
    category: 'security_auth',
    side: 'added',
    pattern:
      /rejectunauthorized\s*:\s*false|\bverify\s*=\s*false\b|insecureskipverify\s*:\s*true|node_tls_reject_unauthorized|(^|\s)--insecure\b|\bcurl\s+-k\b/i,
  },
  {
    code: 'hidden_text_direction_controls',
    category: 'security_auth',
    side: 'added',
    pattern: HIDDEN_DIRECTION_CONTROLS,
  },
  {
    code: 'secret_material',
    category: 'secrets_permissions',
    side: 'added',
    pattern: SECRET_MATERIAL_CONTENT,
  },
  {
    code: 'secret_or_credential_handling',
    category: 'secrets_permissions',
    side: 'both',
    pattern:
      /(secret(?!ar)|api[_-]?keys?|private[_-]?keys?|access[_-]?tokens?|refresh[_-]?tokens?|bearer|credential|client[_-]?secret)/i,
  },
  {
    code: 'permission_change',
    category: 'secrets_permissions',
    side: 'both',
    pattern:
      /\b(chmod|chown|chgrp|setfacl|sudo|doas|privileged|cap_add|cap_sys_admin|allowprivilegeescalation|allow_privilege_escalation|runasuser|umask)\b|^\s*permissions\s*:/i,
  },
  {
    code: 'deployment_action',
    category: 'production_deployment',
    side: 'both',
    skipProse: true,
    pattern: /\bdeploy\b|\bdocker\s+push\b/i,
  },
  {
    code: 'deployment_action',
    category: 'production_deployment',
    side: 'both',
    skipProse: true,
    pattern: /\bvercel\b/i,
    requires: /--prod\b/i,
  },
  {
    code: 'deployment_action',
    category: 'production_deployment',
    side: 'both',
    skipProse: true,
    pattern: /\bkubectl\b/i,
    requires: /\b(apply|create|delete|rollout|scale|set|patch|replace|edit)\b/i,
  },
  {
    code: 'deployment_action',
    category: 'production_deployment',
    side: 'both',
    skipProse: true,
    pattern: /\bhelm\b/i,
    requires: /\b(install|upgrade|uninstall|rollback)\b/i,
  },
  {
    code: 'deployment_action',
    category: 'production_deployment',
    side: 'both',
    skipProse: true,
    pattern: /\b(terraform|tofu|pulumi)\b/i,
    requires: /\b(apply|destroy|import|up)\b/i,
  },
  {
    code: 'infrastructure_resource',
    category: 'infrastructure_spend',
    side: 'both',
    skipProse: true,
    pattern:
      /\bresource\s+"(aws|azurerm|google|azuread|kubernetes)_|\b(instance_type|machine_type|vm_size|node_count|min_replicas|max_replicas|autoscaling)\b/i,
  },
  {
    code: 'destructive_statement',
    category: 'destructive_data',
    side: 'added',
    pattern:
      /\b(drop\s+(table|database|schema|column|index|view|collection)|delete\s+from|alter\s+table\s+\S+\s+drop)\b|\btruncate\s+(table\s+)?["`]?[a-z_]|\bupdate\s+\S+\s+set\b(?!.*\bwhere\b)/i,
  },
  {
    code: 'destructive_operation',
    category: 'destructive_data',
    side: 'added',
    pattern:
      /\brm\s+-[a-z]*r|\b(rmtree|rmsync|rmdirsync|unlinksync|deletemany|dropdatabase|droptable|drop_table|drop_column|drop_all|dropcollection|drop_collection)\b|\.drop\s*\(\s*\)|\bfs\.(rm|rmdir|unlink)\s*\(|\bos\.(remove|unlink|rmdir)\s*\(|\bgit\s+push\s+(-f\b|--force)|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f/i,
  },
  {
    code: 'license_notice_removed',
    category: 'release_licensing',
    side: 'removed',
    pattern: /\b(licen[cs]e[sd]?|copyright|spdx-license-identifier)\b/i,
  },
  {
    code: 'publication_command',
    category: 'release_licensing',
    side: 'added',
    pattern:
      /\b(npm\s+publish|twine\s+upload|cargo\s+publish|gem\s+push|gh\s+release\s+create|git\s+tag|git\s+push\s+\S+\s+--tags)\b/i,
  },
  {
    code: 'test_skip_or_focus',
    category: 'governance',
    side: 'added',
    testFilesOnly: true,
    pattern:
      /\.(skip|only|todo|exclude)\s*\(|\bx(it|describe|test|context|specify)\b\s*[('"]|@pytest\.mark\.(skip|xfail)|@unittest\.skip|\bself\.skiptest\b|\bt\.skip(now)?\s*\(|\bskipif\b|pytest\.skip\s*\(|\bcollect_ignore\w*|@disabled\b|@ignore\b|#\[ignore\]|\bpending\s*[('"]/i,
  },
  {
    code: 'failure_masking',
    category: 'governance',
    side: 'added',
    pattern:
      /--passwithnotests|continue-on-error\s*:\s*true|\|\|\s*true\b|--no-verify\b|allow_failure\s*:\s*true|testpathignorepatterns|modulepathignorepatterns/i,
  },
  {
    code: 'review_or_protection_rules',
    category: 'governance',
    side: 'both',
    pattern:
      /\b(codeowners|required_status_checks|required_approving_review_count|branch[_-]?protection|enforce_admins|bypass_pull_request\w*|dismiss_stale_reviews)\b/i,
  },
];

const TEST_LOCATION =
  /(^|\/)(tests?|__tests__|specs?|testing|e2e|cypress|playwright|integration[-_]tests?)\/|[._-](test|spec|cy|e2e)s?\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|dart)$|(^|\/)conftest\.py$|tests?\.(java|kt|cs|scala|swift)$/;
const RUNNABLE_SOURCE =
  /\.([cm]?[jt]sx?|py|go|rb|java|kt|kts|cs|rs|php|swift|sh|bats|ex|exs|dart|scala|sc|groovy|c|cc|cpp|cxx|h|hpp|m|mm|lua|pl|r|jl|zig|clj|cljs|erl|hs|ml|fs)$/;
/** A file a test runner would execute: in a test location and a runnable source type. */
function isTestFile(path: string | null): boolean {
  if (path === null) return false;
  const lowercasePath = path.toLowerCase();
  return TEST_LOCATION.test(lowercasePath) && RUNNABLE_SOURCE.test(lowercasePath);
}
const PROSE = /\.(md|markdown|mdx|txt|rst|adoc)$/;
/**
 * A test that spawns a program is how a CLI is tested (OSS-22 live lane, F03): in a test-named file
 * a process-spawn primitive alone is not a critical addition. Shell interpretation (a shell or an
 * interpreter given code on its command line, `shell: true`, `exec`/`execSync`/`system`/`popen`,
 * command substitution) and dynamic code stay critical everywhere; a line that also names them is
 * not exempt, and helpers under a test directory are not test-named.
 */
const TEST_SPAWN = /\b(child_process|execfile|execfilesync|spawn|spawnsync|fork|subprocess)\b/i;
const SHELL_OR_DYNAMIC_EXECUTION =
  /\b(exec|execsync|system|popen)\b|shell\s*[:=]\s*true|\bnew\s+function\s*\(|\bfunction\s*\(\s*["'`]|`[^`]*\$\(|\beval\b|os\.system|os\.popen|shell_exec|passthru|proc_open|kernel\.system|io\.popen|exec\.command|command::new|processbuilder|process\.start|runtime\.getruntime|dangerouslysetinnerhtml|pickle\.loads?|["'`]-(l?c|e|p|eval)["'`]|--eval\b|\bget(status)?output\b|create_subprocess_shell|process\.spawn\s*\(\s*["'`]/i;
const TEST_NAMED =
  /[._-](test|spec|cy|e2e)s?\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|dart)$|(^|\/)conftest\.py$|tests?\.(java|kt|cs|scala|swift)$/;
function isTestNamed(path: string | null): boolean {
  if (path === null) return false;
  const lowercasePath = path.toLowerCase();
  return TEST_NAMED.test(lowercasePath) && RUNNABLE_SOURCE.test(lowercasePath);
}
function isTestSpawn(line: string): boolean {
  return TEST_SPAWN.test(line) && !SHELL_OR_DYNAMIC_EXECUTION.test(line);
}
const ASSERTION =
  /\bassert\w*|\bexpect\s*\(|\.should\b|\bt\.(is|not|equal|deepequal|true|false|truthy|falsy|throws|rejects|errorf?|fatalf?)\b|\bpytest\.raises\b|\bself\.assert\w*/i;
/** Longer lines are not pattern-matched (bounded regex cost); they need a human instead. */
export const MAX_INSPECTED_LINE_LENGTH = 4000;
/** Beyond these bounds the whole differing middle counts as changed (conservative, bounded cost). */
const MAX_DIFF_EDITS = 2000;
const MAX_DIFF_LINES = 50_000;
/** Shared by every file in one manifest, so many files cannot multiply the per-file bound. */
const MAX_MANIFEST_DIFF_STEPS = 20_000_000;
interface DiffBudget {
  steps: number;
}

function lines(content: string | null): string[] {
  return content === null ? [] : content.split(/\r?\n/);
}
export interface LineChanges {
  added: string[];
  removed: string[];
  /** Unchanged lines immediately before or after a change, on either side. */
  context: string[];
}
/**
 * Ordered line diff (Myers, after trimming the common prefix and suffix), so
 * moved and reordered lines count as changed. Beyond MAX_DIFF_EDITS the entire
 * differing middle is treated as changed: over-reporting, never under-reporting.
 */
export function changedLines(
  oldContent: string | null,
  newContent: string | null,
  budget: DiffBudget = { steps: MAX_MANIFEST_DIFF_STEPS },
): LineChanges {
  const oldLines = lines(oldContent);
  const newLines = lines(newContent);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  )
    suffix++;
  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const keptOld = new Uint8Array(oldMiddle.length);
  const keptNew = new Uint8Array(newMiddle.length);
  markCommonSubsequence(oldMiddle, newMiddle, keptOld, keptNew, budget);

  const added = newMiddle.filter((_, index) => !keptNew[index]);
  const removed = oldMiddle.filter((_, index) => !keptOld[index]);
  const context = new Set<string>();
  const neighbours = (all: string[], offset: number, kept: Uint8Array) => {
    for (let index = 0; index < kept.length; index++) {
      if (kept[index]) continue;
      for (const neighbour of [offset + index - 1, offset + index + 1]) {
        const line = all[neighbour];
        if (line !== undefined) context.add(line);
      }
    }
  };
  neighbours(oldLines, prefix, keptOld);
  neighbours(newLines, prefix, keptNew);
  if (oldMiddle.length === 0 && newMiddle.length === 0) context.clear();
  return { added, removed, context: [...context] };
}
function markCommonSubsequence(
  oldLines: string[],
  newLines: string[],
  keptOld: Uint8Array,
  keptNew: Uint8Array,
  budget: DiffBudget,
): void {
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  if (oldCount === 0 || newCount === 0 || oldCount + newCount > MAX_DIFF_LINES) return;
  if (budget.steps <= 0) return;
  const maxEdits = Math.min(oldCount + newCount, MAX_DIFF_EDITS);
  const offset = maxEdits + 1;
  const frontier = new Int32Array(2 * maxEdits + 3);
  const trace: Int32Array[] = [];
  for (let edits = 0; edits <= maxEdits; edits++) {
    trace.push(frontier.slice());
    for (let diagonal = -edits; diagonal <= edits; diagonal += 2) {
      const goDown =
        diagonal === -edits ||
        (diagonal !== edits &&
          (frontier[offset + diagonal - 1] as number) <
            (frontier[offset + diagonal + 1] as number));
      let oldIndex = goDown
        ? (frontier[offset + diagonal + 1] as number)
        : (frontier[offset + diagonal - 1] as number) + 1;
      let newIndex = oldIndex - diagonal;
      budget.steps--;
      while (
        oldIndex < oldCount &&
        newIndex < newCount &&
        oldLines[oldIndex] === newLines[newIndex]
      ) {
        oldIndex++;
        newIndex++;
        budget.steps--;
      }
      // Work budget exhausted: keep nothing, so every middle line is inspected.
      if (budget.steps <= 0) return;
      frontier[offset + diagonal] = oldIndex;
      if (oldIndex >= oldCount && newIndex >= newCount) {
        backtrack(trace, offset, edits, oldCount, newCount, keptOld, keptNew);
        return;
      }
    }
  }
  // Edit budget exhausted: keep nothing, so every middle line is inspected.
}
function backtrack(
  trace: Int32Array[],
  offset: number,
  finalEdits: number,
  oldCount: number,
  newCount: number,
  keptOld: Uint8Array,
  keptNew: Uint8Array,
): void {
  let oldIndex = oldCount;
  let newIndex = newCount;
  for (let edits = finalEdits; edits > 0; edits--) {
    const frontier = trace[edits] as Int32Array;
    const diagonal = oldIndex - newIndex;
    const goDown =
      diagonal === -edits ||
      (diagonal !== edits &&
        (frontier[offset + diagonal - 1] as number) < (frontier[offset + diagonal + 1] as number));
    const previousDiagonal = goDown ? diagonal + 1 : diagonal - 1;
    const previousOld = frontier[offset + previousDiagonal] as number;
    const previousNew = previousOld - previousDiagonal;
    while (oldIndex > previousOld && newIndex > previousNew && oldIndex > 0 && newIndex > 0) {
      oldIndex--;
      newIndex--;
      keptOld[oldIndex] = 1;
      keptNew[newIndex] = 1;
    }
    if (goDown) newIndex--;
    else oldIndex--;
  }
  while (oldIndex > 0 && newIndex > 0) {
    oldIndex--;
    newIndex--;
    keptOld[oldIndex] = 1;
    keptNew[newIndex] = 1;
  }
}

/**
 * True when the differing middle of a file has more lines than the diff will
 * examine (so every one of them would count as changed) and more characters than
 * the remaining byte budget. Linear, allocation-free, and conservative: it can
 * only mark a change oversized, never let content through uninspected.
 */
function exceedsWithoutSplitting(
  oldContent: string,
  newContent: string,
  remaining: number,
): boolean {
  let prefix = 0;
  const shorter = Math.min(oldContent.length, newContent.length);
  while (prefix < shorter && oldContent.charCodeAt(prefix) === newContent.charCodeAt(prefix))
    prefix++;
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    oldContent.charCodeAt(oldContent.length - 1 - suffix) ===
      newContent.charCodeAt(newContent.length - 1 - suffix)
  )
    suffix++;
  const middleCharacters = oldContent.length + newContent.length - 2 * (prefix + suffix);
  if (middleCharacters <= remaining) return false;
  let middleLines = 0;
  for (const [content, end] of [
    [oldContent, oldContent.length - suffix],
    [newContent, newContent.length - suffix],
  ] as const) {
    for (
      let index = content.indexOf('\n', prefix);
      index !== -1 && index < end;
      index = content.indexOf('\n', index + 1)
    ) {
      middleLines++;
      if (middleLines > MAX_DIFF_LINES) return true;
    }
  }
  return false;
}

const DOCUMENTATION = /\.(md|markdown|mdx|rst|adoc)$/;
const ENVIRONMENT_LINE = /^(export\s+|declare\s+-x\s+)?[A-Za-z_][A-Za-z0-9_]*=/;
/** Variables every process environment carries; a configuration file names none of them. */
const ENVIRONMENT_IDENTITY =
  /^(export\s+|declare\s+-x\s+)?(PATH|HOME|PWD|OLDPWD|HOSTNAME|SHLVL|_|TERM|USER|LOGNAME|SHELL|LANG|LC_ALL|TMPDIR)=/;
/**
 * The shape of `env` output: at least five non-empty lines, four in five of them `NAME=value`,
 * and at least two of the variables a process always has. A settings file with five keys is not.
 */
export function isEnvironmentDump(content: string): boolean {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 5) return false;
  const assignments = lines.filter((line) => ENVIRONMENT_LINE.test(line)).length;
  const identity = lines.filter((line) => ENVIRONMENT_IDENTITY.test(line)).length;
  return assignments * 5 >= lines.length * 4 && identity >= 2;
}
export function classifyChanges(policy: AutonomyPolicy, manifest: ChangeManifest): Classification {
  const reasons = new Map<string, Reason>();
  const addReason = (code: string, category: ReasonCategory, path?: string) => {
    const reason: Reason = path === undefined ? { code, category } : { code, category, path };
    reasons.set(`${category}\u0000${code}\u0000${path ?? ''}`, reason);
  };
  let changedBytes = 0;
  let contentBudgetExceeded = manifest.files.length > policy.changeLimits.maxChangedFiles;
  const diffBudget: DiffBudget = { steps: MAX_MANIFEST_DIFF_STEPS };
  for (const change of manifest.files) {
    const paths = [change.oldPath, change.newPath].filter((path): path is string => path !== null);
    for (const path of new Set(paths)) {
      const lowercasePath = path.toLowerCase();
      if (!policy.allowedPaths.some((prefix) => pathWithin(path, prefix)))
        addReason('outside_allowed_paths', 'out_of_scope', path);
      for (const rule of BUILT_IN_PATH_RULES)
        if (rule.pattern.test(lowercasePath)) addReason(rule.code, rule.category, path);
      if (CAMEL_CASE_SECURITY_NAME.test(path))
        addReason('auth_or_security_module', 'security_auth', path);
      for (const configured of policy.criticalPaths)
        if (pathWithin(path, configured.path))
          addReason('policy_critical_path', configured.category, path);
      for (const protectedPath of policy.verification.protectedPaths)
        if (pathWithin(path, protectedPath))
          addReason('protected_verification_asset', 'governance', path);
      // Confusable or direction-changing names can mislead the human who reviews a hold.
      if (!/^[\x20-\x7e]+$/.test(path)) addReason('non_ascii_path', 'uninspectable', path);
    }
    const displayPath = change.newPath ?? change.oldPath ?? '';
    for (const mode of [change.oldMode, change.newMode]) {
      if (mode === '120000') addReason('symbolic_link', 'uninspectable', displayPath);
      if (mode === '160000') addReason('submodule', 'uninspectable', displayPath);
    }
    if (change.binary) addReason('binary_content', 'uninspectable', displayPath);
    if (change.oldMode !== null && change.newMode !== null && change.oldMode !== change.newMode)
      addReason('file_mode_changed', 'secrets_permissions', displayPath);

    const oldIsTest = isTestFile(change.oldPath);
    const newIsTest = isTestFile(change.newPath);
    if (oldIsTest && !newIsTest)
      addReason('test_file_removed', 'governance', change.oldPath ?? undefined);

    // Limits are enforced before any pattern runs, so oversized input cannot stall classification.
    if (contentBudgetExceeded) continue;
    // Cheap pre-check on the raw strings before splitting: a huge differing region
    // that will not be diffed line by line cannot fit the remaining budget anyway.
    if (
      exceedsWithoutSplitting(
        change.oldContent ?? '',
        change.newContent ?? '',
        policy.changeLimits.maxChangedBytes - changedBytes,
      )
    ) {
      contentBudgetExceeded = true;
      continue;
    }
    const { added, removed, context } = changedLines(
      change.oldContent,
      change.newContent,
      diffBudget,
    );
    for (const line of added) changedBytes += Buffer.byteLength(line) + 1;
    for (const line of removed) changedBytes += Buffer.byteLength(line) + 1;
    if (changedBytes > policy.changeLimits.maxChangedBytes) {
      contentBudgetExceeded = true;
      continue;
    }
    const inspectable = (candidate: string[]) =>
      candidate.filter((line) => {
        if (line.length <= MAX_INSPECTED_LINE_LENGTH) return true;
        addReason('line_too_long_to_inspect', 'uninspectable', displayPath);
        return false;
      });
    const addedLines = inspectable(added);
    const removedLines = inspectable(removed);
    const contextLines = inspectable(context);
    const isProse = PROSE.test(displayPath.toLowerCase());
    for (const rule of CONTENT_RULES) {
      if (rule.testFilesOnly && !(oldIsTest || newIsTest)) continue;
      if (rule.skipProse && isProse) continue;
      const inspected = [
        ...(rule.side === 'removed' ? [] : addedLines),
        ...(rule.side === 'added' ? [] : removedLines),
        ...(rule.context ? contextLines : []),
      ];
      if (
        inspected.some(
          (line) =>
            rule.pattern.test(line) &&
            (rule.requires === undefined || rule.requires.test(line)) &&
            !(
              rule.code === 'code_execution_primitive' &&
              isTestNamed(change.newPath) &&
              isTestSpawn(line)
            ),
        )
      )
        addReason(rule.code, rule.category, displayPath);
    }
    // A new file made of NAME=value lines is an environment dump: what a coerced author commits
    // when told to disclose its surroundings. Held as secrets handling whatever the values are.
    // Documentation that lists settings is not a dump; a `.txt` or `.log` file may well be one.
    if (
      change.status === 'added' &&
      !DOCUMENTATION.test(displayPath.toLowerCase()) &&
      isEnvironmentDump(change.newContent ?? '')
    )
      addReason('environment_dump', 'secrets_permissions', displayPath);
    if (oldIsTest && newIsTest) {
      const removedAssertions = removedLines.filter((line) => ASSERTION.test(line)).length;
      const addedAssertions = addedLines.filter((line) => ASSERTION.test(line)).length;
      if (removedAssertions > addedAssertions)
        addReason('test_assertions_reduced', 'governance', displayPath);
    }
  }
  if (manifest.files.length > policy.changeLimits.maxChangedFiles)
    addReason('change_exceeds_routine_file_limit', 'uninspectable');
  if (contentBudgetExceeded) addReason('change_exceeds_routine_size_limit', 'uninspectable');
  // Nothing routine to merge; surface a no-op rather than auto-merging it.
  if (manifest.files.length === 0) addReason('empty_change', 'uninspectable');

  const allReasons = [...reasons.values()];
  const publicationHold = allReasons.some(holdsPublication);
  // Truncation keeps publication holds first, so a padded change cannot push them out.
  const prioritized = [
    ...allReasons.filter(holdsPublication).sort(compareReasons),
    ...allReasons.filter((reason) => !holdsPublication(reason)).sort(compareReasons),
  ];
  const boundedReasons =
    prioritized.length > MAX_REASONS
      ? [
          ...prioritized.slice(0, MAX_REASONS - 1),
          { code: 'reasons_truncated', category: 'uninspectable' as const },
        ].sort(compareReasons)
      : prioritized.sort(compareReasons);
  return {
    risk: boundedReasons.length ? 'critical' : 'routine',
    reasons: boundedReasons,
    publicationHold,
    changedFiles: manifest.files.length,
    changedBytes,
  };
}
export function compareReasons(left: Reason, right: Reason): number {
  const leftKey = `${left.category}\u0000${left.code}\u0000${left.path ?? ''}`;
  const rightKey = `${right.category}\u0000${right.code}\u0000${right.path ?? ''}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}
