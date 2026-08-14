#!/usr/bin/env node
/**
 * Recompute every published figure of "Oracles That Cannot Fail" from
 * public-dataset.json alone, and check each one against the value printed in the
 * paper.
 *
 * No dependencies, no network, no other input file. Node 18 or newer:
 *
 *     node reproduce.mjs            tables, diffs, and the check list
 *     node reproduce.mjs --quiet    the check list only
 *
 * Exits non-zero if any recomputed figure disagrees with the paper. That is the
 * point of the script: it is a gate, not a report.
 *
 * CONVENTIONS, restated from the dataset's own `conventions` block because
 * getting either one wrong silently produces a different and plausible number.
 *
 *   Kill rate  = (Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage).
 *                Uncovered mutants are IN the denominator. Timeouts count as killed.
 *   Rates      use RAW mutants: a mutant's status for a run is an ARRAY, and every
 *                entry counts. Counting one entry per label instead yields the
 *                distinct-identity rate, which is a different and lower number.
 *   Diffs      use DISTINCT identities, one per label, so a label whose array holds
 *                disagreeing statuses is resolved by an explicit conflict rule:
 *                any-killed credits it if any entry was killed, all-killed requires
 *                every entry. Both are computed; the paper reports where they differ.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, 'public-dataset.json'), 'utf8'));
const quiet = process.argv.includes('--quiet');

const isKilled = (s) => s === 'Killed' || s === 'Timeout';

/** Every status entry recorded for `run`, flattened across labels. */
function rawStatuses(run) {
  const out = [];
  for (const t of data.targets) {
    if (!t.runs.some((r) => r.run === run)) continue;
    for (const m of t.mutants) {
      const arr = m.status[run];
      if (arr !== undefined) out.push(...arr);
    }
  }
  return out;
}

function score(run) {
  const st = rawStatuses(run);
  const killed = st.filter((s) => s === 'Killed').length;
  const timeout = st.filter((s) => s === 'Timeout').length;
  const survived = st.filter((s) => s === 'Survived').length;
  const noCoverage = st.filter((s) => s === 'NoCoverage').length;
  const total = killed + timeout + survived + noCoverage;
  return { killed, timeout, survived, noCoverage, total, pct: total === 0 ? 0 : ((killed + timeout) / total) * 100 };
}

/** label -> did this run kill it, under the given conflict rule. */
function distinctKills(run, rule) {
  const out = new Map();
  for (const t of data.targets) {
    if (!t.runs.some((r) => r.run === run)) continue;
    for (const m of t.mutants) {
      const arr = m.status[run];
      if (arr === undefined) continue;
      out.set(m.key, rule === 'any-killed' ? arr.some(isKilled) : arr.every(isKilled));
    }
  }
  return out;
}

function diff(a, b, rule) {
  const ka = distinctKills(a, rule);
  const kb = distinctKills(b, rule);
  const keys = [...new Set([...ka.keys(), ...kb.keys()])];
  const d = { onlyA: 0, onlyB: 0, both: 0, neither: 0, distinctTotal: keys.length };
  for (const k of keys) {
    const ia = ka.get(k) === true;
    const ib = kb.get(k) === true;
    if (ia && ib) d.both++;
    else if (ia) d.onlyA++;
    else if (ib) d.onlyB++;
    else d.neither++;
  }
  return d;
}

const pct = (n) => `${n.toFixed(2)}%`;
const sc = (run) => {
  const s = score(run);
  return s.total === 0 ? 'MISSING' : `${s.killed + s.timeout}/${s.total} = ${pct(s.pct)}`;
};
const pair = (a, b, rule) => {
  const d = diff(a, b, rule);
  return d.distinctTotal === 0 ? 'MISSING' : `${d.onlyA} / ${d.onlyB} / ${d.both} / ${d.neither} / ${d.distinctTotal}`;
};

const checks = [];
const check = (label, actual, want) => checks.push([label, actual, want]);

// Table 1, the suites as found.
check('debounce property', sc('debounce-inv'), '18/19 = 94.74%');
check('debounce example', sc('debounce-ex-v2'), '17/19 = 89.47%');
check('angle property', sc('p2-math-inv'), '40/50 = 80.00%');
check('angle example', sc('p2-math-ex'), '48/50 = 96.00%');
check('holding property (as found)', sc('hold-inv'), '12/46 = 26.09%');
check('holding example', sc('hold-ex'), '35/46 = 76.09%');
check('collision property', sc('tcas-inv'), '54/264 = 20.45%');
check('collision example', sc('p2-tcas-ex'), '90/264 = 34.09%');

