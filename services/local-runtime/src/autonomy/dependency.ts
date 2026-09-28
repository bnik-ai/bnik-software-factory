import { randomUUID } from 'node:crypto';
import { Docker } from '../worker/docker.js';
import {
  type CandidateSubject,
  DEPENDENCY_FINDING_SEVERITIES,
  type DependencyFinding,
  type DependencyReceipt,
  type DependencySeverity,
  type PackageChange,
} from './evidence.js';
import { runSandbox } from './sandbox.js';
import { AutonomyError, requireAutonomy, requireRecord, sha256Json } from './schema.js';

/**
 * Dependency verification: the resolution sandbox reproduces lockfiles and computes
 * package deltas; a pluggable scanner adapter reports vulnerabilities over the
 * committed lockfiles (data, never executed). The receipt combines both. Only the
 * policy decides what a finding means.
 */
export interface Lockfile {
  path: string;
  content: string;
}
export interface ScanResult {
  status: 'complete' | 'error' | 'timeout';
  reason: string | null;
  findings: DependencyFinding[];
  /** When the scanner's vulnerability database was last updated, as it reports it. */
  databaseUpdatedAt: number;
  findingsOmittedBelow: Exclude<DependencySeverity, 'unknown'> | null;
}
export interface ScannerAdapter {
  /** Adapter name pinned in the policy (`dependencies.scanner.adapter`). */
  readonly name: string;
  /** Image identity pinned in the policy (`dependencies.scanner.image`). */
  image(): Promise<string>;
  scan(lockfiles: Lockfile[], signal: AbortSignal): Promise<ScanResult>;
}

/** Credential-free adapter for demo mode and tests; reads markers in lockfile content. */
export class FixtureScanner implements ScannerAdapter {
  readonly name = 'fixture';
  static readonly IMAGE = `sha256:${'f'.repeat(64)}`;
  constructor(private readonly now: () => number = Date.now) {}
  async image(): Promise<string> {
    return FixtureScanner.IMAGE;
  }
  async scan(lockfiles: Lockfile[], _signal: AbortSignal): Promise<ScanResult> {
    const findings: DependencyFinding[] = [];
    for (const lockfile of lockfiles) {
      let parsed: { packages?: Record<string, { version?: string }> };
      try {
        parsed = JSON.parse(lockfile.content) as typeof parsed;
      } catch {
        return {
          status: 'error',
          reason: 'lockfile_unparseable',
          findings: [],
          databaseUpdatedAt: this.now(),
          findingsOmittedBelow: null,
        };
      }
      for (const [key, entry] of Object.entries(parsed.packages ?? {})) {
        const name = key.split('node_modules/').pop() ?? key;
        const marker = /^fixture-vuln-(critical|high|medium|low|unknown)/.exec(name);
        if (marker)
          findings.push({
            id: `FIXTURE-${marker[1]?.toUpperCase()}-${findings.length + 1}`,
            severity: marker[1] as DependencySeverity,
            ecosystem: 'npm',
            name,
            version: entry.version ?? 'unknown',
            fixedVersion: null,
          });
      }
    }
    return {
      status: 'complete',
      reason: null,
      findings,
      databaseUpdatedAt: this.now() - 3_600_000,
      findingsOmittedBelow: null,
    };
  }
}

export interface TrivyScannerOptions {
  docker?: Docker;
  /** Pullable reference, ideally `repository@sha256:...`; the reported identity is the local image ID. */
  reference: string;
  /** Named Docker volume holding a Trivy cache with a downloaded database (operator-maintained). */
  cacheVolume: string;
  timeoutMs?: number;
}
const TRIVY_SEVERITIES: Record<string, DependencySeverity> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  UNKNOWN: 'unknown',
};
/**
 * Trivy adapter. Offline scan of lockfiles from a read-only database cache, in a
 * container without network. Verified flags (Trivy docs, September 27, 2026):
 * `fs`, `--scanners vuln`, `--format json`, `--skip-db-update`, `--skip-java-db-update`,
 * `--cache-dir`, `--offline-scan`.
 */
