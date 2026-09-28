#!/usr/bin/env python3
"""Assemble a qualification record (evals/qualification-protocol.json) for one candidate commit.

The record binds the exact configuration fingerprint to the lane results it has: the
deterministic lane's trial record from runtime/evals/run.py, and the model lane, which is
NOT_RUN until an explicitly authorized, budgeted job records it. Any NOT_RUN lane or any
failed threshold leaves `qualification` open. Nothing here runs a model or spends anything.

    python3 runtime/evals/qualify.py --deterministic REPORT.json [--out evals/qualification/<file>.json]
"""
import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# What each fingerprint field is computed from. Changing a listed file changes the fingerprint,
# which is what the protocol's requalification rule keys on.
PROMPT_AND_CONTEXT_PACKAGE = [
    'services/local-runtime/src/autonomy/controller.ts',
    'services/local-runtime/src/autonomy/reviewer.ts',
    'services/local-runtime/src/worker/entry.ts',
    'services/local-runtime/src/worker/protocol.ts',
]
TOOL_SURFACE = [
    'services/agents/src/runtime/codingAgent.ts',
    'services/local-runtime/src/worker/proxy.ts',
    'services/local-runtime/src/worker/supervisor.ts',
    'runtime/worker/Dockerfile',
]
SCORER = ['runtime/evals/run.py'] + sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'evals' / 'fixtures').rglob('*') if p.is_file())


def sha256_files(paths):
    """Same construction as runtime/evals/run.py scorer_sha256: path, NUL, bytes, NUL per file."""
    digest = hashlib.sha256()
    for relative in paths:
        path = ROOT / relative
        digest.update(relative.encode() + b'\0')
        digest.update(path.read_bytes() if path.exists() else b'<absent>')
        digest.update(b'\0')
    return digest.hexdigest()


def sha256_file(relative):
    return hashlib.sha256((ROOT / relative).read_bytes()).hexdigest()


def git(*args):
    return subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True).stdout.strip()


def corpus_cases_visible():
    corpus = json.loads((ROOT / 'evals' / 'corpus.json').read_text())
    return [c['id'] for c in corpus['cases'] if not c.get('heldOut')]


def sdk_version():
    lock = json.loads((ROOT / 'services/agents/package-lock.json').read_text())
    for name in ('node_modules/@anthropic-ai/claude-agent-sdk', 'node_modules/@anthropic-ai/sdk'):
        entry = lock.get('packages', {}).get(name)
        if entry:
            return f'{name.split("node_modules/")[1]}@{entry.get("version")}'
    return 'unknown'


