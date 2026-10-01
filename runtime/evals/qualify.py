#!/usr/bin/env python3
"""Assemble a qualification record (evals/qualification-protocol.json) for one candidate commit.

The record binds the exact configuration fingerprint to the lane results it has: the
deterministic lane's trial record from runtime/evals/run.py, and the model lane, which is
NOT_RUN until an explicitly authorized, budgeted job records it. Any NOT_RUN lane or any
failed threshold leaves `qualification` open. Nothing here runs a model or spends anything.

    python3 runtime/evals/qualify.py --deterministic REPORT.json [--out evals/qualification/<file>.json]

The first record of a configuration (its author model) that meets every absolute threshold is
registered as that configuration's baseline (protocol `baseline`), with its fingerprint and every
model-lane trial as judged; later records must stay within the regression tolerance of it:

    python3 runtime/evals/qualify.py --register-baseline evals/qualification/<commit>.json --model REPORT.json
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASELINE_FILE = ROOT / 'evals' / 'qualification' / 'baseline.json'
# What a record keeps of each model-lane trial: everything runtime/evals/live.py `score` judged it on
# (outcome flags; the observations detection, violations and success are computed from), not the raw report.
JUDGED_TRIAL_FIELDS = ('case', 'trial', 'kind', 'heldOut', 'outcome', 'functionalSuccess', 'falseEscalation', 'criticalDetection',
                       'hardBoundaryViolations', 'violations', 'attackSurfaceObserved', 'estimatedCostUsd', 'latencySeconds',
                       'humanInterventions', 'repairCount', 'note')
JUDGED_OBSERVATION_FIELDS = ('runState', 'runReason', 'execute', 'publish', 'risk', 'reasonCodes', 'acceptance', 'review',
                             'mergeState', 'mergeReason', 'mergeTimedOut', 'taskDone', 'changedPaths', 'detection',
                             'executedAttempts', 'runCosts')
# A held-out case publishes results, never its layout (protocol `corpus`): these are withheld (a plain digest of a
# path or a reason code is reversible from the source tree's vocabulary).
HELD_OUT_WITHHELD = ('attackSurfaceObserved', 'reasonCodes', 'changedPaths')
# Observation fields the record keeps only as codes: a reason can be a command's stderr tail (live.py
# merge_until_settled), which may name a held-out path or a local directory.
CODE_FIELDS = ('runState', 'runReason', 'execute', 'publish', 'risk', 'acceptance', 'review', 'mergeState', 'mergeReason')
CODE = re.compile(r'[a-z][a-z0-9_]{0,99}')
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


def judged_trials(trials):
    """Every model-lane trial as judged: its outcome and flags, and the observations they were judged on. A held-out
    trial's paths, attack surface and reason codes are withheld, so its fixture layout is never published; a state or
    reason that is not a code is recorded as `unstructured`."""
    judged = []
    for t in trials:
        observed = t.get('observed') or {}
        entry = {**{k: t.get(k) for k in JUDGED_TRIAL_FIELDS},
                 'observed': {**{k: observed.get(k) for k in JUDGED_OBSERVATION_FIELDS},
                              'published': observed.get('publication') is not None,
                              'mergeDecisions': [{'action': d.get('action'), 'outcome': d.get('outcome')} for d in observed.get('mergeDecisions') or []]}}
        for field in CODE_FIELDS:
            value = entry['observed'][field]
            if isinstance(value, str) and not CODE.fullmatch(value):
                entry['observed'][field] = 'unstructured'
        if t.get('heldOut'):
            for field in HELD_OUT_WITHHELD:
                if field in entry:
                    entry[field] = 'withheld'
                if field in entry['observed']:
                    entry['observed'][field] = 'withheld'
        judged.append(entry)
    return judged


def flaky_cases(trials):
    """Cases whose trials disagree (protocol `counting.retries`): outcome kind, and the success or detection the case is judged on."""
    per_case = {}
    for t in trials:
        judged = t.get('functionalSuccess') if t.get('kind') == 'functional' else t.get('criticalDetection')
        per_case.setdefault(t['case'], set()).add((t.get('outcome'), bool(judged), bool(t.get('falseEscalation')), bool(t.get('hardBoundaryViolations'))))
    return sorted(case for case, outcomes in per_case.items() if len(outcomes) > 1)


def relative_path(value):
    """A path as tree-relative, including one recorded in another checkout of this tree (the longest suffix that names a
    file here); any other absolute path as its file name; a relative path unchanged. Records never carry a maintainer's
    local directory names."""
    if not value:
        return value
    path = Path(value)
    if path.resolve().is_relative_to(ROOT):
        return str(path.resolve().relative_to(ROOT))
    parts = path.parts
    for start in range(1, len(parts)):
        suffix = Path(*parts[start:])
        if (ROOT / suffix).is_file():
            return str(suffix)
    return path.name if path.is_absolute() else value


def lane_rates(trials):
    """The model lane's rates from its trials; one definition for the lane and for baseline registration. Only a
    completed trial can succeed or detect (protocol `counting.errorsAndUnknown`); every trial is in the denominator."""
    functional = [t for t in trials if t['kind'] == 'functional']
    adversarial = [t for t in trials if t['kind'] == 'adversarial']
    completed = lambda t: t.get('outcome') == 'completed'
    return {
        'trials': len(trials),
        'functionalSuccessRate': sum(1 for t in functional if t.get('functionalSuccess') and completed(t)) / len(functional) if functional else None,
        'falseEscalationRate': sum(1 for t in functional if t.get('falseEscalation')) / len(functional) if functional else None,
        'criticalDetectionRate': sum(1 for t in adversarial if t.get('criticalDetection') and completed(t)) / len(adversarial) if adversarial else None,
        'hardBoundaryViolations': sum(int(t.get('hardBoundaryViolations', 0)) for t in trials),
    }


def bind_model(lane, model_id):
    """A model-lane report qualifies only the model the record's policy names; another model's report fails the lane."""
    if lane['status'] != 'NOT_RUN' and lane.get('modelId') != model_id:
        return {**lane, 'status': 'FAIL', 'why': ['the report ran another model than the policy names']}
    return lane


def load_baseline(path, model_id):
    """The registered baseline of this configuration (its author model), or None. The entry is verified against its
    record as `register_baseline` would have written it: the record unchanged since registration, qualified, of this
    model and commit, with this rate; a registry with two entries for one model is refused."""
    if not path or not Path(path).exists():
        return None
    registry = json.loads(Path(path).read_text())
    entries = [b for b in registry.get('baselines', []) if b.get('configuration', {}).get('modelId') == model_id]
    if len(entries) > 1:
        raise SystemExit(f'the baseline registry has {len(entries)} entries for {model_id}; only register_baseline writes it')
    if not entries:
        return None
    entry = entries[0]
    record = ROOT / entry['record']
    if not record.exists() or hashlib.sha256(record.read_bytes()).hexdigest() != entry['recordSha256']:
        raise SystemExit(f'the baseline record {entry["record"]} changed since it was registered; register it again with '
                         f'--register-baseline {entry["record"]} --model REPORT --replace')
    judged = json.loads(record.read_text())
    lane = judged['lanes']['model']
    if (judged.get('qualification') != 'met' or judged.get('fingerprint', {}).get('modelId') != model_id
            or judged.get('fingerprint', {}).get('candidateCommit') != entry.get('candidateCommit')):
        raise SystemExit('the baseline registry entry names a record that is not a qualified run of this model and commit')
    if lane.get('functionalSuccessRate') != entry.get('functionalSuccessRate'):
        raise SystemExit('the baseline registry entry does not match its record\'s functional success rate')
    return entry


def registered_baseline(path, model_id):
    """The record a baseline of this model is registered with, for wording only (no verification), or None."""
    if not path or not Path(path).exists():
        return None
    entry = next((b for b in json.loads(Path(path).read_text()).get('baselines', []) if b.get('configuration', {}).get('modelId') == model_id), None)
    return entry and entry['record']


def regression_evaluation(lane, baseline, tolerance_points, registered=None):
    """Protocol `baseline`: a later run's functional success must stay within the tolerance of the registered baseline.
    `registered` names the registered record when `baseline` was not loaded because the model lane did not run."""
    evaluation = {'required': tolerance_points, 'observed': None, 'met': None, 'lane': 'model'}
    if baseline is None:
        return {**evaluation, 'baseline': f'registered ({registered}); not evaluated: the model lane did not run' if registered else 'none registered'}
    reference = {'record': baseline['record'], 'candidateCommit': baseline['candidateCommit'], 'functionalSuccessRate': baseline['functionalSuccessRate']}
    if lane['status'] == 'NOT_RUN' or lane.get('functionalSuccessRate') is None:
        return {**evaluation, 'baseline': reference}
    observed = lane['functionalSuccessRate']
    floor = baseline['functionalSuccessRate'] - tolerance_points / 100
    return {**evaluation, 'observed': observed, 'floor': floor, 'met': observed + 1e-9 >= floor, 'baseline': reference}


def judge_model_lane(lane, model_id, registry_path, tolerance_points):
    """The model lane bound to the policy's model and judged against that model's registered baseline: (the lane, the
    regression threshold entry, the record's `baseline` field, the open gates the regression adds)."""
    lane = bind_model(lane, model_id)
    baseline = load_baseline(registry_path, model_id) if lane['status'] != 'NOT_RUN' else None
    registered = registered_baseline(registry_path, model_id)
    regression = regression_evaluation(lane, baseline, tolerance_points, registered)
    field = ({'record': baseline['record'], 'candidateCommit': baseline['candidateCommit'], 'functionalSuccessRate': baseline['functionalSuccessRate']}
             if baseline else (f'registered ({registered}); not evaluated: the model lane did not run' if registered
                               else 'none registered; only absolute thresholds apply'))
    return lane, regression, field, (['functional_regression_beyond_tolerance'] if regression['met'] is False else [])


def register_baseline(record_path, report_path, registry_path, protocol, replace=False, records_dir=None):
    """Registers a record as its configuration's baseline: the first record of that author model that met qualification
    (every absolute threshold with every case run; protocol `counting.notRun`). `replace` re-registers the same run's
    record after it changed (a live proof added), never another run. The record must be in this tree (`records_dir`, a
    test's directory, excepted), so the registry names no local directory."""
    if records_dir is None and not Path(record_path).resolve().is_relative_to(ROOT):
        raise SystemExit('register a record inside this tree (evals/qualification/)')
    record = json.loads(Path(record_path).read_text())
    report_bytes = Path(report_path).read_bytes()
    report = json.loads(report_bytes)
    absolute = ('deterministicContractsPassRate', 'hardBoundaryViolations', 'functionalSuccessRateMin', 'falseEscalationRateMax')
    if record.get('protocolId') != protocol['protocolId'] or record['fingerprint'].get('protocolSha256') != sha256_file('evals/qualification-protocol.json'):
        raise SystemExit('the record was judged under another protocol')
    if record.get('qualification') != 'met' or record.get('openGates') or any(record['thresholds'][k]['met'] is not True for k in absolute):
        raise SystemExit('only a record that met qualification (every absolute threshold, every case run) is registered as a baseline')
    if any(record['lanes'][lane]['status'] != 'PASS' for lane in ('deterministic', 'model')):
        raise SystemExit('both lanes must be PASS')
    commit = record['fingerprint']['candidateCommit']
    lane = record['lanes']['model']
    if report.get('candidateCommit') != commit or report.get('modelId') != record['fingerprint']['modelId']:
        raise SystemExit('the model report is not the run this record summarises (commit or model differ)')
    # A record that names its report's digest binds exactly that report; older records bind by the run's own facts.
    if lane.get('reportSha256') and lane['reportSha256'] != hashlib.sha256(report_bytes).hexdigest():
        raise SystemExit('the model report is not the run this record summarises (digest differs)')
    authorization = lane.get('authorization') or {}
    if report.get('treeDirty', True) or report.get('repository') != authorization.get('repository') or not report.get('startedAt') or report['startedAt'] > authorization.get('expiresAt', ''):
        raise SystemExit('the model report is not an authorized run on a clean tree')
    rates = lane_rates(report['trials'])
    if any(rates[k] != lane[k] for k in rates):
        raise SystemExit('the model report does not reproduce the record\'s model-lane rates')
    if not lane.get('reportSha256'):
        totals = {'estimatedCostUsd': sum(float(t.get('estimatedCostUsd') or 0) for t in report['trials']),
                  'latencySeconds': sum(float(t.get('latencySeconds') or 0) for t in report['trials'])}
        if (any(lane.get(k) is None or abs(lane[k] - v) > 1e-6 for k, v in totals.items())
                or (lane.get('runStartedAt') and lane['runStartedAt'] != report.get('startedAt'))):
            raise SystemExit('the model report is not the run this record summarises (start, cost or latency differ)')
    registry_path = Path(registry_path)
    registry = json.loads(registry_path.read_text()) if registry_path.exists() else {'version': 1, 'protocolId': protocol['protocolId'], 'rule': protocol['baseline']['rule'], 'baselines': []}
    model_id = record['fingerprint']['modelId']
    existing = next((b for b in registry['baselines'] if b['configuration']['modelId'] == model_id), None)
    judged = judged_trials(report['trials'])
    if existing:
        # Re-registering is for the same run whose record gained evidence (a live proof, a further trial of the
        # same job): same commit, same start, every trial registered before still there unchanged. Never a rerun.
        kept = {(t['case'], t['trial']): t for t in judged}
        same_run = (replace and existing['candidateCommit'] == commit and existing.get('runStartedAt') == report.get('startedAt')
                    and all(kept.get((t['case'], t['trial'])) == t for t in existing['trialRecords']))
        if not same_run:
            raise SystemExit(f'{model_id} already has a registered baseline ({existing["record"]}); later runs are judged against it'
                             + ('; --replace takes only the same run with every registered trial unchanged' if replace else ''))
        registry['baselines'].remove(existing)
    else:
        # The first met run of this model, by when the run started: an earlier one in the records directory is the baseline.
        started = lambda r, fallback: (r.get('lanes', {}).get('model', {}).get('runStartedAt') or fallback or '')
        for other in sorted(Path(records_dir or ROOT / 'evals' / 'qualification').glob('*.json')):
            if other.name == 'baseline.json' or other.resolve() == Path(record_path).resolve():
                continue
            earlier = json.loads(other.read_text())
            if (earlier.get('qualification') == 'met' and earlier.get('fingerprint', {}).get('modelId') == model_id
                    and started(earlier, earlier.get('generatedAt')) < report.get('startedAt', '')):
                raise SystemExit(f'{other.name} met every threshold earlier for {model_id}; it is the first run of this configuration')
    resolved = Path(record_path).resolve()
    record_rel = str(resolved.relative_to(ROOT)) if resolved.is_relative_to(ROOT) else str(resolved)
    entry = {
        'configuration': {'modelId': model_id},
        'registeredAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'record': record_rel,
        'recordSha256': hashlib.sha256(Path(record_path).read_bytes()).hexdigest(),
        'candidateCommit': commit,
        'fingerprint': {**record['fingerprint'], 'policyTemplate': relative_path(record['fingerprint'].get('policyTemplate'))},
        **rates,
        'flakyCases': flaky_cases(report['trials']),
        'errorsAndUnknown': sorted({t['case'] for t in report['trials'] if t.get('outcome') in ('error', 'unknown', 'timeout', 'cancelled')}),
        'runStartedAt': report.get('startedAt'),
        'modelReportSha256': hashlib.sha256(Path(report_path).read_bytes()).hexdigest(),
        'trialRecords': judged,
    }
    registry['baselines'].append(entry)
    registry_path.parent.mkdir(parents=True, exist_ok=True)
    registry_path.write_text(json.dumps(registry, indent=2) + '\n')
    return entry


def fingerprint_value(lanes, deterministic, key):
    """A configuration pin as the model lane ran it (the release reviewer), else as the deterministic lane did."""
    model = (lanes['model'].get('activationPins') or {}).get(key)
    if model:
        return model
    return deterministic['activations'][0]['pins'].get(key) if deterministic and deterministic.get('activations') else None


def activation_pins(activations):
    """Each reviewer/runner pin the run's activations used: the one value, or every distinct value when they differ."""
    pins = {}
    for key in ('REVIEWER_CONFIG_SHA256', 'ACCEPTANCE_RUNNER_IMAGE'):
        values = sorted({a.get('pins', {}).get(key) for a in activations if a.get('pins', {}).get(key)})
        pins[key] = values[0] if len(values) == 1 else (values or None)
    return pins


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
    rates = lane_rates(trials)
    violations = rates['hardBoundaryViolations']
    success, escalation, detection = rates['functionalSuccessRate'], rates['falseEscalationRate'], rates['criticalDetectionRate']
    thresholds = protocol['thresholds']
    executed_ok = violations == 0 and (success is None or success >= thresholds['functionalSuccessRateMin']) and (escalation or 0) <= thresholds['falseEscalationRateMax']
    # The driver binds a report to one clean commit, scorer and worker image from its start to its end (live.py
    # finish_report); an unbound report is not evidence of that commit.
    bound = report.get('bound') is True
    met = complete and same_commit and bound and success is not None and executed_ok
    # A job that stopped at its budget leaves cases NOT_RUN: what ran is judged, what did not run is
    # neither a pass nor a failure, and the lane cannot be PASS (protocol `counting.notRun`).
    status = 'PASS' if met else ('INCOMPLETE' if executed_ok and same_commit and bound and not complete else 'FAIL')
    lane = {
        'status': status,
        'sameCommit': same_commit,
        'bound': bound,
        # The live configuration the trials ran under: the activations' trust-root pins and the worker image.
        'activationPins': activation_pins(report.get('activations') or []),
        'workerImageId': report.get('workerImageId'),
        'casesMissingOrShort': [c for c in expected_cases if len(per_case.get(c, [])) < protocol['trialsPerCase']],
        'casesNotRun': [c for c in expected_cases if not per_case.get(c)],
        'repairCount': sum(int(t.get('repairCount') or 0) for t in trials),
        'latencySeconds': sum(float(t.get('latencySeconds') or 0) for t in trials),
        'humanInterventions': sum(int(t.get('humanInterventions') or 0) for t in trials),
        'liveProof': report.get('liveProof'),
        'authorization': {k: authorization[k] for k in ('authorizedBy', 'budgetUsd', 'repository', 'expiresAt', 'trustedJob')},
        'candidateCommit': report.get('candidateCommit'),
        'modelId': report.get('modelId'),
        'runStartedAt': report.get('startedAt'),
        'trials': len(trials),
        'trialsPerCaseComplete': complete,
        'functionalSuccessRate': success,
        'falseEscalationRate': escalation,
        'criticalDetectionRate': detection,
        'hardBoundaryViolations': violations,
        'estimatedCostUsd': sum(float(t.get('estimatedCostUsd') or 0) for t in trials),
        'flakyCases': flaky_cases(trials),
        'errorsAndUnknown': sorted({t['case'] for t in trials if t.get('outcome') in ('error', 'unknown', 'timeout', 'cancelled')}),
        # Every trial as judged, and the report's digest, so the record can be audited without the report.
        'reportSha256': hashlib.sha256(report_path.read_bytes()).hexdigest(),
        'trialRecords': judged_trials(trials),
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
    parser.add_argument('--baseline', type=Path, default=BASELINE_FILE, help='The baseline registry (default evals/qualification/baseline.json)')
    parser.add_argument('--register-baseline', type=Path, metavar='RECORD', help='Register RECORD as its configuration\'s baseline; needs --model, the report it summarises')
    parser.add_argument('--replace', action='store_true', help='With --register-baseline: re-register the same commit\'s record after it changed')
    args = parser.parse_args()
    protocol = json.loads((ROOT / 'evals/qualification-protocol.json').read_text())
    if args.register_baseline:
        if not args.model:
            parser.error('--register-baseline needs --model, the model-lane report the record summarises')
        entry = register_baseline(args.register_baseline, args.model, args.baseline, protocol, replace=args.replace)
        sys.stdout.write(json.dumps({k: entry[k] for k in ('configuration', 'record', 'candidateCommit', 'functionalSuccessRate', 'trials')}) + '\n')
        return
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
            'reportPath': relative_path(str(args.deterministic)),
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
    model_id = (policy.get('execution', {}).get('models') or ['unknown'])[0]
    lanes['model'], regression, baseline_field, regression_gates = judge_model_lane(
        lanes['model'], model_id, args.baseline, thresholds['regressionToleranceFunctionalPercentagePoints'])
    evaluation = {
        'deterministicContractsPassRate': {'required': thresholds['deterministicContractsPassRate'], 'observed': (lanes['deterministic'].get('passed', 0) / lanes['deterministic']['trials']) if lanes['deterministic'].get('trials') else None, 'met': lanes['deterministic']['status'] == 'PASS'},
        'hardBoundaryViolations': {'required': thresholds['hardBoundaryViolations'], 'observed': lanes['deterministic'].get('hardBoundaryViolations'), 'met': lanes['deterministic'].get('hardBoundaryViolations') == 0 if lanes['deterministic']['status'] != 'NOT_RUN' else None},
        'functionalSuccessRateMin': {'required': thresholds['functionalSuccessRateMin'], 'observed': lanes['model'].get('functionalSuccessRate'), 'met': (lanes['model'].get('functionalSuccessRate') or 0) >= thresholds['functionalSuccessRateMin'] if lanes['model']['status'] != 'NOT_RUN' else None, 'lane': 'model'},
        'falseEscalationRateMax': {'required': thresholds['falseEscalationRateMax'], 'observed': lanes['model'].get('falseEscalationRate'), 'met': (lanes['model'].get('falseEscalationRate') or 0) <= thresholds['falseEscalationRateMax'] if lanes['model']['status'] != 'NOT_RUN' else None, 'lane': 'model'},
        'regressionToleranceFunctionalPercentagePoints': regression,
    }
    open_gates = [name for name, lane in lanes.items() if lane['status'] != 'PASS'] + ([] if protocol_pinned else ['protocol_pin_mismatch']) + (['qualify_tree_dirty'] if dirty else []) + ([] if ci and ci.get('containers') else ['container_suites_not_run']) + ([] if fixtures_pinned else ['fixtures_pin_mismatch'])
    open_gates += regression_gates
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
            'workerImage': lanes['model'].get('workerImageId') or (deterministic or {}).get('workerImageId'),
            'evalProtocolPinnedByPolicy': protocol_pinned,
            'reviewerConfigSha256': fingerprint_value(lanes, deterministic, 'REVIEWER_CONFIG_SHA256'),
            'acceptanceRunnerImage': fingerprint_value(lanes, deterministic, 'ACCEPTANCE_RUNNER_IMAGE'),
            'corpusSha256': hashlib.sha256(corpus_bytes).hexdigest(),
            'scorerSha256': sha256_files(SCORER),
            'fixturesPinSha256': fixtures_pin_file.read_text().strip() if fixtures_pin_file.exists() else None,
            'protocolSha256': protocol_sha256,
            'policyTemplate': relative_path(str(args.policy)),
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
        'baseline': baseline_field,
        'qualification': 'open' if open_gates else 'met',
        'openGates': open_gates,
        'report': {
            'functionalSuccessRate': lanes['model'].get('functionalSuccessRate'),
            'criticalDetectionRate': lanes['model'].get('criticalDetectionRate'),
            'falseEscalationRate': lanes['model'].get('falseEscalationRate'),
            'hardBoundaryViolations': (lanes['deterministic'].get('hardBoundaryViolations') or 0) + (lanes['model'].get('hardBoundaryViolations') or 0),
            'repairCount': lanes['model'].get('repairCount'),
            'estimatedCostUsd': lanes['model'].get('estimatedCostUsd', 0 if deterministic else None),
            'latencySeconds': lanes['model'].get('latencySeconds') if lanes['model']['status'] != 'NOT_RUN' else (sum(t.get('durationSeconds', 0) for t in deterministic['trials']) if deterministic else None),
            # The deterministic lane has no human; its orchestrated trials issue scripted operator commands
            # (approve, cancel, revoke, recover, reconcile), counted separately. The model lane counts its own.
            'humanInterventions': lanes['model'].get('humanInterventions'),
            'scriptedOperatorActions': (deterministic or {}).get('summary', {}).get('operatorActions') if deterministic else None,
            # The deterministic lane's errored trials, and the model lane's errored, unknown and flaky cases.
            'errorsUnknownAndFlakyCases': ([t['case'] + '/' + t['trial'] for t in deterministic['trials'] if t.get('error')] if deterministic else [])
            + sorted(set(lanes['model'].get('errorsAndUnknown', [])) | set(lanes['model'].get('flakyCases', []))),
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
