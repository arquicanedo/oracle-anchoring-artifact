/**
 * Authoritative reader for `reports/mutation/*.json`.
 *
 * The Stryker schema-1.0 reports store no score field, so every percentage in the
 * invariant-testing write-up was previously computed by hand off a terminal. This
 * tool is the single implementation of those quantities.
 *
 * KILL RATE CONVENTION. The published table uses
 *     (Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage)
 * i.e. uncovered mutants are IN the denominator, which is Stryker's "total"
 * score. The alternative (uncovered excluded, Stryker's "covered" score) is
 * emitted alongside because the two conventions reorder the modules and the
 * difference is not cosmetic. Timeouts count as killed under both.
 *
 * DUPLICATE KEYS. Mutants are matched across reports on
 * (start line, start column, mutatorName, replacement). That tuple is not unique:
 * a few mutants share it, and where they do their statuses can disagree. Collapsing
 * with a naive Map (last write wins) silently drops whichever came last, which is
 * what corrupted the first published collision-avoidance diff. This tool reports
 * raw and distinct counts separately and resolves conflicts under an explicit rule,
 * evaluating both rules so the choice is visible rather than assumed.
 *
 * Usage:
 *   npx tsx analyze.ts            full table + all pair diffs
 *   npx tsx analyze.ts --validate check against published figures
 *   npx tsx analyze.ts --functions <report>   survivor breakdown
 *   npx tsx analyze.ts --diff <a> <b>        one pair
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import ts from 'typescript';

const REPORT_DIR = 'reports/mutation';
/** Gitignored by the `/reports/mutation/*` rule; never commit or publish it. */
const SALT_PATH = join(REPORT_DIR, '.public-salt');

type Status = 'Killed' | 'Timeout' | 'Survived' | 'NoCoverage' | 'CompileError' | 'RuntimeError' | 'Ignored';

interface Mutant {
  id: string;
  mutatorName: string;
  replacement?: string;
  status: Status;
  coveredBy?: string[];
  location: { start: { line: number; column: number } };
}

interface TestEntry {
  id: string;
  name: string;
}

interface MutationReport {
  files: Record<string, { source: string; mutants: Mutant[] }>;
  testFiles?: Record<string, { tests?: TestEntry[] }>;
  config?: { mutate?: string[] };
}

export interface LoadedReport {
  name: string;
  target: string;
  kind: 'property' | 'example' | 'mixed';
  testFiles: string[];
  testIdToFile: Map<string, string>;
  mutants: Mutant[];
  source: string;
  sourcePath: string;
  /** Fingerprint of the mutated source. Mutant identity is only meaningful within one
   *  version of it: a mutant is (line, column, mutator, replacement), and every one of
   *  those moves when the file changes. Two runs over the same path at different commits
   *  describe disjoint populations and must never be pooled. */
  sourceHash: string;
}

/** A mutant counts as detected if the tests killed it or drove it to a timeout. */
const isKilled = (s: Status): boolean => s === 'Killed' || s === 'Timeout';

/** Uncovered mutants are not "surviving the oracle"; they were never reached. */
const isCovered = (s: Status): boolean => s !== 'NoCoverage';

function classify(testFiles: string[]): 'property' | 'example' | 'mixed' {
  if (testFiles.length === 0) return 'mixed';
  const prop = testFiles.filter((f) => f.endsWith('.invariants.test.ts')).length;
  if (prop === testFiles.length) return 'property';
  if (prop === 0) return 'example';
  return 'mixed';
}

export function load(path: string): LoadedReport {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as MutationReport;
  const entries = Object.entries(raw.files);
  const mutants = entries.flatMap(([, f]) => f.mutants);
  const testFiles = Object.keys(raw.testFiles ?? {});
  const testIdToFile = new Map<string, string>();
  for (const [file, entry] of Object.entries(raw.testFiles ?? {})) {
    for (const t of entry.tests ?? []) testIdToFile.set(t.id, file);
  }
  return {
    name: basename(path, '.json'),
    target: raw.config?.mutate?.join(',') ?? entries.map(([p]) => p).join(','),
    kind: classify(testFiles),
    testFiles,
    testIdToFile,
    mutants,
    source: entries[0]?.[1].source ?? '',
    sourcePath: entries[0]?.[0] ?? '',
    sourceHash: createHash('sha256').update(entries.map(([, f]) => f.source).join('\n')).digest('hex').slice(0, 8),
  };
}

/**
 * Test files that empirically cover at least one mutant of the target, split into
 * property and example sets.
 *
 * Derived from Stryker's own per-test coverage, NOT from imports. An import-derived
 * partition cannot see an integration-style test: one example suite reaches the
 * debounce indirectly, through an intermediate module, and never imports the unit
 * under mutation at all. Dropping it is what produced the 21.05% figure that
 * `debounce-ex-v2` corrects to 89.47%. Coverage is empirical; imports are syntactic.
 */
