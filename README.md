# Oracles That Cannot Fail: replication artifact

Data and code accompanying *Oracles That Cannot Fail: Anchoring, and the Expectation That Moves
With the Fault*.

Arquimedes Canedo, Independent Researcher
ORCID [0000-0003-3506-6563](https://orcid.org/0000-0003-3506-6563)

The paper is a mutation analysis of twelve model-free property-test suites ("invariant suites") in
a deployed air traffic control simulator. It identifies and measures **oracle anchoring**: an oracle
whose expected value is derived from state the fault has already perturbed, so the expectation moves
with the fault and the assertion cannot fail.

This repository holds the mutant-level dataset every published figure was computed from, and a
self-contained program that recomputes those figures and checks them against the paper.

## Quick start

Node 18 or newer, no dependencies, no network:

```sh
node reproduce.mjs           # kill-rate tables, duplicate-label census, coverage, and the check list
node reproduce.mjs --quiet   # the check lists only
node privacy-check.mjs       # attack this deposit's own anonymisation claim
```

`reproduce.mjs` reports how many of the paper's 49 published figures reproduce. `privacy-check.mjs`
checks the other claim the deposit makes: that no source position, replacement text or source
ordering survives in the file. Both **exit non-zero** on any disagreement. They are gates, not
reports: flipping a single status in a run the paper cites makes nine checks fail.

## Contents

| File | What it is |
|---|---|
| `public-dataset.json` | The mutant-level dataset. Every figure in the paper derives from this file. |
| `reproduce.mjs` | Standalone reader. Recomputes each published figure from the dataset alone and asserts it, and accounts for every run the deposit carries. |
| `privacy-check.mjs` | The attack on this deposit's anonymisation, kept in the repo and run before every deposit. Asserts the published schema, that no positional or path-like value survives, and that the emission order is not source order. |
| `analyze.ts` | The program that produced the dataset, reading raw Stryker reports inside the private repository. Included so the emission path can be inspected. **It does not run here**, because its inputs are the raw reports, which cannot be published (see below). |

## Dataset schema

```
about        prose description
conventions  the counting rules, restated below
targets[]    one per mutated source unit, anonymised as target-1 .. target-6
  target       "target-N"
  runs[]       { run, suite: property|example|mixed, testFileCount }
  mutants[]
    key        opaque per-target label, e.g. "t3-m17"
    mutator    Stryker mutator name
    fn         enclosing function name
    status     { runName: [ "Killed" | "Timeout" | "Survived" | "NoCoverage", ... ] }
```

`status` maps a run to an **array**, not a scalar. Stryker's identity tuple is not unique, and
co-located duplicates can carry disagreeing statuses. Keeping the array lets a consumer apply either
conflict rule and reproduce both variants the paper reports.

## Counting conventions

Three rules, each of which silently produces a different and plausible number if you get it wrong.
`reproduce.mjs` implements all three.

**Kill rate** is `(Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage)`. Uncovered
mutants are in the denominator, which is Stryker's "total" score rather than its "covered" score.
Timeouts count as killed.

**Rates use raw mutants.** Sum the lengths of the status arrays for the denominator and count
individual killed entries for the numerator. Counting one entry per label gives the
distinct-identity rate, which is a different and lower number.

**Diffs use distinct identities**, one per label. Where a label's statuses disagree, `any-killed`
credits it if any entry was killed and `all-killed` requires every entry. The paper reports both
wherever they differ.

## What is absent, and why

The simulator is not public. The raw Stryker reports cannot be released either, because Stryker's
JSON embeds the full source of every mutated file: the reports behind this study carry 1,068 lines
of source verbatim, most of it outside the lines under study.

So each mutant carries an **opaque per-target label** assigned in a salted order. Line and column
positions, replacement text, source file paths, and the source ordering of the mutants are all
absent from this dataset and are not derivable from it. Only equality of labels across runs is
meaningful, and equality is the only relation the analysis uses.

Mutator names and enclosing function names **are** published. The paper names the functions in prose
and the survivor clustering is unreadable without them.

What that discloses, stated plainly rather than left to be noticed: the names themselves are part of
the simulator's internal API, and the number of mutants carried by each one is a coarse structural
profile of that function. A function holding a hundred mutants is large and branch-heavy; one holding
a single mutant is not. This follows from publishing `fn` at all and is not removable while the
survivor clustering remains readable. It is a disclosure that was chosen, not one that was missed.

### A disclosure about an earlier version of this dataset

An earlier build labelled each mutant with the first 48 bits of an unsalted SHA-256 of
`line:column mutator → replacement`. That is not an anonymisation, and it was audited before
release rather than after:

- The preimage is low-entropy. Lines and columns are small integers, the mutator vocabulary is fixed
  and was printed in cleartext beside the hash, and for seven of the fourteen mutators the
  replacement is a fixed literal.
- An exhaustive search over lines 1-4000 and columns 1-320 recovered **226 of 479 identities exactly**
  in about a minute, including every `ConditionalExpression` and every `BlockStatement`. Verified
  against the private reports: zero mismatches.
- The identities that resisted that search were still **confirmable**. Hashing a guessed expression
  and testing membership turned the dataset into a verification oracle for private source text.

The scheme was replaced before publication, and the emission order was salted too, since insertion
order approximates source order and would have handed back the layout the opaque label removes.

This is recorded rather than quietly fixed because it is the paper's own subject one level up: an
artifact whose privacy claim had never been attacked would have been a claim that could not fail.

## What falls outside this dataset

The deposit covers the measurements of the study as published. It deliberately
**excludes the follow-up runs** reported in the paper's prospective-test section, which
mutate a repaired source.

The reason is the same one that governs the labels. A mutant is a line, a column, a
mutator and a replacement, and all four move when the file changes, so a run over a
repaired source describes a **disjoint population**. Pooling it with the original under one
set of identities would make label equality meaningless across the seam, and nothing
downstream would notice: the file would still be well formed and every per-run score would
still compute. `analyze.ts` now refuses to emit a dataset that pools two source versions.

Those follow-up reports live in the project repository and their figures are recomputed by
the same program from the raw reports, not from this dataset.

## How much of the deposit the gate actually reaches

The dataset carries 48 runs. The check list asserts 35 of them. The other 13 — coverage runs used to
derive the property/example partition, superseded import-derived partitions, and two untabulated
ablations — are published but feed no published figure, so their contents could be altered without a
check turning red.

An earlier build asserted 23 and declared 25 unasserted, and the reasons for that split were inferred
from the run names rather than checked. Reading them against the paper on 2026-08-14 found twelve that
do carry a published claim: the two prevalence cells that read `+0` in the paper's Table 4, and the
ten repeated trials the threats section relies on to retire the seed hedge. Those twelve are now
asserted, as scores and, where recovery is the claim, as diffs.

What remains is a region of the artifact where a claim cannot fail, which is this paper's own subject,
so it is enumerated rather than left to be discovered. `reproduce.mjs` prints the 13 runs with a
reason for each, and **fails if a run is neither asserted nor declared**, so the next regeneration
cannot widen the unasserted region quietly.

## What this artifact cannot do

Every number in the paper can be recomputed from `public-dataset.json` and every diff re-derived.
**No measurement can be re-run**, because re-running one requires the simulator. Reproducibility here
means the published quantities follow from the recorded measurements, not that the measurements can
be regenerated by a third party.

## Citing

Cite the paper. If you use the dataset directly, cite the deposit as well.

```bibtex
@misc{canedo_oracle_anchoring_dataset,
  author       = {Canedo, Arquimedes},
  title        = {Oracles That Cannot Fail: replication artifact},
  year         = {2026},
  doi          = {10.5281/zenodo.21940547},
  note         = {Mutant-level dataset and reproduction program}
}
```

## License

Two-part, and `LICENSE` is authoritative:

- `public-dataset.json` is CC BY 4.0 (`LICENSE-DATA`).
- `reproduce.mjs`, `privacy-check.mjs` and `analyze.ts` are MIT (`LICENSE-CODE`).

The Zenodo metadata records CC BY 4.0 alone, because the deposit is primarily a dataset and Zenodo
carries a single licence field.