export class TrivyScanner implements ScannerAdapter {
  readonly name = 'trivy';
  private readonly docker: Docker;
  constructor(private readonly options: TrivyScannerOptions) {
    requireAutonomy(
      /^[A-Za-z0-9][A-Za-z0-9_./:@-]{1,255}$/.test(options.reference),
      'scanner_reference_invalid',
    );
    requireAutonomy(
      /^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/.test(options.cacheVolume),
      'scanner_cache_volume_invalid',
    );
    this.docker = options.docker ?? new Docker();
  }
  async image(): Promise<string> {
    const id = await this.docker.checked([
      'image',
      'inspect',
      this.options.reference,
      '--format',
      '{{.Id}}',
    ]);
    requireAutonomy(/^sha256:[0-9a-f]{64}$/.test(id), 'scanner_image_unavailable');
    return id;
  }
  private base(imageId: string): string[] {
    return [
      'run',
      '--rm',
      '-i',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--memory',
      '1g',
      '--memory-swap',
      '1g',
      '--cpus',
      '1',
      '--pids-limit',
      '64',
      '--log-driver',
      'none',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=268435456',
      '--mount',
      `type=volume,src=${this.options.cacheVolume},dst=/cache,readonly`,
      imageId,
    ];
  }
  async scan(lockfiles: Lockfile[], signal: AbortSignal): Promise<ScanResult> {
    const timeoutMs = this.options.timeoutMs ?? 300_000;
    const empty = (status: 'error' | 'timeout', reason: string): ScanResult => ({
      status,
      reason,
      findings: [],
      databaseUpdatedAt: 0,
      findingsOmittedBelow: null,
    });
    try {
      const imageId = await this.image();
      // Lockfiles are data and travel over stdin as a tar stream: the controller may itself run
      // in a container, so no path of its own is ever bind-mounted into the scanner.
      for (const lockfile of lockfiles)
        requireAutonomy(
          !lockfile.path.split('/').some((segment) => ['', '.', '..'].includes(segment)) &&
            !lockfile.path.includes('\\') &&
            lockfile.path.length <= 200,
          'lockfile_path_invalid',
        );
      const archive = ustar(
        lockfiles.map((lockfile) => ({
          path: lockfile.path,
          content: Buffer.from(lockfile.content),
        })),
      );
      const metadata = await this.docker.command(
        [
          ...this.base(imageId).slice(0, -1),
          '--entrypoint',
          'cat',
          imageId,
          '/cache/db/metadata.json',
        ],
        { timeoutMs: 30_000, signal },
      );
      if (metadata.code !== 0) return empty('error', 'scanner_database_missing');
      const parsedMetadata = JSON.parse(metadata.stdout) as {
        UpdatedAt?: string;
        DownloadedAt?: string;
      };
      const databaseUpdatedAt = Date.parse(parsedMetadata.UpdatedAt ?? '');
      if (!Number.isFinite(databaseUpdatedAt))
        return empty('error', 'scanner_database_metadata_invalid');
      const result = await this.docker.command(
        [
          ...this.base(imageId).slice(0, -1),
          '--entrypoint',
          '/bin/sh',
          imageId,
          '-c',
          'mkdir -p /tmp/scan && tar -xf - -C /tmp/scan && exec trivy fs --cache-dir /cache --skip-db-update --skip-java-db-update --offline-scan --scanners vuln --format json --quiet /tmp/scan',
        ],
        { timeoutMs, signal, limit: 64 * 1024 * 1024, input: archive },
      );
      if (result.code !== 0)
        return empty(
          signal.aborted ? 'timeout' : 'error',
          signal.aborted ? 'scanner_timed_out' : 'scanner_failed',
        );
      const report = JSON.parse(result.stdout) as {
        Results?: {
          Target?: string;
          Vulnerabilities?: {
            VulnerabilityID?: string;
            PkgName?: string;
            InstalledVersion?: string;
            FixedVersion?: string;
            Severity?: string;
          }[];
        }[];
      };
      const findings: DependencyFinding[] = [];
      const seen = new Set<string>();
      for (const entry of report.Results ?? [])
        for (const vulnerability of entry.Vulnerabilities ?? []) {
          const id = vulnerability.VulnerabilityID ?? 'UNKNOWN';
          const name = vulnerability.PkgName ?? 'unknown';
          const version = vulnerability.InstalledVersion ?? 'unknown';
          const key = `${id}\u0000${name}\u0000${version}`;
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({
            id: id.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 64),
            severity: TRIVY_SEVERITIES[vulnerability.Severity ?? ''] ?? 'unknown',
            ecosystem: 'npm',
            name: name.slice(0, 256),
            version: version.slice(0, 128),
            fixedVersion: vulnerability.FixedVersion
              ? vulnerability.FixedVersion.slice(0, 128)
              : null,
          });
          if (findings.length >= 5000) break;
        }
      return {
        status: 'complete',
        reason: null,
        findings,
        databaseUpdatedAt,
        findingsOmittedBelow: null,
      };
    } catch (error) {
      return empty('error', error instanceof AutonomyError ? error.reason : 'scanner_failed');
    }
  }
}
/** Minimal ustar writer for regular files (paths up to 255 bytes through the prefix field). */
export function ustar(files: { path: string; content: Buffer }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    let name = file.path;
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const slash = name.lastIndexOf('/', 154);
      requireAutonomy(
        slash > 0 && Buffer.byteLength(name.slice(slash + 1)) <= 100,
        'tar_path_too_long',
      );
      prefix = name.slice(0, slash);
      name = name.slice(slash + 1);
    }
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${file.content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write(prefix, 345, 155, 'utf8');
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, file.content);
    const padding = (512 - (file.content.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export interface DependencyVerificationOptions {
  docker?: Docker;
  /** Worker image for the resolution sandbox. */
  image: string;
  archive: Buffer;
  patch: string;
  candidateTree: string;
  /** Data-manifest paths of the change (the classifier's `dependency_manifest` reasons). */
  manifestPaths: string[];
  subject: CandidateSubject;
  scanner: ScannerAdapter;
  signal: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
}
export interface DependencyVerificationRun {
  receipt: DependencyReceipt;
  reason: string | null;
}
interface ResolveOutput {
  status: 'complete' | 'unsupported';
  tree?: string;
  manifests?: string[];
  resolution?: 'reproduced' | 'mismatch';
  manifestFieldsChanged?: string[];
  installScriptsChanged?: boolean;
  packages?: { added: PackageChange[]; removed: PackageChange[]; upgraded: PackageChange[] };
  lockfiles?: Lockfile[];
  unsupported?: string[];
}
/** Runs resolution and scanning and writes the receipt the policy consumes. */
export async function runDependencyVerification(
  options: DependencyVerificationOptions,
): Promise<DependencyVerificationRun> {
  const now = options.now ?? Date.now;
  const scannerImage = await options.scanner.image();
  const receipt = (
    fields: Partial<DependencyReceipt> & Pick<DependencyReceipt, 'status'>,
    databaseUpdatedAt: number,
  ): DependencyReceipt => ({
    version: 1,
    kind: 'dependency',
    runId: randomUUID(),
    subject: options.subject,
    scanner: { adapter: options.scanner.name, image: scannerImage, databaseUpdatedAt },
    manifests: options.manifestPaths,
    resolution: 'not_attempted',
    manifestFieldsChanged: [],
    installScriptsChanged: false,
    packages: { added: [], removed: [], upgraded: [] },
    findings: [],
    findingsOmittedBelow: null,
    completedAt: now(),
    ...fields,
  });
  let output: ResolveOutput;
  try {
    const result = await runSandbox({
      docker: options.docker,
      image: options.image,
      runId: randomUUID(),
      entry: 'src/autonomy/sandbox/resolve.ts',
      input: {
        archive: options.archive.toString('base64'),
        patch: options.patch,
        expectedTree: options.candidateTree,
        manifests: options.manifestPaths,
      },
      timeoutMs: options.timeoutMs ?? 900_000,
      signal: options.signal,
      network: 'registry',
      outputLimit: 64 * 1024 * 1024,
    });
    const raw = result.output as { ok?: unknown; reason?: unknown; status?: unknown };
    if (raw.ok !== true)
      return {
        receipt: receipt({ status: 'error' }, now()),
        reason:
          typeof raw.reason === 'string' && /^[a-z_]{1,64}$/.test(raw.reason)
            ? raw.reason
            : 'resolution_failed',
      };
    output = raw as ResolveOutput;
  } catch (error) {
    const reason = error instanceof AutonomyError ? error.reason : 'resolution_sandbox_failed';
    return {
      receipt: receipt({ status: reason === 'sandbox_timed_out' ? 'timeout' : 'error' }, now()),
      reason,
    };
  }
  if (output.status === 'unsupported')
    return { receipt: receipt({ status: 'unsupported' }, now()), reason: 'ecosystem_unsupported' };
  requireRecord(
    output,
    [
      'version',
      'ok',
      'status',
      'tree',
      'manifests',
      'resolution',
      'manifestFieldsChanged',
      'installScriptsChanged',
      'packages',
      'lockfiles',
      'elapsedMs',
    ],
    'resolution_output_invalid',
  );
  requireAutonomy(output.tree === options.candidateTree, 'resolution_tree_mismatch');
  requireAutonomy(
    sha256Json([...(output.manifests ?? [])].sort()) ===
      sha256Json([...options.manifestPaths].sort()),
    'resolution_manifests_mismatch',
  );
  const scan = await options.scanner.scan(output.lockfiles ?? [], options.signal);
  if (scan.status !== 'complete')
    return {
      receipt: receipt({ status: scan.status }, scan.databaseUpdatedAt || now()),
      reason: scan.reason,
    };
  for (const finding of scan.findings)
    requireAutonomy(
      (DEPENDENCY_FINDING_SEVERITIES as readonly string[]).includes(finding.severity),
      'scanner_output_invalid',
    );
  return {
    receipt: receipt(
      {
        status: 'complete',
        resolution: output.resolution as 'reproduced' | 'mismatch',
        manifestFieldsChanged: output.manifestFieldsChanged ?? [],
        installScriptsChanged: output.installScriptsChanged === true,
        packages: output.packages ?? { added: [], removed: [], upgraded: [] },
        findings: scan.findings,
        findingsOmittedBelow: scan.findingsOmittedBelow,
      },
      scan.databaseUpdatedAt,
    ),
    reason: null,
  };
}