def model_lane(report_path, authorization_path, protocol):
    """The model lane counts only from an authorized job's report; every trial counts, none is dropped."""
    if not report_path:
        return {'status': 'NOT_RUN', 'authorization': None, 'note': protocol['lanes']['model']['authorization']}, None
    if not authorization_path or not authorization_path.exists():
        raise SystemExit('a model-lane report needs the authorization record it ran under (--authorization)')
    authorization = json.loads(authorization_path.read_text())
    for field in ('authorizedBy', 'budgetUsd', 'repository', 'expiresAt', 'trustedJob'):
        if field not in authorization:
            raise SystemExit(f'authorization record lacks {field}')
    report = json.loads(report_path.read_text())
    trials = report['trials']
    outcomes = {'completed', 'error', 'timeout', 'unknown', 'cancelled'}
    for t in trials:
        for field in ('case', 'trial', 'kind', 'outcome', 'functionalSuccess', 'falseEscalation', 'criticalDetection', 'hardBoundaryViolations', 'estimatedCostUsd', 'latencySeconds', 'humanInterventions'):
            if field not in t:
                raise SystemExit(f'model-lane trial lacks {field}: {t.get("case")}/{t.get("trial")}')
        if t['outcome'] not in outcomes:
            raise SystemExit(f'model-lane trial has an unknown outcome {t["outcome"]!r}')
    corpus = json.loads((ROOT / protocol['corpus']['file']).read_text())
    expected_cases = [c['id'] for c in corpus['cases']]
    kinds = {c['id']: c['kind'] for c in corpus['cases']}
    # The corpus decides what a case is; a report cannot relabel a failing functional case adversarial.
    for t in trials:
        if t['case'] not in kinds:
            raise SystemExit(f'model-lane trial names a case outside the corpus: {t["case"]}')
        if t['kind'] != kinds[t['case']]:
            raise SystemExit(f'model-lane trial {t["case"]}/{t["trial"]} is labelled {t["kind"]!r}; the corpus says {kinds[t["case"]]!r}')
    if report.get('repository') != authorization['repository']:
        raise SystemExit('model-lane report names a repository the authorization does not')
    if not report.get('startedAt') or report['startedAt'] > authorization['expiresAt']:
        raise SystemExit('model-lane report started after the authorization expired, or does not say when it started')
    if report.get('treeDirty', True):
        raise SystemExit('model-lane report was produced on a dirty tree')
    functional = [t for t in trials if t['kind'] == 'functional']
    adversarial = [t for t in trials if t['kind'] == 'adversarial']
    per_case = {}
    for t in trials:
        per_case.setdefault(t['case'], []).append(t)
    # Every corpus case, visible and held-out, with at least the protocol's trials; nothing omitted.
    complete = all(len(per_case.get(c, [])) >= protocol['trialsPerCase'] for c in expected_cases) and not (set(per_case) - set(expected_cases))
    same_commit = report.get('candidateCommit') == (subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True, text=True).stdout.strip() or None)
    violations = sum(int(t.get('hardBoundaryViolations', 0)) for t in trials)
    success = sum(1 for t in functional if t.get('functionalSuccess')) / len(functional) if functional else None
    escalation = sum(1 for t in functional if t.get('falseEscalation')) / len(functional) if functional else None
    detection = sum(1 for t in adversarial if t.get('criticalDetection')) / len(adversarial) if adversarial else None
    thresholds = protocol['thresholds']
    met = complete and same_commit and violations == 0 and success is not None and success >= thresholds['functionalSuccessRateMin'] and (escalation or 0) <= thresholds['falseEscalationRateMax']
    lane = {
        'status': 'PASS' if met else 'FAIL',
        'sameCommit': same_commit,
        'casesMissingOrShort': [c for c in expected_cases if len(per_case.get(c, [])) < protocol['trialsPerCase']],
        'authorization': {k: authorization[k] for k in ('authorizedBy', 'budgetUsd', 'repository', 'expiresAt', 'trustedJob')},
        'candidateCommit': report.get('candidateCommit'),
        'trials': len(trials),
        'trialsPerCaseComplete': complete,
        'functionalSuccessRate': success,
        'falseEscalationRate': escalation,
        'criticalDetectionRate': detection,
        'hardBoundaryViolations': violations,
        'estimatedCostUsd': sum(float(t.get('estimatedCostUsd') or 0) for t in trials),
        'flakyCases': sorted({c for c, ts in per_case.items() if len({bool(t.get('functionalSuccess')) for t in ts}) > 1}),
        'errorsAndUnknown': sorted({t['case'] for t in trials if t.get('outcome') in ('error', 'unknown', 'timeout', 'cancelled')}),
    }
    return lane, authorization


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--deterministic', type=Path, help='Trial record written by runtime/evals/run.py --report')
    parser.add_argument('--policy', type=Path, default=ROOT / 'examples/autonomy-demo/autonomy-policy.json', help='The autonomy policy whose digest the fingerprint records')
    parser.add_argument('--ci', type=Path, help='CI evidence written by runtime/evals/ci-evidence.py on the same commit')
    parser.add_argument('--model', type=Path, help='Trial record of an authorized model-lane job')
    parser.add_argument('--authorization', type=Path, help='The owner authorization record that job ran under')
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    protocol = json.loads((ROOT / 'evals/qualification-protocol.json').read_text())
    corpus_bytes = (ROOT / protocol['corpus']['file']).read_bytes()
    policy = json.loads(args.policy.read_text())
    commit = git('rev-parse', 'HEAD') or None
    dirty = bool(git('status', '--porcelain'))
    deterministic = json.loads(args.deterministic.read_text()) if args.deterministic else None
    ci = json.loads(args.ci.read_text()) if args.ci else None
    # The policy pins the protocol by the digest of its bytes; a pin that names another protocol
    # means the protection the protocol describes is not in force.
    protocol_sha256 = sha256_file('evals/qualification-protocol.json')
    protocol_pinned = policy.get('verification', {}).get('evalProtocolSha256') == protocol_sha256
    # The fixtures on disk must be the pinned ones, ignored files included (the pin test walks the same way).
    fixtures_walk = hashlib.sha256()
    for path in sorted(p for p in (ROOT / 'evals' / 'fixtures').rglob('*') if p.is_file()):
        fixtures_walk.update(str(path.relative_to(ROOT)).encode() + b'\0' + path.read_bytes() + b'\0')
    fixtures_pin_file = ROOT / 'evals' / 'fixtures.sha256'
    fixtures_pinned = fixtures_pin_file.exists() and fixtures_walk.hexdigest() == fixtures_pin_file.read_text().strip()

    lanes = {}
    if deterministic:
        # Recomputed from the trials themselves; the summary is not trusted. The trials judged must be
        # exactly the trials the tree's fixtures declare for every visible case.
        trials = deterministic.get('trials', [])
        expected_trials = set()
        for case in corpus_cases_visible():
            spec = json.loads((ROOT / 'evals' / 'fixtures' / case / 'trials.json').read_text())
            for trial in spec['trials']:
                expected_trials.add((case, trial['name']))
        judged = {(t['case'], t['trial']) for t in trials}
        summary = {
            'trials': len(trials),
            'passed': sum(1 for t in trials if t.get('pass') is True and all(c.get('pass') for c in t.get('checks', [])) and t.get('checks')),
            'failed': sum(1 for t in trials if not (t.get('pass') is True and all(c.get('pass') for c in t.get('checks', [])) and t.get('checks'))),
            'hardBoundaryViolations': sum(1 for t in trials for c in t.get('checks', []) if c.get('boundary') and not c.get('pass')),
            'notRun': sorted({c for c, _ in expected_trials - judged}),
            'unexpectedTrials': sorted(f'{c}/{n}' for c, n in judged - expected_trials),
            'completed': deterministic.get('completed') is True,
        }
        violations = summary['hardBoundaryViolations']
        ran_all = not summary['notRun'] and not summary['unexpectedTrials'] and summary['completed']
        # One scorer per record: a report judged by another version of the runner or fixtures is not this evidence.
        same_scorer = deterministic.get('scorerSha256') == sha256_files(SCORER)
        # The report binds a commit only when the tree it ran on was that commit, unmodified, before and
        # after; recomputed from the report's own fields, not its flag.
        bound = (
            deterministic.get('candidateCommit') == commit
            and deterministic.get('finishedCommit') == commit
            and deterministic.get('treeDirty') is False
            and deterministic.get('finishedTreeDirty') is False
            and deterministic.get('finishedScorerSha256') == deterministic.get('scorerSha256')
            and deterministic.get('fixturesWalkMatchesPin') is True
            and deterministic.get('finishedFixturesWalkMatchesPin') is True
        )
        # The lane ran with the policy template this record fingerprints.
        same_policy = deterministic.get('policyTemplateSha256') == hashlib.sha256(json.dumps(policy, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        # The protocol's deterministic lane is the contributor suites, including the integration and
        # container suites that only the container drivers run; the corpus lane adds to them.
        ci_ok = ci is not None and ci.get('allPassed') is True and ci.get('candidateCommit') == commit and not ci.get('treeDirty', True) and ci.get('containers') is True
        corpus_ok = summary['trials'] > 0 and summary['failed'] == 0 and violations == 0 and ran_all
        status = 'PASS' if corpus_ok and same_scorer and bound and same_policy and ci_ok and protocol_pinned and not dirty and fixtures_pinned else 'FAIL'
        lanes['deterministic'] = {
            'status': status,
            'why': [reason for reason, held in [
                ('corpus trials failed or incomplete', not corpus_ok),
                ('scorer differs from this tree', not same_scorer),
                ('report not bound to this commit (dirty tree, other commit, or fixtures/runner changed during the run)', not bound),
                ('the lane ran with a different policy template than --policy', not same_policy),
                ('the fixtures on disk differ from evals/fixtures.sha256', not fixtures_pinned),
                ('contributor suite evidence missing, failing, without the container suites, or from another tree', not ci_ok),
                ('policy does not pin this protocol', not protocol_pinned),
                ('this tree is dirty: the fingerprint digests do not correspond to candidateCommit', dirty),
            ] if held],
            'reportSha256': hashlib.sha256(args.deterministic.read_bytes()).hexdigest(),
            'reportPath': str(args.deterministic),
            'scorerSha256': deterministic.get('scorerSha256'),
            'sameScorer': same_scorer,
            'bound': bound,
            'contributorSuites': ci and {'commit': ci.get('candidateCommit'), 'treeDirty': ci.get('treeDirty'), 'containers': ci.get('containers'), 'suites': [{'suite': r['suite'], 'exitCode': r['exitCode']} for r in ci.get('suites', [])]},
            'candidateCommit': deterministic.get('candidateCommit'),
            'sameCommit': deterministic.get('candidateCommit') == commit,
            'trials': summary['trials'],
            'passed': summary['passed'],
            'failed': summary['failed'],
            'hardBoundaryViolations': violations,
            'casesNotRun': summary.get('notRun', []),
            'startedAt': deterministic.get('startedAt'),
            'finishedAt': deterministic.get('finishedAt'),
            'author': deterministic.get('author'),
            'perCase': sorted({t['case'] for t in deterministic['trials']}),
            # Every trial, as judged, so the record can be audited without the report file.
            'trialRecords': [{k: t.get(k) for k in ('case', 'kind', 'trial', 'orchestration', 'expected', 'observed', 'checks', 'pass', 'hardBoundaryViolations', 'operatorActions', 'notTestableInLane', 'error', 'durationSeconds')} for t in deterministic['trials']],
        }
    else:
        lanes['deterministic'] = {'status': 'NOT_RUN'}
    lanes['model'], authorization = model_lane(args.model, args.authorization, protocol)
    thresholds = protocol['thresholds']
    evaluation = {
        'deterministicContractsPassRate': {'required': thresholds['deterministicContractsPassRate'], 'observed': (lanes['deterministic'].get('passed', 0) / lanes['deterministic']['trials']) if lanes['deterministic'].get('trials') else None, 'met': lanes['deterministic']['status'] == 'PASS'},
        'hardBoundaryViolations': {'required': thresholds['hardBoundaryViolations'], 'observed': lanes['deterministic'].get('hardBoundaryViolations'), 'met': lanes['deterministic'].get('hardBoundaryViolations') == 0 if lanes['deterministic']['status'] != 'NOT_RUN' else None},
        'functionalSuccessRateMin': {'required': thresholds['functionalSuccessRateMin'], 'observed': lanes['model'].get('functionalSuccessRate'), 'met': (lanes['model'].get('functionalSuccessRate') or 0) >= thresholds['functionalSuccessRateMin'] if lanes['model']['status'] != 'NOT_RUN' else None, 'lane': 'model'},
        'falseEscalationRateMax': {'required': thresholds['falseEscalationRateMax'], 'observed': lanes['model'].get('falseEscalationRate'), 'met': (lanes['model'].get('falseEscalationRate') or 0) <= thresholds['falseEscalationRateMax'] if lanes['model']['status'] != 'NOT_RUN' else None, 'lane': 'model'},
        'regressionToleranceFunctionalPercentagePoints': {'required': thresholds['regressionToleranceFunctionalPercentagePoints'], 'observed': None, 'met': None, 'lane': 'model', 'baseline': 'none registered'},
    }
    open_gates = [name for name, lane in lanes.items() if lane['status'] != 'PASS'] + ([] if protocol_pinned else ['protocol_pin_mismatch']) + (['qualify_tree_dirty'] if dirty else []) + ([] if ci and ci.get('containers') else ['container_suites_not_run']) + ([] if fixtures_pinned else ['fixtures_pin_mismatch'])
    record = {
        'version': 1,
        'protocolId': protocol['protocolId'],
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'fingerprint': {
            'candidateCommit': commit,
            'treeDirty': dirty,
            'modelId': (policy.get('execution', {}).get('models') or ['unknown'])[0],
            'sdkVersion': sdk_version(),
            'promptAndContextPackageSha256': sha256_files(PROMPT_AND_CONTEXT_PACKAGE),
            'toolSurfaceSha256': sha256_files(TOOL_SURFACE),
            'autonomyPolicySha256': hashlib.sha256(json.dumps(policy, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
            'workerImage': (deterministic or {}).get('workerImageId'),
            'evalProtocolPinnedByPolicy': protocol_pinned,
            'reviewerConfigSha256': deterministic['activations'][0]['pins'].get('REVIEWER_CONFIG_SHA256') if deterministic and deterministic.get('activations') else None,
            'acceptanceRunnerImage': deterministic['activations'][0]['pins'].get('ACCEPTANCE_RUNNER_IMAGE') if deterministic and deterministic.get('activations') else None,
            'corpusSha256': hashlib.sha256(corpus_bytes).hexdigest(),
            'scorerSha256': sha256_files(SCORER),
            'fixturesPinSha256': fixtures_pin_file.read_text().strip() if fixtures_pin_file.exists() else None,
            'protocolSha256': protocol_sha256,
            'policyTemplate': str(args.policy),
            'runLimits': policy.get('execution'),
            'authorizedBudgetUsd': authorization.get('budgetUsd') if authorization else None,
        },
        'fingerprintDefinitions': {
            'promptAndContextPackageSha256': PROMPT_AND_CONTEXT_PACKAGE,
            'toolSurfaceSha256': TOOL_SURFACE,
            'scorerSha256': SCORER,
            'autonomyPolicySha256': 'sha256 of the canonical JSON of --policy',
        },
        'lanes': lanes,
        'thresholds': evaluation,
        'baseline': 'none registered; only absolute thresholds apply',
        'qualification': 'open' if open_gates else 'met',
        'openGates': open_gates,
        'report': {
            'functionalSuccessRate': lanes['model'].get('functionalSuccessRate'),
            'criticalDetectionRate': lanes['model'].get('criticalDetectionRate'),
            'falseEscalationRate': lanes['model'].get('falseEscalationRate'),
            'hardBoundaryViolations': (lanes['deterministic'].get('hardBoundaryViolations') or 0) + (lanes['model'].get('hardBoundaryViolations') or 0),
            'repairCount': None,
            'estimatedCostUsd': lanes['model'].get('estimatedCostUsd', 0 if deterministic else None),
            'latencySeconds': sum(t.get('durationSeconds', 0) for t in deterministic['trials']) if deterministic else None,
            # No human took part in the deterministic lane; the orchestrated trials issue scripted operator
            # commands (approve, cancel, revoke, recover, reconcile), counted separately.
            'humanInterventions': None,
            'scriptedOperatorActions': (deterministic or {}).get('summary', {}).get('operatorActions') if deterministic else None,
            'errorsUnknownAndFlakyCases': [t['case'] + '/' + t['trial'] for t in deterministic['trials'] if t.get('error')] if deterministic else None,
        },
        'limits': protocol['limits'],
    }
    text = json.dumps(record, indent=2) + '\n'
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text)
    sys.stdout.write(text)


if __name__ == '__main__':
    main()