export function coveragePartition(r: LoadedReport): {
  property: string[];
  otherProperty: string[];
  example: string[];
  uncovered: number;
} {
  const covering = new Set<string>();
  let uncovered = 0;
  for (const m of r.mutants) {
    if (m.coveredBy === undefined || m.coveredBy.length === 0) {
      uncovered++;
      continue;
    }
    for (const id of m.coveredBy) {
      const file = r.testIdToFile.get(id);
      if (file !== undefined) covering.add(file);
    }
  }
  const all = [...covering].sort();
  // `*.property.test.ts` is generator-driven too (the model-BASED contrast suite),
  // so it belongs in neither bucket: counting it as an example would credit the
  // hand-written style with property-test detection.
  return {
    property: all.filter((f) => f.endsWith('.invariants.test.ts')),
    otherProperty: all.filter((f) => f.endsWith('.property.test.ts')),
    example: all.filter((f) => !f.endsWith('.invariants.test.ts') && !f.endsWith('.property.test.ts')),
    uncovered,
  };
}

/**
 * Publishable mutant identity. Stryker's JSON embeds the full source of every
 * mutated file, so the raw reports cannot be released: the four reports covering
 * this study carry 1,068 lines of source verbatim, most of it outside the lines
 * under study. The published identity therefore has to preserve cross-run EQUALITY,
 * which is all any diff depends on, while carrying nothing about position or
 * replacement text.
 *
 * IT IS AN OPAQUE INDEX, NOT A HASH OF THE TUPLE, and the difference is the whole
 * point. Until 2026-08-14 this emitted a 48-bit unsalted SHA-256 of
 * `line:col mutator → replacement`, which was audited and broken: the preimage is
 * low-entropy (small integers, a mutator vocabulary the dataset prints in
 * cleartext beside the hash, and a fixed literal replacement for seven of the
 * fourteen mutators), so a brute force over lines 1-4000 and columns 1-320
 * recovered 226 of 479 identities exactly, including every ConditionalExpression
 * and every BlockStatement, in about a minute. Worse, the identities it did NOT
 * recover were confirmable: hashing a guessed expression and testing membership
 * turned the dataset into a verification oracle for private source text.
 *
 * The replacement scheme sorts by a SALTED digest and publishes the rank. There is
 * no preimage to attack, and the salt keeps the ordering from encoding line order
 * (an unsalted sort is monotone in line:col and gives the layout straight back).
 * The salt is generated once, stored gitignored, and only needs to survive if a
 * later regeneration should keep the same identifiers; losing it reshuffles the
 * labels and changes nothing else, because equality is the only relation that
 * carries meaning.
 */
function publicSalt(): Buffer {
  try {
    return Buffer.from(readFileSync(SALT_PATH, 'utf8').trim(), 'hex');
  } catch {
    const s = randomBytes(32);
    writeFileSync(SALT_PATH, `${s.toString('hex')}\n`);
    return s;
  }
}

/**
 * Per-report statuses are emitted as an ARRAY, not a scalar, because the identity
 * tuple is not unique and duplicates can disagree. Keeping them lets a consumer
 * apply either conflict rule and reproduce both published variants.
 */
