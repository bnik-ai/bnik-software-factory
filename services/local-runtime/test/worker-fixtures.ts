import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { CodingJob } from '../src/worker/protocol.js';
import { sha256 } from '../src/worker/protocol.js';
export function source(files?: Record<string, string>): Buffer {
  return execFileSync(
    'python3',
    [
      '-c',
      "import importlib.util,sys,json;spec=importlib.util.spec_from_file_location('demo','../../runtime/worker/demo-source.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);d=json.load(sys.stdin);sys.stdout.buffer.write(m.archive(d if d is not None else m.FILES))",
    ],
    { input: JSON.stringify(files ?? null), maxBuffer: 10 * 1024 * 1024 },
  );
}
export function fixture(archive: Buffer, overrides: Partial<CodingJob> = {}): CodingJob {
  return {
    id: randomUUID(),
    mode: 'demo',
    repository: 'example/factory-demo',
    sourceCommit: '1'.repeat(40),
    archiveSha256: sha256(archive),
    prompt: 'Fix sum.js and execute the checks.',
    maxTurns: 2,
    timeoutMs: 30_000,
    fixtureCommand: "printf 'module.exports = (a, b) => a + b;\\n' > sum.js",
    tests: [
      'node --test sum.test.js',
      'python3 -m unittest -v',
      'bash --version | head -1; git --version; node --version; python3 --version',
    ],
    ...overrides,
  };
}