// Table 2, the holding ablation. A0 is hold-inv above.
check('holding A1 (expected value)', sc('hold-inv-fixed'), '13/46 = 28.26%');
check('holding A2 (plus generator)', sc('hold-inv-ab2'), '13/46 = 28.26%');
check('holding A3a (yardstick re-anchored)', sc('hold-inv-ab3a'), '21/46 = 45.65%');
check('holding A3b (new speed oracle)', sc('hold-inv-ab3'), '21/46 = 45.65%');
check('holding A5 (every closure)', sc('hold-inv-ab5'), '21/46 = 45.65%');

// Table 4, the two `+0` prevalence cells. Recovery is the claim, so each needs the
// diff as well as the score: empty in BOTH directions against the run it ablates.
check('prevalence, leg time re-anchored', sc('a3-hold-inv-reanchored'), '21/46 = 45.65%');
check('prevalence, angle measurement re-anchored', sc('a3-math-inv-reanchored'), '40/50 = 80.00%');

// Seed variance. The threats section retires the seed hedge on the strength of ten
// repetitions over the two suites that pin no seed, so these carry a published claim.
check('seed repeat, debounce 1', sc('t4-debounce-1'), '18/19 = 94.74%');
check('seed repeat, collision 1', sc('t4-tcas-1'), '54/264 = 20.45%');
check('seed repeat, debounce 2', sc('t4-debounce-2'), '18/19 = 94.74%');
check('seed repeat, collision 2', sc('t4-tcas-2'), '54/264 = 20.45%');
check('seed repeat, debounce 3', sc('t4-debounce-3'), '18/19 = 94.74%');
check('seed repeat, collision 3', sc('t4-tcas-3'), '54/264 = 20.45%');
check('seed repeat, debounce 4', sc('t4-debounce-4'), '18/19 = 94.74%');
check('seed repeat, collision 4', sc('t4-tcas-4'), '54/264 = 20.45%');
check('seed repeat, debounce 5', sc('t4-debounce-5'), '18/19 = 94.74%');
check('seed repeat, collision 5', sc('t4-tcas-5'), '54/264 = 20.45%');

// Table 3, three oracle designs over one mutant population.
check('debounce state-anchored', sc('debounce-inv-stateanchored'), '14/19 = 73.68%');
check('debounce reference model', sc('r5-debounce-model'), '18/19 = 94.74%');

// Table 1's Stacked column: both styles run together.
check('debounce stacked', sc('u1-debounce-union'), '18/19 = 94.74%');
check('angle stacked', sc('u3-math-union'), '48/50 = 96.00%');
check('holding stacked (re-anchored)', sc('u2-hold-union'), '36/46 = 78.26%');
check('collision stacked', sc('u4-tcas-union'), '92/264 = 34.85%');

// Table 4, the scope condition. S2's population contains S1's.
check('MSAW S1 state-anchored', sc('a6-msaw-inv-s1-baseline'), '21/57 = 36.84%');
check('MSAW S1 spec-anchored', sc('a6-msaw-inv-s1-specanchored'), '21/57 = 36.84%');
check('MSAW S2 state-anchored', sc('a6-msaw-inv-s2-baseline'), '39/121 = 32.23%');
check('MSAW S2 spec-anchored', sc('a6-msaw-inv-s2-specanchored'), '42/121 = 34.71%');