export function publicDataset(reports: LoadedReport[]): unknown {
  const byTarget = new Map<string, LoadedReport[]>();
  for (const r of reports) {
    const g = byTarget.get(r.target) ?? [];
    g.push(r);
    byTarget.set(r.target, g);
  }
  // A target pools runs by mutate scope, and that is only sound while every run in it
  // measured the SAME source. A mutant is (line, column, mutator, replacement) and all
  // four move when the file changes, so two runs over one path at different commits
  // describe disjoint populations. Pooling them silently doubles the target and makes
  // label equality meaningless across the seam, which is undetectable downstream: the
  // emitted file looks well formed and every per-run score still computes.
  //
  // Discovered 2026-08-14 when the post-repair collision runs were added and target-6
  // went from 253 mutants to 512. Fail loudly rather than re-key, because the deposited
  // dataset is deliberately the study's original measurements and a follow-up run over
  // a repaired source belongs in its own deposit, not folded into this one.
  for (const [target, group] of byTarget) {
    const versions = new Set(group.map((r) => r.sourceHash));
    if (versions.size > 1) {
      throw new Error(
        `refusing to emit: target ${target} pools ${versions.size} source versions ` +
        `(${[...versions].join(', ')}) across runs ${group.map((r) => r.name).join(', ')}. ` +
        `Mutant identity is not comparable across them. Scope the report set to one version.`,
      );
    }
  }
  const salt = publicSalt();
  const rank = (k: string): string => createHash('sha256').update(salt).update(k).digest('hex');
  const targets = [...byTarget.entries()].map(([target, group], i) => {
    const mutants = new Map<string, { mutator: string; fn: string; status: Record<string, Status[]> }>();
    for (const r of group) {
      for (const m of r.mutants) {
        const k = key(m);
        const e = mutants.get(k) ?? {
          mutator: m.mutatorName,
          fn: enclosingFunction(r.source, m.location.start.line),
          status: {},
        };
        (e.status[r.name] ??= []).push(m.status);
        mutants.set(k, e);
      }
    }
    // Emission order is salted too. Insertion order is close to source order, so
    // publishing it would hand back the layout the opaque identifier removes.
    const ordered = [...mutants.entries()].sort(([a], [b]) => rank(a).localeCompare(rank(b)));
    return {
      target: `target-${i + 1}`,
      runs: group.map((r) => ({ run: r.name, suite: r.kind, testFileCount: r.testFiles.length })),
      mutants: ordered.map(([, v], j) => ({ key: `t${i + 1}-m${j + 1}`, ...v })),
    };
  });
  return {
    about:
      'Mutant-level dataset for the oracle-anchoring study. Identities are opaque per-target ' +
      'labels assigned in a salted order; they carry no information, and only equality across ' +
      'runs is meaningful. Source text, line and column positions, replacement text and the ' +
      'source ordering of the mutants are all absent, and none of them is derivable from this ' +
      'file. The mutator name and the enclosing function name ARE published: the paper names ' +
      'the functions in prose and the survivor clustering is unreadable without them.',
    conventions: {
      killRate: '(Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage)',
      coveredRate: 'uncovered mutants excluded from the denominator',
      timeouts: 'counted as killed',
      duplicateKeys:
        'statuses are arrays; a key with more than one entry had co-located duplicates. ' +
        'any-killed credits the identity if any entry was killed, all-killed requires all.',
      recomputing:
        'Kill RATES use raw mutants: sum the lengths of the status arrays for the denominator ' +
        'and count individual killed entries for the numerator. Counting one per key instead ' +
        'yields the distinct-identity rate, which is a different and lower number. DIFFS use ' +
        'distinct identities, so they are computed per key.',
    },
    targets,
  };
}

const key = (m: Mutant): string =>
  `${m.location.start.line}:${m.location.start.column} ${m.mutatorName} → ${JSON.stringify(m.replacement ?? '')}`;

export type ConflictRule = 'any-killed' | 'all-killed';

/**
 * Collapse raw mutants to distinct identities. Where duplicates disagree, the rule
 * decides: 'any-killed' credits the identity if any raw mutant was killed,
 * 'all-killed' requires every one of them.
 */
export function distinctKills(mutants: Mutant[], rule: ConflictRule): Map<string, boolean> {
  const groups = new Map<string, Status[]>();
  for (const m of mutants) {
    const k = key(m);
    const g = groups.get(k);
    if (g) g.push(m.status);
    else groups.set(k, [m.status]);
  }
  const out = new Map<string, boolean>();
  for (const [k, statuses] of groups) {
    out.set(k, rule === 'any-killed' ? statuses.some(isKilled) : statuses.every(isKilled));
  }
  return out;
}

export function duplicateStats(mutants: Mutant[]): { raw: number; distinct: number; duplicates: number; conflicts: number } {
  const groups = new Map<string, Status[]>();
  for (const m of mutants) {
    const k = key(m);
    const g = groups.get(k);
    if (g) g.push(m.status);
    else groups.set(k, [m.status]);
  }
  let duplicates = 0;
  let conflicts = 0;
  for (const statuses of groups.values()) {
    if (statuses.length > 1) {
      duplicates += statuses.length - 1;
      if (new Set(statuses.map(isKilled)).size > 1) conflicts++;
    }
  }
  return { raw: mutants.length, distinct: groups.size, duplicates, conflicts };
}

export interface Score {
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
  total: number;
  totalScore: number;
  coveredScore: number;
}

export function score(mutants: Mutant[]): Score {
  const killed = mutants.filter((m) => m.status === 'Killed').length;
  const timeout = mutants.filter((m) => m.status === 'Timeout').length;
  const survived = mutants.filter((m) => m.status === 'Survived').length;
  const noCoverage = mutants.filter((m) => m.status === 'NoCoverage').length;
  const total = killed + timeout + survived + noCoverage;
  const covered = mutants.filter((m) => isCovered(m.status)).length;
  return {
    killed,
    timeout,
    survived,
    noCoverage,
    total,
    totalScore: total === 0 ? 0 : ((killed + timeout) / total) * 100,
    coveredScore: covered === 0 ? 0 : ((killed + timeout) / covered) * 100,
  };
}

export interface Diff {
  onlyA: string[];
  onlyB: string[];
  both: string[];
  neither: string[];
  distinctTotal: number;
}

