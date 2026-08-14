#!/usr/bin/env node
/**
 * Attack the deposit's own privacy claim from the published file alone.
 *
 * `reproduce.mjs` checks that the dataset still supports the paper. This checks the
 * other claim the deposit makes — that the dataset carries no source position, no
 * replacement text and no source ordering — and it exits non-zero when that claim
 * fails. Run it before every deposit and after every regeneration:
 *
 *     node privacy-check.mjs
 *     node privacy-check.mjs --quiet
 *
 * WHY THIS FILE EXISTS. The paper's subject is an oracle whose expected value is
 * derived from state the fault has already perturbed, so the expectation moves with
 * the fault and the assertion cannot fail. A privacy claim asserted only in prose is
 * that same object one level up: it has no oracle at all, so it cannot fail either.
 * An earlier build of this dataset was broken precisely because the claim had never
 * been attacked (see the README's disclosure). This is the attack, kept in the repo.
 *
 * IT IS DELIBERATELY NOT ANCHORED. Every expectation below is a constant fixed by the
 * schema, or a quantity that is INVARIANT under the fault it is meant to detect. The
 * ordering test is the case worth stating: the statistic is the number of runs of
 * equal `fn` down the emitted sequence, which collapses if the mutants are published
 * in source order; the yardstick is that statistic's expectation under a random
 * permutation, computed from the MULTIPLICITIES of `fn`, which a reordering does not
 * change. Deriving the yardstick from the emitted order instead would have produced
 * exactly the anchored oracle this artifact is about.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, 'public-dataset.json'), 'utf8'));
const quiet = process.argv.includes('--quiet');

// ---- The specification. Constants, not observations. -----------------------

const TOP_LEVEL = ['about', 'conventions', 'targets'];
const TARGET_FIELDS = ['target', 'runs', 'mutants'];
const RUN_FIELDS = ['run', 'suite', 'testFileCount'];
const MUTANT_FIELDS = ['key', 'mutator', 'fn', 'status'];
const STATUSES = ['Killed', 'Timeout', 'Survived', 'NoCoverage'];
const SUITES = ['property', 'example', 'mixed'];
const LABEL = /^t(\d+)-m(\d+)$/;
const IDENTIFIER = /^(?:[A-Za-z_$][\w$]*|\(top level\))$/;

/** Anything matching these in the targets subtree is a disclosure, not a datum. */
const FORBIDDEN = [
  [/\d+\s*:\s*\d+/, 'line:column position'],
  [/\b[0-9a-f]{12,}\b/i, 'hash-like token (the broken scheme emitted 48-bit hex)'],
  [/[/\\]/, 'path separator'],
  [/\.(ts|tsx|js|mjs|json|tex)\b/i, 'file name'],
  [/\b\d{3,}\b/, 'a 3+ digit integer, which a line number would be'],
];

/** Below this fraction of the random-permutation expectation, order is suspect. */
const ORDER_RATIO_FLOOR = 0.7;

// ---- Checks ----------------------------------------------------------------

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });
const sameSet = (got, want) => got.length === want.length && [...got].sort().join() === [...want].sort().join();

// 1. Shape. A field that should not exist is the failure mode that matters, so
//    these are equality checks against the allowlist, not "contains" checks.
check('top-level fields are exactly the schema', sameSet(Object.keys(data), TOP_LEVEL), Object.keys(data).join(', '));

const badTarget = [];
const badRun = [];
const badMutant = [];
for (const t of data.targets) {
  if (!sameSet(Object.keys(t), TARGET_FIELDS)) badTarget.push(`${t.target}: ${Object.keys(t).join(', ')}`);
  for (const r of t.runs) if (!sameSet(Object.keys(r), RUN_FIELDS)) badRun.push(`${r.run}: ${Object.keys(r).join(', ')}`);
  for (const m of t.mutants) if (!sameSet(Object.keys(m), MUTANT_FIELDS)) badMutant.push(`${m.key}: ${Object.keys(m).join(', ')}`);
}
check('every target carries only its three fields', badTarget.length === 0, badTarget.join(' | '));
check('every run carries only its three fields', badRun.length === 0, badRun.join(' | '));
check('every mutant carries only its four fields', badMutant.length === 0, badMutant.join(' | '));