for (const rule of ['any-killed', 'all-killed']) {
  // onlyA / onlyB / both / neither / distinct.
  check(`debounce diff [${rule}]`, pair('debounce-inv', 'debounce-ex-v2', rule), '1 / 0 / 17 / 1 / 19');
  check(`angle diff [${rule}]`, pair('p2-math-inv', 'p2-math-ex', rule), '0 / 8 / 40 / 2 / 50');
  check(`holding diff, as found [${rule}]`, pair('hold-inv', 'hold-ex', rule), '0 / 21 / 12 / 11 / 44');
  check(`holding diff, repaired [${rule}]`, pair('hold-inv-ab5', 'hold-ex', rule), '1 / 13 / 20 / 10 / 44');
  check(`model control diff [${rule}]`, pair('debounce-inv', 'r5-debounce-model', rule), '0 / 0 / 18 / 1 / 19');
  check(`negative control diff [${rule}]`, pair('debounce-inv', 'debounce-inv-stateanchored', rule), '4 / 0 / 14 / 1 / 19');
  // Composition: each union kills everything its components kill and adds nothing.
  check(`compose debounce [${rule}]`, pair('u1-debounce-union', 'debounce-inv', rule), '0 / 0 / 18 / 1 / 19');
  check(`compose angle [${rule}]`, pair('u3-math-union', 'p2-math-ex', rule), '0 / 0 / 48 / 2 / 50');
  check(`compose holding [${rule}]`, pair('u2-hold-union', 'hold-inv-ab5', rule), '13 / 0 / 21 / 10 / 44');
  check(`compose collision [${rule}]`, pair('u4-tcas-union', 'p2-tcas-ex', rule),
    rule === 'any-killed' ? '2 / 0 / 86 / 165 / 253' : '2 / 0 / 83 / 168 / 253');
  // MSAW and collision carry duplicate labels whose statuses disagree, so their
  // both/neither split moves with the rule. The marginal columns do not.
  check(`MSAW S1 diff [${rule}]`, pair('a6-msaw-inv-s1-baseline', 'a6-msaw-inv-s1-specanchored', rule),
    rule === 'any-killed' ? '0 / 0 / 21 / 30 / 51' : '0 / 0 / 20 / 31 / 51');
  check(`MSAW S2 diff [${rule}]`, pair('a6-msaw-inv-s2-baseline', 'a6-msaw-inv-s2-specanchored', rule),
    rule === 'any-killed' ? '0 / 3 / 38 / 72 / 113' : '0 / 3 / 36 / 74 / 113');
}
check('collision diff [any-killed]', pair('tcas-inv', 'p2-tcas-ex', 'any-killed'), '2 / 35 / 51 / 165 / 253');
check('collision diff [all-killed]', pair('tcas-inv', 'p2-tcas-ex', 'all-killed'), '2 / 33 / 50 / 168 / 253');

/**
 * Runs the deposit publishes but the check list above never asserts.
 *
 * The gate above proves that the paper's figures follow from the dataset. It says
 * nothing about the parts of the dataset no published figure reads, and that is most
 * of it: the checks cover 23 of 48 runs, so a majority of the status entries in this
 * file could be altered without a single check turning red. That is a region of the
 * artifact where a claim cannot fail, which is the thing this paper is about, so it
 * is enumerated here rather than left to be discovered.
 *
 * Every run must appear in exactly one of two places: the check list, or this table
 * with a reason. A run in neither fails the gate. That is what keeps the omission
 * from going quiet the next time the dataset is regenerated with a new run in it.
 *
 * The reasons below were confirmed against the paper on 2026-08-14. The runs that
 * do carry a published claim (the two prevalence cells and the ten seed repeats)
 * were moved into the check list above rather than declared here.
 */
const UNASSERTED = {
  'cov-debounce': 'whole-suite coverage run, used to derive the property/example partition, not scored',
  'cov-hold': 'whole-suite coverage run, used to derive the property/example partition, not scored',
  'cov-math': 'whole-suite coverage run, used to derive the property/example partition, not scored',
  'cov-tcas': 'whole-suite coverage run, used to derive the property/example partition, not scored',
  'debounce-ex': 'superseded import-derived partition, retained to document the correction to debounce-ex-v2',
  'math-examples': 'superseded import-derived partition, retained to document the correction to p2-math-ex',
  'math-invariants': 'superseded import-derived partition, retained to document the correction to p2-math-inv',
  'tcas-ex': 'superseded import-derived partition, retained to document the correction to p2-tcas-ex',
  'hold-inv-ab4': 'ablation A4, not tabulated in the paper',
  'p2-debounce-ex': 'coverage-derived variant; the published debounce example figure comes from debounce-ex-v2',
  'p2-hold-ex': 'coverage-derived variant; the published holding example figure comes from hold-ex',
  'p2-hold-inv': 'coverage-derived variant; the published holding property figure comes from hold-inv',
  'r6-tcas-boundary-reach': 'targeted boundary-reaching suite, discussed in prose rather than tabulated',
};

