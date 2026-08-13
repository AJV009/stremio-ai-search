# AI Search evaluation harness — design sketch

**Status:** design only. No queries written yet — the query set is a separate
brainstorm. Nothing here is implemented.

**Question it must answer:** for *our* library and *our* users, does
`structuredSearch` (retrieve-then-rank) beat upstream's improved
generation-first path — and on which kinds of query does each win?

The honest expected outcome is **not** "one wins". It is a per-category table
showing where each is stronger, which then tells us whether to keep the
structured path on for everything, restrict it to certain query shapes, or drop
it. The harness has to be capable of returning "upstream is better" or the whole
exercise is theatre.

---

## 1. Why the obvious harness gives a wrong answer

Four traps, each of which would silently produce a confident but meaningless
verdict. The design exists mostly to defuse these.

**1. Titles are not identities.** The original bug was `Identity` resolving to
*The Bourne Identity*. If ground truth is stored as title strings, the harness
inherits the exact ambiguity it is supposed to measure. **All ground truth is
keyed on TMDB id.** Titles appear only as human-readable comments.

**2. "Correct" is a set, not a list.** For `fahadh faasil dark comedy` there is
no single right answer. Scoring against one expected ordering would punish
legitimate variety. Ground truth needs a *must*, a *must-not*, and a wider
*acceptable* pool.

**3. Recency ground truth decays.** A fixed id list for "latest X" is wrong
within weeks — and a harness that silently rots is worse than none. Volatile
queries must be scored by **property predicates**, not id sets (see §3.2).

**4. LLMs are nondeterministic.** A single run per query measures sampling
noise as much as algorithm quality. Every query runs **N times** (N≥3) and we
report mean *and* spread. A win inside the noise band is not a win.

---

## 2. What we are actually measuring

| Metric | Definition | Why it matters |
|---|---|---|
| **Poison rate** | fraction of runs containing any `must_not` id | The Bourne Identity metric. Most user-visible failure. Weight highest. |
| **Hit rate** | fraction of `must` ids present | Did it find the obviously-correct answers? |
| **Precision@k** | results in `acceptable` ÷ results returned | Penalises padding with loosely-related filler. |
| **Constraint violation** | results breaking a stated constraint (wrong language / outside year window / wrong type) | Catches "technically a film, ignored what I asked". |
| **Existence rate** | results resolving to a real TMDB id | Structured should be 100% by construction; a miss here is a harness bug. |
| **Empty rate** | runs returning 0 results | Precision is worthless if it often returns nothing. |
| **Latency** | wall-clock p50/p95 | Ours makes ≥2 LLM calls; if it wins on quality but costs 3× the time that is a real tradeoff. |

**Composite score is computed but never reported alone.** Any single number
hides the category structure that is the actual output.

---

## 3. Ground truth schema

### 3.1 Set-based (stable queries)

```jsonc
{
  "id": "person-year-window-01",
  "query": "<written later>",
  "type": "movie",
  "category": "person+year",
  "assert": "set",
  "must":       [12345],              // tmdbIds that MUST appear
  "acceptable": [12345, 67890, 111],  // anything here counts as correct
  "must_not":   [222],                // presence = poison (e.g. famous lookalike)
  "constraints": { "original_language": "ml", "year_range": [2020, 2021] },
  "notes": "why these ids; who verified; date verified"
}
```

`must_not` is the highest-value field and the hardest to write. It should be
populated **from observed failures**, not imagination — e.g. after a run,
inspect wrong results and promote the egregious ones into `must_not` so the
harness locks in every regression we have actually seen.

### 3.2 Property-based (volatile queries)

For anything whose correct answer changes over time. No ids at all:

```jsonc
{
  "id": "recency-language-01",
  "assert": "property",
  "predicates": [
    { "field": "original_language", "op": "eq", "value": "ml" },
    { "field": "release_date", "op": "within_months", "value": 18 },
    { "field": "digital_release", "op": "exists" }
  ],
  "min_results": 5
}
```

Predicates are evaluated against **live TMDB** at run time, so the query never
goes stale. This is the only honest way to score "latest" queries.

### 3.3 Verification rule

Every id is verified against TMDB at authoring time and stamped with a date.
A `verify.js` pass re-checks that every id still resolves and that
`must`/`must_not` have not drifted; it runs before any scoring run and **fails
loudly** rather than scoring against rotten data.

---

## 4. Query taxonomy — slots, not queries

The user requirement is that every query be genuinely unique. The way to
guarantee that is to allocate **slots by failure mode first**, then write one
query per slot, rather than free-associating 50 queries and discovering later
that twelve of them are the same shape.

Proposed slot families (counts to be argued during the brainstorm):

- **Recency × language** — the original bug class
- **Person + year window** — precision requests; the Jailer/cameo trap
- **Person + genre, no year**
- **Plot description, no anchors** — the pure-semantic case; where keyword
  coverage is thinnest and where an embedding tier would eventually justify itself
- **Ambiguous short title** — Identity / Turbo / ARM class
- **Franchise / chronology** — "before X", ordering matters
- **Cross-language canon** — well-known non-English clusters
- **Decade + language + genre** — multi-constraint conjunction
- **Series vs movie disambiguation** — upstream found `/search/tv` ignores `year`
- **Trap / negative** — must NOT trigger recency ("new york movies") or a year
  filter ("movies from 1995"); upstream's `isRecencyQuery` explicitly handles
  these, so they are fair game and directly comparable
