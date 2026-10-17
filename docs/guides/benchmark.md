# Run the benchmark with your own LLM provider

The benchmark replays historical AdguardFilters issues that maintainers have
already fixed. For each case the agent investigates the issue as it was
reported, before the fix existed. A browser then checks the agent's rule
against the rule the maintainer committed. An endpoint speaking the OpenAI
chat-completions or Anthropic Messages API works: you supply the endpoint,
the key, the models, and optionally the prices.

- [Before you start](#before-you-start)
- [Configure the provider](#configure-the-provider)
- [Configure the judge](#configure-the-judge)
- [Run one case or the whole set](#run-one-case-or-the-whole-set)
- [Read the results](#read-the-results)
- [Compare models](#compare-models)
- [Count the cost](#count-the-cost)
- [Add a case](#add-a-case)
- [Check cases](#check-cases)

## Before you start

You need:

- **Node.js 24 or newer** and **pnpm 10**.
- **git** and network access to `github.com`. Each case clones
  AdguardFilters at the commit before the fix and assembles the reporter's
  extension build from release code and the pinned autobuild filter lists.
- **An LLM endpoint** speaking the OpenAI chat-completions or Anthropic
  Messages API, with a reasoning model that supports tool calling and a
  vision model that accepts images. One model can fill both roles.
- **A GitHub token** with public read access, to add cases or resolve
  a version with `benchmark:case:check --extension-version`. Running
  cases and checking existing v3 pins work without one; set `GITHUB_TOKEN`
  anyway if GitHub rate-limits your anonymous clones.

You do not need a browser install: the stealth Chromium build is downloaded
on the first run. You do not need the AdGuard CLI either: every case is a
Chrome MV3 browser extension report, and a case runs only the browser
extension. Historical cases refuse `--blocker-module`: module filter lists
cannot yet be pinned to the reporter's date.

Install the dependencies from the repository root:

```bash
pnpm install
```

## Configure the provider

Put the provider settings in `.env` at the repository root. The benchmark
commands read it; variables already exported in your shell take precedence.

`anthropic-messages` uses adaptive thinking and targets Claude models that
support it (Claude 5.x).

```dotenv
# LLM_API=openai-completions
LLM_BASE_URL=https://llm.example.com/v1
LLM_API_KEY=your-key
LLM_MODEL=example-reasoning-model
# Optional: defaults to LLM_MODEL.
# LLM_VISION_MODEL=example-vision-model
LLM_CONTEXT_WINDOW_TOKENS=131072
LLM_MAX_OUTPUT_TOKENS=32768
# Required only for a different vision model.
# LLM_VISION_MAX_OUTPUT_TOKENS=8192
```

| Variable | Value |
| --- | --- |
| `LLM_API` | `openai-completions` (default) or `anthropic-messages`, for both model roles |
| `LLM_BASE_URL` | OpenAI chat-completions API base URL, usually ending in `/v1`; for Anthropic Messages use `https://api.anthropic.com` without `/v1` |
| `LLM_API_KEY` | API key of that endpoint |
| `LLM_MODEL` | Reasoning model id, as the provider spells it |
| `LLM_VISION_MODEL` | Optional vision model id; defaults to `LLM_MODEL` |
| `LLM_CONTEXT_WINDOW_TOKENS` | Context window of the models |
| `LLM_MAX_OUTPUT_TOKENS` | Completion limit of the reasoning model |
| `LLM_VISION_MAX_OUTPUT_TOKENS` | Completion limit of the vision model; defaults to `LLM_MAX_OUTPUT_TOKENS` when vision uses the reasoning model |

The base URL, key, reasoning model and token limits have no defaults. Take
the limits from your provider's model page: a value above the model's own
limit fails every request with HTTP 400. Set
`LLM_MAX_OUTPUT_TOKENS` to the model's full limit, because the model's
reasoning and its final answer share it. `LLM_VISION_MAX_OUTPUT_TOKENS` may be
left out when `LLM_VISION_MODEL` is unset or both model variables name the
same model. For Anthropic, set `LLM_API=anthropic-messages` and
`LLM_BASE_URL=https://api.anthropic.com` without `/v1`.

A missing or empty required variable stops the command before the first
case and names the variable:

```text
Invalid configuration:
  - llm.model: LLM_MODEL is required
```

Optional tuning variables (reasoning effort, request timeout, retries) are
listed in the [CLI reference](../reference/cli.md#environment-variables).

## Configure the judge

Configure an independent judge in `.env` before running cases. Keep its
settings fixed across the model series you compare. There is no fallback to
the agent's provider settings: missing judge settings stop the command before
the first case.

```dotenv
# E2E_JUDGE_API=openai-completions
E2E_JUDGE_BASE_URL=https://llm.example.com/v1
E2E_JUDGE_API_KEY=your-judge-key
E2E_JUDGE_MODEL=example-judge-model
E2E_JUDGE_CONTEXT_WINDOW_TOKENS=131072
E2E_JUDGE_MAX_OUTPUT_TOKENS=32768
# Optional: defaults to E2E_JUDGE_MODEL.
# E2E_JUDGE_VISION_MODEL=example-judge-vision-model
# Required only for a different vision model.
# E2E_JUDGE_VISION_MAX_OUTPUT_TOKENS=8192
```

Use the same API, URL and token-limit conventions as the provider above.
The judge also accepts `E2E_JUDGE_REASONING_EFFORT`,
`E2E_JUDGE_SINGLE_SHOT_REASONING_EFFORT`, `E2E_JUDGE_REQUEST_TIMEOUT_MS` and
`E2E_JUDGE_REQUEST_MAX_ATTEMPTS`, with the defaults and limits of their
`LLM_*` counterparts. `E2E_JUDGE_VISION_MAX_OUTPUT_TOKENS` is required only
when `E2E_JUDGE_VISION_MODEL` names a different model. The judge's key is
never printed or saved in run artifacts.

Reuse the shared cache at `tmp/e2e-judge-cache/<case>.json` across output
roots. Reporter-environment extraction is keyed by case, human-fix commit,
extension build (`version`, `releaseTag`, `autobuildCommit`), judge API and
text model, both judge reasoning efforts, and the digest of `issue.json`;
it does not expire. Human-fix verdicts are keyed by case, human-fix commit,
extension build, judge API,
text model, effective vision model, both judge reasoning efforts, and the
digest of `issue.json`; they expire seven days after `checkedAt`.
Infrastructure failures are never cached.

## Run one case or the whole set

The cases live in `lab/benchmark/e2e/cases/`, one directory per case. Run one
by its directory name:

```bash
pnpm test:e2e -- --case nettg-pl-235988
```

Run every case, one after another:

```bash
pnpm test:e2e -- --all
```

Each case is a complete agent investigation with a real browser, so expect
minutes per case. Without `--output-root`, each run replaces that case's
previous output. To retain a model series, choose a separate output root:

```bash
pnpm test:e2e -- --all --output-root tmp/model-series-a
```

With this flag, an existing `runs/<case>` or `evaluations/<case>` directory
under that root refuses the entire selection before the first case starts.

Before comparing models, check whether the historical human fixes still
work on today's sites:

```bash
pnpm test:e2e -- --all --oracle-only
```

This runs only the judge and requires only `E2E_JUDGE_*` provider settings.
It prints `<case>: alive (<rule>)`, `<case>: environment_drift (<detail>)`, or
`<case>: infrastructure_failure (<detail>)`. The exit code is 0 if all
cases are alive, 2 if any has drifted, or 3 if any check failed. It writes
browser evidence under `tmp/e2e-oracle-runs/` and shares the judge cache.
It takes neither `--output-root` nor `--knowledge-base-sha`.

Alive and drift lines end with ` (cached)` when the verdict is reused.
Drift details retain every candidate's rejection rationale, joined with
` | `. Cached checks leave the case's evidence directory untouched; a live
check clears it immediately before the first probe. The directory therefore
holds the last live oracle-only check, which may predate a cached verdict
written by a model run.

Add `--refresh` to ignore both judge-cache entries for the selected cases
and replace only entries the judge recalculates. An ordinary agent run may
finish classification without probing the human fix, so it need not refresh
the verdict. To rebuild both entries before model runs, use:

```bash
pnpm test:e2e -- --all --oracle-only --refresh
```

To give every agent series the same KnowledgeBase revision, pass
`--knowledge-base-sha <full-40-character-commit-sha>`. Without it, the suite
resolves KnowledgeBase `master` once before the first case. The selected
SHA is printed and recorded for every agent run. An incomplete or malformed
SHA is refused. Judge-only runs do not resolve or use KnowledgeBase.

The benchmark presents each historical report to the agent as open, without
an assignee or `A:` labels; `T:`, `P:` and `N:` labels remain. The saved
snapshot stays unchanged and the judge reads it as saved. If the historical
checkout contains a loaded repository instruction at
`.github/filters-agent/AGENTS.md`, the benchmark stops before investigation
with `infrastructure_failure`, `failureKind: transient`, and the file path
in the detail.

## Read the results

The command prints one entry per case, then exits with the most severe code
among them:

```text
nettg-pl-235988: pass (Agent result matches a browser-confirmed human change: ...)
    cost: $0.0412
```

| Status | Exit code | Meaning |
| --- | --- | --- |
| `pass` | 0 | The agent's rule matches the human fix, confirmed in the browser |
| `agent_regression` | 1 | The agent's result differs from the confirmed human fix |
| `environment_drift` | 2 | The human fix no longer works on today's site; the case is stale |
| `infrastructure_failure` | 3 | The run or the check could not finish; the detail says why |

A failing provider is reported as `infrastructure_failure`, not as an agent
regression. Exit code 3 is also used when the command itself fails, for
example on a missing variable.

Extension builds in the 5.4.3 line do not record domainless scriptlets in
the filtering log. Expect the same limitation in `get_applied_rules` as
in the reporter's extension.

Without `--output-root`, agent files are in `tmp/e2e-runs/<case>/` and
evaluation files in `tmp/e2e-evaluations/<case>/`. With
`--output-root <root>`, they are in `<root>/runs/<case>/` and
`<root>/evaluations/<case>/` respectively:

| Path | Contents |
| --- | --- |
| Agent `agent-report.md` | The agent's report |
| Agent `run-result.json` | The agent's result: status, proposed rule, evidence |
| Agent `candidate.patch` | The proposed filter change, when there is one |
| Agent `llm-usage-summary.json` | Tokens and cost, per model and in total |
| Agent `agent-run-manifest.json` | Digests that lock the files above |
| Evaluation `e2e-result.json` | The comparison: status, detail, agent rule, human rule |
| Evaluation `benchmark-record.json` | Model and judge identity, environment pins, timings, agent usage and cost, outcome and human issue-to-fix time |

Read `benchmark-record.json` for every completed case classification,
including failures. Its `schemaVersion` is 1. `outcome.level` is the highest
milestone achieved; an infrastructure failure is always L0:

| Level | Milestone |
| --- | --- |
| L0 | Infrastructure failure, unavailable result, or no later milestone |
| L1 | The agent reproduced the symptom |
| L2 | The agent proposed a candidate patch |
| L3 | The agent verified its candidate |
| L4 | Domain, rule syntax and target file match a confirmed human rule |
| L5 | The comparison passed |

`outcome.failureKind` is `provider_rejected` for an agent provider rejection,
including intake, `intake_skipped` when the agent's intake declines the
issue as not a filter report, `transient` for other infrastructure failures
(including judge failures and repository-instruction refusals),
and `null` for other outcomes. `outcome.humanFixVerdict` is `verified`,
`not_verified`, `infrastructure_failure`, or `not_checked` when no human-fix
verdict was needed or available. `outcome.verdictFromCache` says whether
that verdict came from the shared cache. Usage and cost cover the agent;
judge costs are not included.
The record's judge identity includes both model roles and both reasoning
efforts.

The agent's run is locked before the human fix is read, so the agent never
sees the answer. To check that a run directory still matches its lock, for
example before sharing it:

```bash
AGENT_RUN_DIRECTORY=tmp/e2e-runs/nettg-pl-235988 pnpm benchmark:verify-run
```

It prints the run id and exits 0 when every file matches its digest. It
exits 1 and names the problem otherwise.

## Compare models

Summarize saved series without calling a provider or opening a browser:

```bash
pnpm benchmark:summarize -- tmp/model-series-a tmp/model-series-b
```

Supply one or more roots containing `benchmark-record.json` files. A root
without records fails and names its path. The output has model totals,
per-case results and agent-versus-human median times. Agent time is
preparation plus investigation; human time is issue creation to fix commit.
Model groups include API, loop and vision models, and both reasoning-effort
settings. Repeated records for the same configuration and case count as
repeated runs.

If judge settings, the agent commit or dirty state, KnowledgeBase commit,
or browser build differ anywhere in the input records, a `mixed pins:` line
names each differing condition and its number of distinct values. The
summary still includes the records; use consistent pins when comparing
model quality.

If any record has `humanFixVerdict: not_verified`, its case is excluded for
every model and listed as drift. The pass-rate denominator contains runs
on the remaining cases, excluding `environment_drift` and `transient`
failures. `provider_rejected` and `intake_skipped` count as failed L0 runs.
The 95% Wilson interval is calculated over runs: five passes in ten runs prints
`50% (24–76%)`.

`$ total`, `rejected`, `intake skipped` and `transient` cover all records,
including excluded cases. Other columns and per-case cells cover the remaining counted runs.
Per-case cells show passes/runs, highest level, median known cost and median
agent time. Unavailable values display as `—`; total cost sums known costs.

To export every raw record, including excluded cases, add `--csv`:

```bash
pnpm benchmark:summarize -- tmp/model-series-a tmp/model-series-b \
    --csv tmp/model-comparison.csv
```

The CSV includes `judge` as JSON with model roles and reasoning efforts,
`agentCommit` with a dirty marker when applicable, and
`knowledgeBaseCommit`, alongside each run's failure kind and measurements.

For parallel model series, use a different `--output-root` for each, the same
judge settings and an explicit KnowledgeBase SHA. First run `--oracle-only`
(add `--refresh` to rebuild the judge cache), so historical extension builds
are warm in `tmp/cache/extensions/historical/` before starting the models.
Keep CloakBrowser auto-updates disabled: the CLI and benchmark default
`CLOAKBROWSER_AUTO_UPDATE` to `false` when unset and preserve an explicit
value, including one loaded from `.env`.

## Count the cost

The benchmark computes a cost only from a price file you supply. Without one
the cases still run, and each one prints:

```text
    cost: not computed, no price file (set LLM_PRICING_FILE)
```

To price the runs, write a price file and name it in `.env`:

```dotenv
LLM_PRICING_FILE=prices.json
```

A relative path is resolved from the repository root. The file lists USD
prices per million tokens for each model id the provider reports, which is
the id you set in `LLM_MODEL` and `LLM_VISION_MODEL`.
[`docs/examples/pricing.example.json`](../examples/pricing.example.json) is a
complete example with invented models and prices:

```json
{
    "source": "Example only: invented models and prices.",
    "models": {
        "example-reasoning-model": {
            "inputUsdPerMillionTokens": 0.5,
            "outputUsdPerMillionTokens": 2,
            "cachedInputUsdPerMillionTokens": 0.05,
            "cacheWriteUsdPerMillionTokens": 0.6,
            "reasoningUsdPerMillionTokens": 2
        },
        "example-vision-model": {
            "inputUsdPerMillionTokens": 1,
            "outputUsdPerMillionTokens": 4
        }
    }
}
```

| Field | Required | Price of |
| --- | --- | --- |
| `source` | No | Nothing; a note on where the prices came from and when |
| `inputUsdPerMillionTokens` | Yes | Uncached input tokens |
| `outputUsdPerMillionTokens` | Yes | Output tokens other than reasoning |
| `cachedInputUsdPerMillionTokens` | No | Input tokens read from the provider's cache; defaults to the input price |
| `cacheWriteUsdPerMillionTokens` | No | Input tokens written to the cache; defaults to the input price |
| `reasoningUsdPerMillionTokens` | No | Reasoning tokens; defaults to the output price |

Anthropic runs report cache writes as well as reads. Set
`cachedInputUsdPerMillionTokens` and `cacheWriteUsdPerMillionTokens` to the
provider's cache rates for an accurate cost; their fallback input price does
not reflect Anthropic's cache pricing.

A file that cannot be read, has an unknown field, or lists no model stops the
command before the first case, naming `LLM_PRICING_FILE` and the problem.

With a price file, each case prints one of these cost lines:

| Line | Meaning |
| --- | --- |
| `cost: $0.0412` | Every completion was priced |
| `cost: $0.0300 (partial, not in the price file: <models>)` | Only the listed models' completions are missing from the figure |
| `cost: not computed, not in the price file: <models>` | No model the run used is in the file; check the ids |
| `cost: not computed, the provider reported no usage` | The provider returned no token counts |
| `cost: unknown, the run wrote no usage summary` | The run ended before it counted anything |

After more than one case, `total priced cost` adds up what was priced.
`llm-usage-summary.json` has the details: tokens and cost per model and per
source (`bySource.loop` for the agent's session, `bySource.singleShot` for
one-off calls such as screenshot checks), and under `rates` the prices the run
used.

## Add a case

A case needs a closed AdguardFilters issue and the commit that fixed it. The
issue must contain a Chrome MV3 browser extension report with the exact
settings import link and at least one screenshot. The commit must have one
parent, reference the issue, and change a filter file.

Set `GITHUB_TOKEN` next to the provider settings, then run:

```bash
pnpm benchmark:case:add -- \
  --issue 235679 \
  --human-fix-commit <full-40-character-commit-sha>
```

The command uses your provider once per candidate report to extract the
reporter's environment. It assembles the reporter's historical extension
build and refuses a case if a genuinely new human-added rule is already in
that build or the version's code line has no listed release. An added rule
already present in any `.txt` file at `filtersBaseSha` is ignored. A removed
rule absent from the build prints a warning without refusing the case.
`case:check` applies the same guard. `case:add` writes the case to
`lab/benchmark/e2e/cases/<domain>-<issue>/`: `run.json` and the issue snapshot
in `issue/`, which the agent sees. It also writes `oracle.json`, withheld
from the agent and read by the comparison and case checks. The oracle holds
the human commit, `issueCreatedAt` (issue creation time) and `fixCommittedAt`
(fix committer time), both ISO timestamps.
The v3 `run.json` carries `extensionBuild`:
the reporter version, compatible release tag, and exact autobuild commit.
Pass `--case-name <name>` to choose the
directory name. An existing case is never overwritten. The command prints the
case name; run it with `pnpm test:e2e -- --case <name>`.

## Check cases

Recheck the historical builds and human-fix absence guard for every case:

```bash
pnpm benchmark:case:check -- --all
```

To check one v3 case, pass its directory name:

```bash
pnpm benchmark:case:check -- nettg-pl-235988
```

To migrate a v2 case, supply the reporter's exact four-component extension
version and set `GITHUB_TOKEN` so the command can resolve its autobuild tag:

```bash
pnpm benchmark:case:check -- nettg-pl-235988 --extension-version 5.4.3.99
```

These checks do not call an LLM or launch a browser. A passing migration
writes `run.json` v3 with `extensionBuild`; a refusal leaves the file
unchanged and names the reason, including the rule and list id when a rule
is already present. The command prints `passed`, `updated`, or `refused`
for each case and exits 1 if any case is refused. With `--all` it continues
after refusals. `--extension-version` accepts only one named case.

After changing the release table in
`lab/local/historical-extension-releases.ts`, rerun
`pnpm benchmark:case:check -- --all`. Successful checks refresh each v3
case's release tag when its code line now names another release.