const allRuns = [...new Set(data.targets.flatMap((t) => t.runs.map((r) => r.run)))];
// A run counts as asserted if its name appears in the check list's source text above;
// the check list names runs as literals, so that is the honest test.
const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
const checkListEnd = source.indexOf('const UNASSERTED');
const checkListSrc = source.slice(source.indexOf('const checks = []'), checkListEnd);
const isAsserted = (run) => checkListSrc.includes(`'${run}'`);

const undeclared = allRuns.filter((r) => !isAsserted(r) && UNASSERTED[r] === undefined);
const overdeclared = allRuns.filter((r) => isAsserted(r) && UNASSERTED[r] !== undefined);

if (!quiet) {
  console.log('\n## Coverage of the deposit\n');
  const assertedRuns = allRuns.filter(isAsserted);
  const entries = (runs) => {
    let n = 0;
    for (const t of data.targets) for (const m of t.mutants) for (const r of runs) n += (m.status[r] ?? []).length;
    return n;
  };
  const ea = entries(assertedRuns);
  const eu = entries(allRuns.filter((r) => !isAsserted(r)));
  console.log(`${assertedRuns.length} of ${allRuns.length} runs feed a published figure ` +
    `(${ea} of ${ea + eu} status entries, ${((100 * ea) / (ea + eu)).toFixed(1)}%).`);
  console.log(`The remaining ${allRuns.length - assertedRuns.length} runs are published but unasserted:\n`);
  console.log('| Run | Why it is here and not in the check list |');
  console.log('|---|---|');
  for (const r of allRuns.filter((x) => !isAsserted(x)).sort()) console.log(`| ${r} | ${UNASSERTED[r] ?? '**UNDECLARED**'} |`);
}

if (!quiet) {
  console.log('\n## Kill rate per run, recomputed from the dataset\n');
  console.log('| Target | Run | Suite | Test files | Killed | Timeout | Survived | NoCov | Total | Kill rate |');
  console.log('|---|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const t of data.targets) {
    for (const r of t.runs) {
      const s = score(r.run);
      console.log(`| ${t.target} | ${r.run} | ${r.suite} | ${r.testFileCount} | ${s.killed} | ${s.timeout} | ${s.survived} | ${s.noCoverage} | ${s.total} | ${pct(s.pct)} |`);
    }
  }
  console.log('\n## Duplicate labels (statuses that disagree within one run)\n');
  console.log('| Target | Labels | Raw entries | Labels with >1 entry | Disagreeing |');
  console.log('|---|---:|---:|---:|---:|');
  for (const t of data.targets) {
    let raw = 0, dup = 0, conflict = 0;
    for (const m of t.mutants) {
      for (const arr of Object.values(m.status)) {
        raw += arr.length;
        if (arr.length > 1) {
          dup++;
          if (new Set(arr.map(isKilled)).size > 1) conflict++;
        }
      }
    }
    console.log(`| ${t.target} | ${t.mutants.length} | ${raw} | ${dup} | ${conflict} |`);
  }
}

console.log('\n## Published figures, recomputed\n');
console.log('| Quantity | Recomputed | In the paper | |');
console.log('|---|---|---|---|');
let failures = 0;
for (const [label, actual, want] of checks) {
  const ok = actual === want;
  if (!ok) failures++;
  console.log(`| ${label} | ${actual} | ${want} | ${ok ? 'ok' : '**MISMATCH**'} |`);
}
console.log(`\n${checks.length - failures}/${checks.length} published figures reproduce from public-dataset.json.`);
if (failures > 0) {
  console.error(`\n${failures} figure(s) do not match the paper.`);
  process.exitCode = 1;
}

// Every run must be accounted for, either asserted or declared unasserted with a
// reason. This is the "no silent omission" rule: it exists so that regenerating the
// dataset with a new run in it fails here instead of quietly widening the region of
// the deposit that no check can reach.
if (undeclared.length > 0) {
  console.error(
    `\n${undeclared.length} run(s) are published but neither asserted nor declared unasserted: ` +
      `${undeclared.sort().join(', ')}. Add a check for each, or an entry in UNASSERTED saying why not.`,
  );
  process.exitCode = 1;
}
if (overdeclared.length > 0) {
  console.error(
    `\n${overdeclared.length} run(s) are listed in UNASSERTED but do appear in the check list: ` +
      `${overdeclared.sort().join(', ')}. Remove the stale entry.`,
  );
  process.exitCode = 1;
}