- **Regional long tail** — Malayalam/Tamil/Telugu titles with thin TMDB metadata,
  where `watch/providers` and digital dates are sparse
- **Should-return-nothing** — a query with no good answer. Padding is a failure
  mode; a system returning 20 confident results here should be penalised

Rule: **one query per slot**, and a slot is only reused if the second query
exercises a *different* failure inside it. Categories carry to the report, so
"ours wins on person+year, loses on plot description" is expressible.

---

## 5. Fairness controls

Non-negotiable, or the comparison is worthless:

- **Same model, same temperature** for both arms (`gemini-3.1-flash-lite`, temp
  pinned). Grounding **off** for both — it 429s on our key, so any result using
  it is not reproducible on this deployment.
- **Caches off.** `EnableAiCache=false`, and clear `tmdbCache` /
  `tmdbDetailsCache` between arms. A warm cache from arm A silently subsidises
  arm B. This burned us already at the stack level.
- **Identical `numResults`** — precision@k is meaningless otherwise.
- **Interleave arms per query** (A,B,A,B), never all-A-then-all-B, so TMDB
  latency drift or quota degradation hits both equally.
- **Same TMDB key**, same machine, same network.
- Record the **exact commit sha of both arms** in the result file.

---

## 6. Harness architecture

Call the two code paths **as functions**, not over HTTP. Going through
AIOStreams would drag in its in-memory catalog cache and the addon's own
caching — both of which we have already been bitten by, and neither of which is
part of what we are measuring.

```
eval/
  DESIGN.md          <- this file
  queries.json       <- ground truth (written later)
  verify.js          <- re-validate every id against TMDB; fail loudly
  run.js             <- execute arms, write raw runs, resumable
  score.js           <- pure scoring over raw runs; no network
  runs/<ts>-<sha>/   <- raw JSON per query per arm per repeat
  report.md          <- generated scorecard
```

**Separating `run` from `score` is the important part.** LLM calls are slow and
rate-limited; scoring must be re-runnable offline when we change a metric or add
a `must_not`. Never re-run the model to re-score.

**Resumability is mandatory.** 50 queries × 2 arms × 3 repeats ≈ 300 model
calls, and ours makes 2 per query (extract + rerank), so realistically ~450.
On a free Gemini key that *will* hit 429 partway. `run.js` checkpoints after
every single call and resumes exactly where it stopped. A run that dies at 80%
and cannot resume is a run we will never finish.

Rate limiting: fixed inter-call delay plus exponential backoff on 429, with the
throttle recorded in the run metadata so latency numbers stay interpretable.

---

## 7. Reporting

Primary output is a **per-category table**, both arms side by side, with the
noise band shown so marginal differences are visibly marginal:

```
category            arm          poison  hit   prec@k  viol  empty  p50
person+year         structured    0.00   0.92   0.81   0.03   0.00  4.1s
person+year         upstream      0.11   0.78   0.74   0.14   0.00  2.3s
```

Plus:
- **Disagreement list** — queries where the arms differ most. This is the most
  informative artifact for humans and where the next round of `must_not` entries
  comes from.
- **Every failure links to its raw run JSON**, so any claim in the report can be
  checked against what the model actually returned.

---

## 8. Decision rule, agreed BEFORE running

Write this down first, so the result cannot be rationalised afterwards:

- Ours stays **on for everything** if it wins or ties on poison rate in every
  category and loses no category badly on hit rate.
- Ours becomes **conditional** (route by query shape) if it wins clearly on some
  categories and loses clearly on others — the router would key off the same
  intent extraction we already do.
- Ours is **dropped** if upstream matches it within the noise band. Upstream's
  path is less code, needs no flag, and is maintained by someone else. That is a
  legitimate outcome and the harness must be allowed to produce it.
- Latency is a **tiebreaker only**, unless ours exceeds ~2× upstream's p95, at
  which point it needs to win on quality decisively to justify itself.

---

## 9. Open questions for the brainstorm

1. **How many repeats?** 3 is the minimum for a noise estimate; 5 is better and
   costs 1.7× the quota. Depends on how much variance we actually see.
2. **Who arbitrates "acceptable"?** For fuzzy queries this is a judgement call.
   Options: you decide by hand (slow, trustworthy), or an LLM judge over TMDB
   overviews (fast, and introduces exactly the kind of model bias we are trying
   to measure). Leaning hand-authored for the first 50.
3. **Do we score ordering?** MRR/NDCG would reward putting the right answer
   first, which matters in Stremio's UI where users see ~6 tiles. Adds authoring
   cost. Probably worth it for `must` ids only.
4. **Series coverage.** Ours currently returns `null` for most series-shaped
   queries. Do we evaluate series at all in round 1, or scope to movies and be
   explicit about it?
5. **Should the harness also test the digital-release filter?** Same ground-truth
   machinery could score it. Tempting, but conflating two systems in one eval is
   how you get an unfalsifiable result. Recommend keeping it separate.
6. **Upstream contribution.** If the harness is clean and the query set is not
   household-specific, this is far more upstreamable than PR #243 was — a
   maintainer gets much more value from a regression suite than from a feature
   they did not want.