export function diff(a: LoadedReport, b: LoadedReport, rule: ConflictRule): Diff {
  const ka = distinctKills(a.mutants, rule);
  const kb = distinctKills(b.mutants, rule);
  const keys = [...new Set([...ka.keys(), ...kb.keys()])].sort(
    (x, y) => Number.parseInt(x, 10) - Number.parseInt(y, 10) || x.localeCompare(y),
  );
  const d: Diff = { onlyA: [], onlyB: [], both: [], neither: [], distinctTotal: keys.length };
  for (const k of keys) {
    const ia = ka.get(k) === true;
    const ib = kb.get(k) === true;
    if (ia && ib) d.both.push(k);
    else if (ia) d.onlyA.push(k);
    else if (ib) d.onlyB.push(k);
    else d.neither.push(k);
  }
  return d;
}

/**
 * Enclosing function for a 1-indexed source line.
 *
 * Resolved from the TypeScript AST, not by scanning upward for a line that looks
 * like a declaration. The scanning version shipped until 2026-08-14 and was wrong
 * on 35 of 573 mutant sites, because a bare call statement at the start of a line
 * matches a declaration pattern just as well as a declaration does, so mutants were
 * credited to the function their enclosing function calls rather than to the
 * enclosing function itself. Nothing downstream noticed: the attributed name was a
 * real function, the dataset stayed well formed, and every published figure still
 * recomputed, because the paper's survivor decompositions happen not to print any
 * of the affected names. That is this study's own subject one level up for the
 * third time, so the fix is a parser rather than a better regex.
 *
 * The innermost function-like node containing the line wins, which is what makes
 * nested arrows and class methods resolve correctly.
 */
