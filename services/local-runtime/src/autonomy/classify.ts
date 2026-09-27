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
  changedFiles: number;
  changedBytes: number;
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
/** Built-in and always on. A policy may add critical paths but never remove these. */
export const BUILT_IN_PATH_RULES: readonly PathRule[] = [
  {
    code: 'ci_or_repository_automation',
    category: 'governance',
    pattern:
      /^\.github\/|(^|\/)\.gitlab-ci\.ya?ml$|^\.circleci\/|(^|\/)jenkinsfile$|^\.buildkite\/|(^|\/)azure-pipelines[^/]*\.ya?ml$|^\.travis\.ya?ml$|(^|\/)bitbucket-pipelines\.ya?ml$|^\.drone\.ya?ml$/,
  },
  { code: 'code_ownership', category: 'governance', pattern: /(^|\/)codeowners$/ },
  {
    code: 'developer_hooks',
    category: 'governance',
    pattern: /(^|\/)\.pre-commit-config\.ya?ml$|^\.husky\/|^\.githooks\/|(^|\/)\.gitattributes$/,
  },
  { code: 'factory_configuration', category: 'governance', pattern: /(^|\/)\.factory(\/|$)/ },
  { code: 'security_policy', category: 'governance', pattern: /(^|\/)security\.md$/ },
  {
    code: 'dependency_manifest',
    category: 'security_auth',
    pattern:
      /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.yarnrc(\.yml)?|requirements[^/]*\.(txt|in)|constraints[^/]*\.txt|pipfile(\.lock)?|pyproject\.toml|poetry\.lock|uv\.lock|setup\.py|setup\.cfg|go\.mod|go\.sum|cargo\.toml|cargo\.lock|gemfile(\.lock)?|[^/]*\.gemspec|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|composer\.(json|lock)|[^/]*\.csproj|packages\.lock\.json|nuget\.config|pubspec\.(yaml|lock)|mix\.(exs|lock)|\.gitmodules)$/,
  },
  {
    code: 'auth_or_security_module',
    category: 'security_auth',
    pattern:
      /(^|\/|[-_.])(auth|authn|authz|oauth|oidc|saml|sso|security|crypto|rbac|acl|session|sessions)([-_./]|$)/,
  },
  {
    code: 'secret_material_path',
    category: 'secrets_permissions',
    pattern:
      /(^|\/)\.env(\.[^/]*)?$|\.(pem|key|p12|pfx|jks|keystore|crt|cer|gpg|asc)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|(^|\/|[-_.])(secret|secrets|credential|credentials|permission|permissions)([-_./]|$)/,
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
      /(^|\/)(infra|infrastructure|terraform|pulumi|cdk|cloudformation|bicep|ansible)(\/|$)|\.(tf|tfvars|hcl|bicep)$/,
  },
  {
    code: 'data_schema_or_migration',
    category: 'destructive_data',
    pattern: /(^|\/)(migrations?|migrate|seeds?)(\/|$)|\.sql$/,
  },
  {
    code: 'license_or_notice',
    category: 'release_licensing',
    pattern:
      /(^|\/)(licen[cs]e|copying|notice|patents)([.-][^/]*)?$|(^|\/)(third[_-]party[^/]*|provenance\.md)$/,
  },
];

type Side = 'added' | 'removed' | 'both';
interface ContentRule {
  code: string;
  category: CriticalCategory;
  side: Side;
  pattern: RegExp;
}
/**
 * Tripwires over changed lines only (added and/or removed), not whole files, so
 * an unrelated mention elsewhere does not escalate. Security stems are unanchored
 * so camelCase identifiers (`verifyPassword`, `isAuthorized`) still match. They cannot prove safety;
 * the separate reviewer and protected acceptance suite are required as well.
 */