// 2. Labels are opaque, dense, and namespaced per target: no gaps that would say
//    a mutant was withheld, and no shared label that would link two targets.
const seenLabels = new Set();
const labelProblems = [];
data.targets.forEach((t, i) => {
  const idx = i + 1;
  if (t.target !== `target-${idx}`) labelProblems.push(`${t.target} out of sequence`);
  const nums = [];
  for (const m of t.mutants) {
    const hit = LABEL.exec(m.key);
    if (!hit) {
      labelProblems.push(`${m.key} is not an opaque index`);
      continue;
    }
    if (Number(hit[1]) !== idx) labelProblems.push(`${m.key} in ${t.target}`);
    if (seenLabels.has(m.key)) labelProblems.push(`${m.key} appears twice`);
    seenLabels.add(m.key);
    nums.push(Number(hit[2]));
  }
  nums.sort((a, b) => a - b);
  const dense = nums.every((n, j) => n === j + 1);
  if (!dense) labelProblems.push(`${t.target} labels are not 1..${nums.length}`);
});
check('labels are opaque, dense and per-target', labelProblems.length === 0, labelProblems.slice(0, 5).join(' | '));

// 3. No positional data anywhere in the targets subtree. `fn` and `mutator` are
//    deliberately published and are checked separately as bare identifiers.
const leaks = [];
const scan = (value, where) => {
  if (typeof value === 'string') {
    for (const [re, what] of FORBIDDEN) if (re.test(value)) leaks.push(`${where}: ${what} -> ${JSON.stringify(value)}`);
  } else if (Array.isArray(value)) value.forEach((v, i) => scan(v, `${where}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { scan(k, `${where} key`); scan(v, `${where}.${k}`); }
};
for (const t of data.targets) {
  for (const m of t.mutants) scan({ key: m.key, status: m.status }, `${t.target}.${m.key}`);
  for (const r of t.runs) scan(r.suite, `${t.target}.${r.run}.suite`);
}
check('no positional or path-like value in the subtree', leaks.length === 0, leaks.slice(0, 5).join(' | '));

// 4. The published names really are bare identifiers. A stray expression, string
//    literal or path captured by the emitter's enclosing-function scan would show up
//    here rather than in the deposit.
const odd = [];
for (const t of data.targets) {
  for (const m of t.mutants) {
    if (!IDENTIFIER.test(m.fn)) odd.push(`fn ${JSON.stringify(m.fn)}`);
    if (!IDENTIFIER.test(m.mutator)) odd.push(`mutator ${JSON.stringify(m.mutator)}`);
  }
}
check('fn and mutator are bare identifiers', odd.length === 0, [...new Set(odd)].slice(0, 5).join(' | '));

// 5. Status vocabulary and run-declaration agreement. A run named in a status map but
//    absent from `runs` (or the reverse) means the file is describing measurements it
//    does not declare.
const badStatus = new Set();
const declared = new Set();
const referenced = new Set();
for (const t of data.targets) {
  for (const r of t.runs) {
    declared.add(`${t.target}/${r.run}`);
    if (!SUITES.includes(r.suite)) badStatus.add(`suite ${r.suite}`);
    if (!Number.isInteger(r.testFileCount) || r.testFileCount < 0) badStatus.add(`testFileCount ${r.testFileCount}`);
  }
  for (const m of t.mutants) {
    for (const [run, arr] of Object.entries(m.status)) {
      referenced.add(`${t.target}/${run}`);
      if (!Array.isArray(arr) || arr.length === 0) badStatus.add(`${m.key}.${run} is not a non-empty array`);
      else for (const s of arr) if (!STATUSES.includes(s)) badStatus.add(`status ${s}`);
    }
  }
}
const undeclared = [...referenced].filter((r) => !declared.has(r));
const unreferenced = [...declared].filter((r) => !referenced.has(r));
check('statuses and suites use the published vocabulary', badStatus.size === 0, [...badStatus].slice(0, 5).join(' | '));
check('every run is both declared and measured', undeclared.length === 0 && unreferenced.length === 0,
  [...undeclared.map((r) => `${r} undeclared`), ...unreferenced.map((r) => `${r} unmeasured`)].join(' | '));

// 6. The ordering test. Source order would cluster equal `fn` into one block each.
//    Expectation under a random permutation of the same multiset:
//        E[blocks] = n - sum(c_i * (c_i - 1)) / n
//    which depends only on the multiplicities, so it does NOT move when the order does.
//    (Counts live in a Map: one published function is named `constructor`, and a bare
//    object would resolve that to Object.prototype and silently poison the arithmetic.)
const order = [];
for (const t of data.targets) {
  const seq = t.mutants.map((m) => m.fn);
  const n = seq.length;
  const counts = new Map();
  for (const f of seq) counts.set(f, (counts.get(f) ?? 0) + 1);
  const k = counts.size;
  let blocks = 1;
  for (let i = 1; i < n; i++) if (seq[i] !== seq[i - 1]) blocks++;
  let sum = 0;
  for (const c of counts.values()) sum += c * (c - 1);
  const expected = n - sum / n;
  order.push({ target: t.target, n, k, blocks, expected, ratio: expected > 0 ? blocks / expected : NaN, testable: k >= 2 });
}
const testable = order.filter((o) => o.testable);
const skipped = order.filter((o) => !o.testable);
const clustered = testable.filter((o) => o.ratio < ORDER_RATIO_FLOOR);
check(`emission order is not source order (${testable.length} of ${order.length} targets testable)`,
  clustered.length === 0, clustered.map((o) => `${o.target} ratio ${o.ratio.toFixed(2)}`).join(' | '));

// ---- Report ----------------------------------------------------------------

if (!quiet) {
  console.log('\n## Emission order vs. source order\n');
  console.log('| Target | Mutants | Functions | Blocks observed | If source-ordered | If randomly ordered | Ratio |');
  console.log('|---|---:|---:|---:|---:|---:|---:|');
  for (const o of order) {
    const verdict = o.testable ? o.ratio.toFixed(2) : 'n/a';
    console.log(`| ${o.target} | ${o.n} | ${o.k} | ${o.blocks} | ${o.k} | ${o.expected.toFixed(1)} | ${verdict} |`);
  }
  if (skipped.length > 0) {
    console.log(`\nNot testable, stated rather than passed over: ${skipped.map((o) => o.target).join(', ')}. ` +
      'A target whose mutants all sit in one function has one block under every possible ordering, ' +
      'so this statistic says nothing about it either way.');
  }
}

console.log('\n## Disclosure gate\n');
console.log('| Check | |');
console.log('|---|---|');
let failures = 0;
for (const r of results) {
  if (!r.ok) failures++;
  console.log(`| ${r.name} | ${r.ok ? 'ok' : `**FAIL** — ${r.detail}`} |`);
}
console.log(`\n${results.length - failures}/${results.length} checks pass.`);

if (!quiet) {
  console.log(
    '\nWhat this gate does NOT establish: that the published function names are safe to ' +
    'disclose, which is a judgement rather than a property of the file; that the enclosing ' +
    'function attributed to each mutant is correct, which only the private source can settle; ' +
    'and that per-function mutant counts reveal nothing, since they are a coarse structural ' +
    'profile of each function and are inherent in publishing `fn` at all.',
  );
}

if (failures > 0) {
  console.error(`\n${failures} disclosure check(s) failed. Do not deposit this file.`);
  process.exitCode = 1;
}