export function enclosingFunction(source: string, line: number, path = 'source.ts'): string {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const spans: Array<{ name: string; from: number; to: number }> = [];

  const nameOf = (n: ts.Node): string | null => {
    if (ts.isConstructorDeclaration(n)) return 'constructor';
    const named = n as { name?: ts.Node };
    if (named.name && ts.isIdentifier(named.name)) return named.name.text;
    // Arrow functions and function expressions take the name they are bound to.
    const p = n.parent;
    if (
      p &&
      (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) &&
      p.name &&
      ts.isIdentifier(p.name)
    ) {
      return p.name.text;
    }
    return null;
  };

  const isFunctionLike = (n: ts.Node): boolean =>
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isGetAccessor(n) ||
    ts.isSetAccessor(n);

  const walk = (n: ts.Node): void => {
    if (isFunctionLike(n)) {
      const name = nameOf(n);
      if (name !== null) {
        spans.push({
          name,
          from: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          to: sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1,
        });
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);

  let best: { name: string; from: number; to: number } | null = null;
  for (const s of spans) {
    if (line < s.from || line > s.to) continue;
    if (best === null || s.to - s.from < best.to - best.from) best = s;
  }
  return best === null ? '(top level)' : best.name;
}

export function survivorsByFunction(r: LoadedReport): Map<string, { survived: number; noCoverage: number }> {
  const out = new Map<string, { survived: number; noCoverage: number }>();
  for (const m of r.mutants) {
    if (isKilled(m.status)) continue;
    const fn = enclosingFunction(r.source, m.location.start.line);
    const e = out.get(fn) ?? { survived: 0, noCoverage: 0 };
    if (m.status === 'NoCoverage') e.noCoverage++;
    else e.survived++;
    out.set(fn, e);
  }
  return out;
}

function loadAll(): LoadedReport[] {
  // Skip anything in the directory that is not a Stryker report, notably the
  // dataset this tool itself emits under --public.
  const isReport = (path: string): boolean => {
    try {
      return (JSON.parse(readFileSync(path, 'utf8')) as { files?: unknown }).files !== undefined;
    } catch {
      return false;
    }
  };
  return readdirSync(REPORT_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(REPORT_DIR, f))
    .filter(isReport)
    .map((path) => load(path));
}

const pct = (n: number): string => `${n.toFixed(2)}%`;

function printScoreTable(reports: LoadedReport[]): void {
  console.log('\n## Kill rate per report\n');
  console.log('| Report | Target | Suite | Raw | Distinct | Killed | Timeout | Survived | NoCov | Total score | Covered score |');
  console.log('|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of reports) {
    const s = score(r.mutants);
    const d = duplicateStats(r.mutants);
    console.log(
      `| ${r.name} | ${basename(r.target)} | ${r.kind} | ${d.raw} | ${d.distinct} | ${s.killed} | ${s.timeout} | ${s.survived} | ${s.noCoverage} | ${pct(s.totalScore)} | ${pct(s.coveredScore)} |`,
    );
  }
}

function printDuplicateTable(reports: LoadedReport[]): void {
  console.log('\n## Duplicate mutant keys (line:col + mutator + replacement)\n');
  console.log('| Report | Raw | Distinct | Duplicate rows | Status conflicts |');
  console.log('|---|---:|---:|---:|---:|');
  for (const r of reports) {
    const d = duplicateStats(r.mutants);
    if (d.duplicates === 0) continue;
    console.log(`| ${r.name} | ${d.raw} | ${d.distinct} | ${d.duplicates} | ${d.conflicts} |`);
  }
}

function printDiffs(reports: LoadedReport[]): void {
  const byTarget = new Map<string, LoadedReport[]>();
  for (const r of reports) {
    const g = byTarget.get(r.target) ?? [];
    g.push(r);
    byTarget.set(r.target, g);
  }
  for (const rule of ['any-killed', 'all-killed'] as ConflictRule[]) {
    console.log(`\n## Survivor diffs, conflict rule = ${rule}\n`);
    console.log('| Target | A (property) | B (example) | only A | only B | both | neither | distinct |');
    console.log('|---|---|---|---:|---:|---:|---:|---:|');
    for (const [target, group] of byTarget) {
      const props = group.filter((r) => r.kind === 'property');
      const exs = group.filter((r) => r.kind === 'example' || r.kind === 'mixed');
      for (const p of props) {
        for (const e of exs) {
          const d = diff(p, e, rule);
          console.log(
            `| ${basename(target)} | ${p.name} | ${e.name} | ${d.onlyA.length} | ${d.onlyB.length} | ${d.both.length} | ${d.neither.length} | ${d.distinctTotal} |`,
          );
        }
      }
    }
  }
}

function printRatios(reports: LoadedReport[]): void {
  const props = reports.filter((r) => r.kind === 'property');
  const byName = new Map(props.map((r) => [r.name, score(r.mutants).totalScore]));
  const debounce = byName.get('debounce-inv');
  const holding = byName.get('hold-inv-fixed');
  console.log('\n## Ratios\n');
  if (debounce !== undefined && holding !== undefined) {
    console.log(`Debounce / holding (the figure the abstract names): ${(debounce / holding).toFixed(4)}`);
  }
  const latest = props.filter((r) => r.name !== 'hold-inv').map((r) => score(r.mutants).totalScore);
  if (latest.length > 0) {
    const hi = Math.max(...latest);
    const lo = Math.min(...latest);
    console.log(`Spread across all property scores (highest / lowest): ${(hi / lo).toFixed(4)}  [${pct(hi)} / ${pct(lo)}]`);
  }
}

/**
 * Every figure printed in the paper, asserted against the
 * reports it was computed from. This is a GATE: it exits non-zero on any
 * mismatch, so a report set that no longer supports the draft fails loudly
 * instead of printing a table nobody reads.
 *
 * The expectations below are keyed to the COVERAGE-DERIVED partition (the -v2 /
 * p2- reports). An earlier version of this function still pointed at the
 * import-derived reports (`debounce-ex`, `math-examples`, `tcas-ex`) and at the
 * A1 ablation state as "repaired", which is why it passed while disagreeing with
 * the paper on five figures. Point new checks at the reports the draft cites,
 * not at whichever report happens to share the module name.
 */
function validate(reports: LoadedReport[]): void {
  const get = (n: string): LoadedReport | undefined => reports.find((r) => r.name === n);
  const rows: [string, string, string][] = [];
  const check = (label: string, actual: string, want: string): void => {
    rows.push([label, actual, want]);
  };
  const sc = (n: string): string => {
    const r = get(n);
    if (!r) return 'MISSING';
    const s = score(r.mutants);
    return `${s.killed + s.timeout}/${s.total} = ${pct(s.totalScore)}`;
  };

  // Table 1, as found.
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

  // Table 3, the three debounce oracle designs over one population.
  check('debounce state-anchored', sc('debounce-inv-stateanchored'), '14/19 = 73.68%');
  check('debounce reference model', sc('r5-debounce-model'), '18/19 = 94.74%');

  // Table 1's Stacked column: both styles run together. Composition is exact,
  // asserted below by diffing each union against the component it must equal.
  check('debounce stacked', sc('u1-debounce-union'), '18/19 = 94.74%');
  check('angle stacked', sc('u3-math-union'), '48/50 = 96.00%');
  check('holding stacked (re-anchored)', sc('u2-hold-union'), '36/46 = 78.26%');
  check('collision stacked', sc('u4-tcas-union'), '92/264 = 34.85%');

  // Table 4, the scope condition. S2's population contains S1's, so the two
  // cells are comparable only within themselves.
  check('MSAW S1 state-anchored', sc('a6-msaw-inv-s1-baseline'), '21/57 = 36.84%');
  check('MSAW S1 spec-anchored', sc('a6-msaw-inv-s1-specanchored'), '21/57 = 36.84%');
  check('MSAW S2 state-anchored', sc('a6-msaw-inv-s2-baseline'), '39/121 = 32.23%');
  check('MSAW S2 spec-anchored', sc('a6-msaw-inv-s2-specanchored'), '42/121 = 34.71%');

  // Section 17 of MEASUREMENT-RECORD: the post-repair collision runs. The source
  // is held fixed at the post-repair state across both, so the population is
  // identical (265) and the delta is the added oracles alone. The as-found figure
  // above (54/264) is a different source and is deliberately not comparable.
  check('post-repair collision, original oracle', sc('post-repair-tcas-inv-baseline'), '55/265 = 20.75%');
  check('post-repair collision, five oracles', sc('post-repair-tcas-inv'), '79/265 = 29.81%');

  // Section 19: round two, source held fixed at the post-inversion state. The
  // five-oracle figure is identical to the row above, which is the point: nothing in
  // properties 1-5 is sensitive to which aircraft gets which sense, so inverting the
  // altitude tiebreak moved them by exactly zero.
  check('round two, five oracles', sc('post-repair-tcas-inv-r2-baseline'), '79/265 = 29.81%');
  check('round two, seven oracles', sc('post-repair-tcas-inv-r2'), '97/265 = 36.60%');

  // The two `+0` cells of the prevalence table (paper Table 4): the leg-time
  // expected value and the angle measurement. Both were unasserted until
  // 2026-08-14, which made Section 4's claim that this gate asserts every printed
  // figure false for two published cells.
  check('prevalence, leg time re-anchored', sc('a3-hold-inv-reanchored'), '21/46 = 45.65%');
  check('prevalence, angle measurement re-anchored', sc('a3-math-inv-reanchored'), '40/50 = 80.00%');

  // Seed variance. The threats section retires the seed hedge on the strength of
  // ten repetitions over the two suites that pin no seed, so those ten runs carry a
  // published claim and belong in the gate.
  for (const i of [1, 2, 3, 4, 5]) {
    check(`seed repeat, debounce ${i}`, sc(`t4-debounce-${i}`), '18/19 = 94.74%');
    check(`seed repeat, collision ${i}`, sc(`t4-tcas-${i}`), '54/264 = 20.45%');
  }

  for (const rule of ['any-killed', 'all-killed'] as ConflictRule[]) {
    const pair = (a: string, b: string): string => {
      const ra = get(a);
      const rb = get(b);
      if (!ra || !rb) return 'MISSING';
      const d = diff(ra, rb, rule);
      return `${d.onlyA.length} / ${d.onlyB.length} / ${d.both.length} / ${d.neither.length} / ${d.distinctTotal}`;
    };
    // onlyA / onlyB / both / neither / distinct.
    check(`debounce diff [${rule}]`, pair('debounce-inv', 'debounce-ex-v2'), '1 / 0 / 17 / 1 / 19');
    check(`angle diff [${rule}]`, pair('p2-math-inv', 'p2-math-ex'), '0 / 8 / 40 / 2 / 50');
    check(`holding diff, as found [${rule}]`, pair('hold-inv', 'hold-ex'), '0 / 21 / 12 / 11 / 44');
    check(`holding diff, repaired [${rule}]`, pair('hold-inv-ab5', 'hold-ex'), '1 / 13 / 20 / 10 / 44');
    check(`model control diff [${rule}]`, pair('debounce-inv', 'r5-debounce-model'), '0 / 0 / 18 / 1 / 19');
    check(`negative control diff [${rule}]`, pair('debounce-inv', 'debounce-inv-stateanchored'), '4 / 0 / 14 / 1 / 19');
    // The `+0` cells again, as diffs rather than scores. Recovery is the claim, and a
    // score alone cannot express it: both must be empty in BOTH directions against the
    // run they ablate, which is what "+0" in Table 4 means.
    check(`prevalence leg time, recovery [${rule}]`, pair('a3-hold-inv-reanchored', 'hold-inv-ab5'), '0 / 0 / 21 / 23 / 44');
    check(`prevalence angle, recovery [${rule}]`, pair('a3-math-inv-reanchored', 'p2-math-inv'), '0 / 0 / 40 / 10 / 50');
    // "identical marginal sets, down to which mutants were marginal" is a claim about
    // mutant identity, not about counts, so it needs the diff and not the score.
    for (const i of [1, 2, 3, 4, 5]) {
      check(`seed repeat diff, debounce ${i} [${rule}]`, pair(`t4-debounce-${i}`, 'debounce-inv'), '0 / 0 / 18 / 1 / 19');
      // The both/neither split moves with the rule here, as it does for every other
      // collision diff, because that module carries identity collisions whose statuses
      // disagree. The marginal columns are 0 / 0 under both, and they are the claim.
      check(`seed repeat diff, collision ${i} [${rule}]`, pair(`t4-tcas-${i}`, 'tcas-inv'),
        rule === 'any-killed' ? '0 / 0 / 53 / 200 / 253' : '0 / 0 / 52 / 201 / 253');
    }
    // Composition: each union must kill everything its components kill (onlyB = 0)
    // and add nothing beyond them (its `neither` equals the component diff's).
    check(`compose debounce [${rule}]`, pair('u1-debounce-union', 'debounce-inv'), '0 / 0 / 18 / 1 / 19');
    check(`compose angle [${rule}]`, pair('u3-math-union', 'p2-math-ex'), '0 / 0 / 48 / 2 / 50');
    check(`compose holding [${rule}]`, pair('u2-hold-union', 'hold-inv-ab5'), '13 / 0 / 21 / 10 / 44');
    check(`compose collision [${rule}]`, pair('u4-tcas-union', 'p2-tcas-ex'),
      rule === 'any-killed' ? '2 / 0 / 86 / 165 / 253' : '2 / 0 / 83 / 168 / 253');
    // MSAW and collision carry identity collisions whose statuses disagree, so their
    // both/neither split moves with the conflict rule and is asserted per rule below.
    // The marginal columns, which are what the paper concludes from, do not move.
    check(`MSAW S1 diff [${rule}]`, pair('a6-msaw-inv-s1-baseline', 'a6-msaw-inv-s1-specanchored'),
      rule === 'any-killed' ? '0 / 0 / 21 / 30 / 51' : '0 / 0 / 20 / 31 / 51');
    check(`MSAW S2 diff [${rule}]`, pair('a6-msaw-inv-s2-baseline', 'a6-msaw-inv-s2-specanchored'),
      rule === 'any-killed' ? '0 / 3 / 38 / 72 / 113' : '0 / 3 / 36 / 74 / 113');
  }
  // The other figures where the two conflict rules disagree, stated rather than hidden.
  check('collision diff [any-killed]', ((): string => {
    const a = get('tcas-inv');
    const b = get('p2-tcas-ex');
    if (!a || !b) return 'MISSING';
    const d = diff(a, b, 'any-killed');
    return `${d.onlyA.length} / ${d.onlyB.length} / ${d.both.length} / ${d.neither.length} / ${d.distinctTotal}`;
  })(), '2 / 35 / 51 / 165 / 253');
  check('collision diff [all-killed]', ((): string => {
    const a = get('tcas-inv');
    const b = get('p2-tcas-ex');
    if (!a || !b) return 'MISSING';
    const d = diff(a, b, 'all-killed');
    return `${d.onlyA.length} / ${d.onlyB.length} / ${d.both.length} / ${d.neither.length} / ${d.distinctTotal}`;
  })(), '2 / 33 / 50 / 168 / 253');

  console.log('\n## Validation gate\n');
  console.log('| Quantity | Measured | Published | |');
  console.log('|---|---|---|---|');
  let failures = 0;
  for (const [label, actual, want] of rows) {
    const ok = actual === want;
    if (!ok) failures++;
    console.log(`| ${label} | ${actual} | ${want} | ${ok ? 'ok' : '**MISMATCH**'} |`);
  }
  console.log(`\n${rows.length - failures}/${rows.length} checks pass.`);
  if (failures > 0) {
    console.error(`\n${failures} published figure(s) no longer match the reports. The draft is stale, the reports are stale, or a check points at the wrong report.`);
    process.exitCode = 1;
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const reports = loadAll();

  if (argv[0] === '--functions') {
    const name = argv[1];
    const r = reports.find((x) => x.name === name);
    if (!r) {
      console.error(`no such report: ${name}`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n## Survivors by function: ${r.name} (${r.sourcePath})\n`);
    console.log('| Count | Function | Survived | NoCoverage |');
    console.log('|---:|---|---:|---:|');
    const rows = [...survivorsByFunction(r)].sort((a, b) => b[1].survived + b[1].noCoverage - (a[1].survived + a[1].noCoverage));
    for (const [fn, e] of rows) console.log(`| ${e.survived + e.noCoverage} | ${fn} | ${e.survived} | ${e.noCoverage} |`);
    return;
  }

  if (argv[0] === '--diff') {
    const a = reports.find((x) => x.name === argv[1]);
    const b = reports.find((x) => x.name === argv[2]);
    if (!a || !b) {
      console.error('usage: --diff <reportA> <reportB>');
      process.exitCode = 1;
      return;
    }
    for (const rule of ['any-killed', 'all-killed'] as ConflictRule[]) {
      const d = diff(a, b, rule);
      console.log(`\n## ${a.name} vs ${b.name}  [${rule}]\n`);
      console.log(`only ${a.name}: ${d.onlyA.length}   only ${b.name}: ${d.onlyB.length}   both: ${d.both.length}   neither: ${d.neither.length}   distinct: ${d.distinctTotal}`);
      for (const k of d.onlyA) console.log(`  onlyA  ${k}`);
      for (const k of d.onlyB) console.log(`  onlyB  ${k}`);
      for (const k of d.neither) console.log(`  none   ${k}`);
    }
    return;
  }

  if (argv[0] === '--sample') {
    const a = reports.find((x) => x.name === argv[1]);
    const b = reports.find((x) => x.name === argv[2]);
    const n = Number.parseInt(argv[3] ?? '30', 10);
    const seed = Number.parseInt(argv[4] ?? '4242', 10);
    if (!a || !b) {
      console.error('usage: --sample <reportA> <reportB> <n> <seed>');
      process.exitCode = 1;
      return;
    }
    // Deterministic sample of the mutants surviving BOTH suites. mulberry32 so the
    // draw is reproducible from the recorded seed alone.
    const d = diff(a, b, 'any-killed');
    const pool = [...d.neither].sort();
    let t0 = seed >>> 0;
    const rnd = (): number => {
      t0 = (t0 + 0x6d2b79f5) >>> 0;
      let t = Math.imul(t0 ^ (t0 >>> 15), 1 | t0);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const picked = pool.slice(0, n).sort((x, y) => Number.parseInt(x, 10) - Number.parseInt(y, 10));
    const src = a.source.split('\n');
    console.log(`# Equivalence sample: ${n} of ${d.neither.length} surviving both ${a.name} and ${b.name}`);
    console.log(`# seed=${seed} mulberry32, pool sorted by key before shuffle -> reproducible\n`);
    for (const k of picked) {
      const line = Number.parseInt(k, 10);
      const m = a.mutants.find((x) => key(x) === k);
      console.log(`## ${k}`);
      console.log(`fn: ${enclosingFunction(a.source, line)}`);
      console.log(`mutator: ${m?.mutatorName}  replacement: ${JSON.stringify(m?.replacement ?? '')}`);
      console.log(`source ${line}: ${(src[line - 1] ?? '').trim()}`);
      console.log('');
    }
    return;
  }

  if (argv[0] === '--public') {
    const out = argv[1] ?? 'reports/mutation/public-dataset.json';
    // The deposit is the study's original measurements. The prospective-test runs
    // mutate a repaired source, so their mutants are a disjoint population under the
    // (line, column, mutator, replacement) identity and the version guard in
    // publicDataset() rejects the pooled set. The artifact README states this
    // exclusion; until 2026-08-14 the tool did not implement it, so `--public` could
    // not regenerate the dataset it had already emitted. Listed by name rather than
    // inferred from source hashes, so adding a run cannot silently change the deposit.
    const PROSPECTIVE = new Set([
      'post-repair-tcas-inv-baseline',
      'post-repair-tcas-inv',
      'post-repair-tcas-inv-r2-baseline',
      'post-repair-tcas-inv-r2',
    ]);
    const scoped = reports.filter((r) => !PROSPECTIVE.has(r.name));
    const dropped = reports.length - scoped.length;
    if (dropped !== PROSPECTIVE.size) {
      throw new Error(
        `expected to drop ${PROSPECTIVE.size} prospective-test runs, dropped ${dropped}. ` +
        `Report names changed; reconcile the exclusion list against the artifact README.`,
      );
    }
    writeFileSync(out, `${JSON.stringify(publicDataset(scoped), null, 1)}\n`);
    console.log(`wrote ${out} (${scoped.length} runs; ${dropped} prospective-test runs excluded)`);
    return;
  }

  if (argv[0] === '--partition') {
    const r = reports.find((x) => x.name === argv[1]);
    if (!r) {
      console.error('usage: --partition <report>   (use a whole-unit-suite run)');
      process.exitCode = 1;
      return;
    }
    const p = coveragePartition(r);
    console.log(`\n## Coverage-derived partition: ${r.name} (target ${r.target})\n`);
    console.log(`uncovered mutants: ${p.uncovered}`);
    console.log(`\nproperty, *.invariants.test.ts (${p.property.length}):`);
    for (const f of p.property) console.log(`  ${f}`);
    if (p.otherProperty.length > 0) {
      console.log(`\nother generator-driven, excluded from both (${p.otherProperty.length}):`);
      for (const f of p.otherProperty) console.log(`  ${f}`);
    }
    console.log(`\nexample (${p.example.length}):`);
    for (const f of p.example) console.log(`  ${f}`);
    console.log(`\nSTRYKER_TESTS for the example run:\n${p.example.join(',')}`);
    return;
  }

  if (argv[0] === '--validate') {
    validate(reports);
    return;
  }

  printScoreTable(reports);
  printDuplicateTable(reports);
  printDiffs(reports);
  printRatios(reports);
}

// Only run the CLI when executed directly. Importing this module (the partition
// driver does) must not print the full table to stdout.
if (process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]))) {
  main();
}