export const CONTENT_RULES: readonly ContentRule[] = [
  {
    code: 'auth_or_crypto_code',
    category: 'security_auth',
    side: 'both',
    pattern:
      /(authenticat|authoriz|oauth|openid|saml|jwt|jsonwebtoken|csrf|xsrf|passw(or)?d|passphrase|bcrypt|argon2|scrypt|pbkdf2|createhmac|createsign|createverify|timingsafeequal|setuid|seteuid)/i,
  },
  {
    code: 'code_execution_primitive',
    category: 'security_auth',
    side: 'added',
    pattern:
      /\b(child_process|execsync|spawnsync|subprocess|os\.system|os\.popen|shell\s*=\s*true|dangerouslysetinnerhtml|pickle\.loads?)\b|\beval\s*\(|\bnew\s+function\s*\(/i,
  },
  {
    code: 'transport_verification_disabled',
    category: 'security_auth',
    side: 'added',
    pattern:
      /rejectunauthorized\s*:\s*false|\bverify\s*=\s*false\b|insecureskipverify\s*:\s*true|node_tls_reject_unauthorized|\bcurl\b[^\n]*\s(-k|--insecure)\b/i,
  },
  {
    code: 'hidden_text_direction_controls',
    category: 'security_auth',
    side: 'added',
    pattern: /[‎‏‪-‮⁦-⁩]/,
  },
  {
    code: 'secret_material',
    category: 'secrets_permissions',
    side: 'added',
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}|\bsk-ant-[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  },
  {
    code: 'secret_or_credential_handling',
    category: 'secrets_permissions',
    side: 'both',
    pattern:
      /(secret|api[_-]?keys?|private[_-]?keys?|access[_-]?tokens?|refresh[_-]?tokens?|bearer|credential|client[_-]?secret)/i,
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
    pattern:
      /\b(deploy\w*|production|kubectl|docker\s+push|terraform\s+apply|helm\s+(install|upgrade))\b/i,
  },
  {
    code: 'infrastructure_resource',
    category: 'infrastructure_spend',
    side: 'both',
    pattern:
      /\b(terraform|pulumi|cloudformation|instance_type|machine_type|vm_size|node_count|autoscal\w*|max_replicas|replicas|billing)\b|\b(aws|azurerm|google)_[a-z0-9_]+\b/i,
  },
  {
    code: 'destructive_statement',
    category: 'destructive_data',
    side: 'added',
    pattern:
      /\b(drop\s+(table|database|schema|column|index|view)|truncate\s+table|delete\s+from|alter\s+table\s+\S+\s+drop)\b/i,
  },
  {
    code: 'destructive_operation',
    category: 'destructive_data',
    side: 'added',
    pattern:
      /\brm\s+-[a-z]*r|\b(rmtree|rmsync|rmdirsync|unlinksync|deletemany|dropdatabase)\b|\bfs\.(rm|rmdir|unlink)\s*\(|\bos\.(remove|unlink|rmdir)\s*\(|\bgit\s+push\s+(-f\b|--force)|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f/i,
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
    code: 'test_skip_or_failure_masking',
    category: 'governance',
    side: 'added',
    pattern:
      /\.(skip|only)\s*\(|\bx(it|describe|test)\s*\(|@pytest\.mark\.(skip|xfail)|@unittest\.skip|\bt\.skip(now)?\s*\(|\bskipif\b|--passwithnotests|continue-on-error\s*:\s*true|\|\|\s*true\b|--no-verify\b|allow_failure\s*:\s*true/i,
  },
  {
    code: 'review_or_protection_rules',
    category: 'governance',
    side: 'both',
    pattern:
      /\b(codeowners|required_status_checks|required_approving_review_count|branch[_-]?protection|enforce_admins|bypass_pull_request\w*|dismiss_stale_reviews)\b/i,
  },
];

const TEST_PATH =
  /(^|\/)(tests?|__tests__|specs?|testing)\/|[._-](test|spec)s?\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.go$|(^|\/)conftest\.py$/;
const ASSERTION =
  /\bassert\w*|\bexpect\s*\(|\.should\b|\bt\.(is|not|equal|deepequal|true|false|truthy|falsy|throws|rejects|errorf?|fatalf?)\b|\bpytest\.raises\b|\bself\.assert\w*/i;

function lines(content: string | null): string[] {
  return content === null ? [] : content.split(/\r?\n/);
}
/** Multiset line difference. Unchanged lines never trigger content rules. */
export function changedLines(oldContent: string | null, newContent: string | null) {
  const remaining = new Map<string, number>();
  for (const line of lines(oldContent)) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of lines(newContent)) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else added.push(line);
  }
  const removed: string[] = [];
  for (const [line, count] of remaining)
    for (let index = 0; index < count; index++) removed.push(line);
  return { added, removed };
}

export function classifyChanges(policy: AutonomyPolicy, manifest: ChangeManifest): Classification {
  const reasons = new Map<string, Reason>();
  const addReason = (code: string, category: ReasonCategory, path?: string) => {
    const reason: Reason = path === undefined ? { code, category } : { code, category, path };
    reasons.set(`${category}\u0000${code}\u0000${path ?? ''}`, reason);
  };
  let changedBytes = 0;
  for (const change of manifest.files) {
    const paths = [change.oldPath, change.newPath].filter((path): path is string => path !== null);
    for (const path of new Set(paths)) {
      const lowercasePath = path.toLowerCase();
      if (!policy.allowedPaths.some((prefix) => pathWithin(path, prefix)))
        addReason('outside_allowed_paths', 'out_of_scope', path);
      for (const rule of BUILT_IN_PATH_RULES)
        if (rule.pattern.test(lowercasePath)) addReason(rule.code, rule.category, path);
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

    const { added, removed } = changedLines(change.oldContent, change.newContent);
    for (const line of [...added, ...removed]) changedBytes += Buffer.byteLength(line) + 1;
    for (const rule of CONTENT_RULES) {
      const inspected =
        rule.side === 'added' ? added : rule.side === 'removed' ? removed : [...added, ...removed];
      if (inspected.some((line) => rule.pattern.test(line)))
        addReason(rule.code, rule.category, displayPath);
    }

    const oldIsTest = change.oldPath !== null && TEST_PATH.test(change.oldPath.toLowerCase());
    const newIsTest = change.newPath !== null && TEST_PATH.test(change.newPath.toLowerCase());
    if (oldIsTest && !newIsTest)
      addReason('test_file_removed', 'governance', change.oldPath ?? undefined);
    if (oldIsTest && newIsTest) {
      const removedAssertions = removed.filter((line) => ASSERTION.test(line)).length;
      const addedAssertions = added.filter((line) => ASSERTION.test(line)).length;
      if (removedAssertions > addedAssertions)
        addReason('test_assertions_reduced', 'governance', displayPath);
    }
  }
  if (manifest.files.length > policy.changeLimits.maxChangedFiles)
    addReason('change_exceeds_routine_file_limit', 'uninspectable');
  if (changedBytes > policy.changeLimits.maxChangedBytes)
    addReason('change_exceeds_routine_size_limit', 'uninspectable');
  // Nothing routine to merge; surface a no-op rather than auto-merging it.
  if (manifest.files.length === 0) addReason('empty_change', 'uninspectable');

  const sortedReasons = [...reasons.values()].sort(compareReasons);
  const boundedReasons =
    sortedReasons.length > MAX_REASONS
      ? [
          ...sortedReasons.slice(0, MAX_REASONS - 1),
          { code: 'reasons_truncated', category: 'uninspectable' as const },
        ]
      : sortedReasons;
  return {
    risk: boundedReasons.length ? 'critical' : 'routine',
    reasons: boundedReasons,
    changedFiles: manifest.files.length,
    changedBytes,
  };
}
export function compareReasons(left: Reason, right: Reason): number {
  const leftKey = `${left.category}\u0000${left.code}\u0000${left.path ?? ''}`;
  const rightKey = `${right.category}\u0000${right.code}\u0000${right.path ?? ''}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}
