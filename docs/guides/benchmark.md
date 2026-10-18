# Run the benchmark with your own LLM provider

The benchmark replays historical AdguardFilters issues that maintainers have
already fixed. For each case the agent investigates the issue as it was
reported, before the fix existed. The case is scored by what the agent
itself reached, and the rule the maintainer committed is recorded beside the
agent's rule for comparison after a series. An endpoint speaking the OpenAI
chat-completions or Anthropic Messages API works: you supply the endpoint,
the key, the models, and optionally the prices.

- [Before you start](#before-you-start)
- [Configure the provider](#configure-the-provider)
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
extension. The benchmark plugs in no blocker module: module filter lists
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

Before the first case, the suite reads every selected case's `oracle.json`
and refuses the selection, naming the case, if one is missing or malformed.

Before the agent starts, each case requests the reported page with a plain
HTTP request: no browser and no model. The page is the `Issue URL` of the
report the case is pinned to: the latest report form, in the issue body or a
reporter comment, whose settings import link is a Chrome MV3 extension report
of the version in `run.json`, the rule `benchmark:case:add` pins it by.

The first HTTP response counts as an answer, without following redirects: a
3xx, or a 403 or 503 from a challenge page, included. So does any failure
after a host answered, such as a dropped connection, headers the HTTP client
refuses to parse, or a certificate chain it cannot complete; the browser may
still load such a page. Only a host that never answers ends the case as
`site_unreachable` without starting the agent: the name does not resolve,
nothing listens, there is no route, the connection is not accepted within 10
seconds, or no response arrives within 20 seconds, in both of two attempts.

To give every agent series the same KnowledgeBase revision, pass
`--knowledge-base-sha <full-40-character-commit-sha>`. Without it, the suite
resolves KnowledgeBase `master` once before the first case. The selected
SHA is printed and recorded for every agent run. An incomplete or malformed
SHA is refused.

The benchmark presents each historical report to the agent as open, without
an assignee or `A:` labels; `T:`, `P:` and `N:` labels remain. The saved
snapshot stays unchanged. If the historical
checkout contains a loaded repository instruction at
`.github/filters-agent/AGENTS.md`, the benchmark stops before investigation
with `infrastructure_failure`, `failureKind: transient`, and the file path
in the detail.

## Read the results

The command prints one entry per case:

```text
nettg-pl-235988: verified
    cost: $0.0412
sochi-camera-234715: site_unreachable (https://sochi.camera/ did not answer: fetch failed: UND_ERR_CONNECT_TIMEOUT)
    cost: unknown, the run wrote no usage summary
```

A case whose human fix commit could not be read adds a third line,
`human fix not read: <error>`.

| Status | Meaning |
| --- | --- |
| `verified` | The agent proposed a rule and verified it in the browser with `apply_rule` |
| `proposed` | The agent found a rule it could not verify and carried it for review |
| `reproduced` | The agent's check with the prepared blocker counted the problem as present, but it proposed no rule |
| `not_reproduced` | The agent neither reproduced the problem nor proposed a rule |
| `infrastructure_failure` | The run could not finish; the failure kind and the detail say why |
| `site_unreachable` | The case site did not answer, so the agent did not start |

The benchmark does not check the agent's rule against the maintainer's, and
does not re-check the maintainer's fix on today's site. A case whose fix no
longer applies shows up as a case that no model reproduces.

Reproduction comes from the agent's own check with the prepared blocker. A
symptom seen only without the blocker, or only with the agent's candidate
applied, does not count.

- Once `apply_rule` has prepared the environment, only the baseline phase of
  an `apply_rule` experiment counts. It counts unless vision found the problem
  absent there, so an indeterminate classification counts as reproduced. A run
  refused after preparation, or whose baseline phase failed, is
  `not_reproduced` even when the agent's own prepared session showed the
  problem.
- Without a prepared environment, a prepared session the agent launched counts
  when its complete, vision-verified capture shows the problem.

The exit code is 0 when every case reached one of the four agent statuses,
and 3 when any case ended as `infrastructure_failure` or `site_unreachable`.
A failing provider is reported as `infrastructure_failure`, not as an agent
result. Exit code 3 is also used when the command itself fails, for example
on a missing variable.

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
| Evaluation `benchmark-record.json` | Model identity, environment pins, timings, usage and cost, outcome, the agent's rule and the maintainer's fix |

Every case writes `benchmark-record.json`, failures included. Its
`schemaVersion` is 2. The outcome and the maintainer's fix:

| Field | Value |
| --- | --- |
| `site.url` | The page the site check requested; `site` is `null` when the case failed before the check |
| `site.reachable` | Whether a host answered |
| `site.answer` | `HTTP <status>`, or the network error |
| `outcome.status` | One of the statuses above |
| `outcome.failureKind` | For `infrastructure_failure`: `provider_rejected`, `intake_skipped` or `transient`; otherwise `null` |
| `outcome.detail` | What failed or did not answer; `null` for an agent status |
| `outcome.reporterEnvironment` | Whether the agent's verified session used the reporter's extension build, filters and Stealth state; `null` when no sealed run was read |
| `outcome.candidate` | The verified rule, its file and edit, as in `run-result.json`; `null` without one |
| `outcome.candidateForReview` | The unverified rule, its file and why it was not verified; `null` without one |
| `human.fixCommit` | The maintainer's fix commit |
| `human.firstParent` | The commit the rules were read against; `null` when the commit could not be read |
| `human.rules` | Rules the commit added, extended or replaced; `null` when the commit could not be read |
| `human.removedRules` | Rules the commit only removed; `null` when the commit could not be read |
| `human.rulesError` | Why the commit could not be read; otherwise `null` |
| `human.elapsedMs` | Issue creation to fix commit |

`provider_rejected` is an agent provider rejection, including intake.
`intake_skipped` means the agent's intake declined the issue as not a filter
report. `transient` covers other infrastructure failures, including
repository-instruction refusals.

`outcome.reporterEnvironment.status` is `matched`, `agent_mismatch`, or
`unavailable`. The reporter's environment is read by code, never by a model,
from the settings import link of the pinned report, with the parser
`launch_browser` applies the link with. A mismatch does not change
`outcome.status`. `unavailable` means the comparison could not be made: the
pinned report has no single usable import link or is not MV3, or the run
stopped before it prepared the reporter's build. `timings.siteCheckMs` is the
site check; `timings.preparationMs` starts after it. Usage and cost cover the
agent.

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

If the agent commit or dirty state, KnowledgeBase commit, or browser build
differ anywhere in the input records, a `mixed pins:` line names each
differing condition and its number of distinct values. The summary still
includes the records; use consistent pins when comparing model quality.

The verified-rate denominator counts every run except `transient` failures
and `site_unreachable` cases. `provider_rejected` and `intake_skipped` count
as failed runs. The 95% Wilson interval is calculated over runs: five
`verified` runs in ten prints `50% (24–76%)`. `proposed` and `reproduced`
count runs with exactly that status; `env mismatch` counts counted runs
whose `reporterEnvironment.status` is `agent_mismatch`.

`$ total`, `rejected`, `intake skipped`, `transient` and `site unreachable`
cover all records. Other columns and per-case cells cover counted runs.
Per-case cells show verified/runs, the strongest status among the runs,
median known cost and median agent time. Unavailable values display as `—`;
total cost sums known costs.

After the tables come these lines:

- `agent vs human:` the agent median over counted runs, and the human
  median over the same cases.
- `no model reproduced:` cases whose runs reached an agent status, yet none
  reached `reproduced` or better, for any model. This is how a stale case
  shows. Provider rejections and intake skips do not put a case here.
- `site unreachable:` cases whose site did not answer before at least one
  run.
- `mixed pins:` only when pins differ, as above.

`benchmark:summarize` reads only `schemaVersion` 2 records and fails naming
an older file.

To export every raw record, uncounted runs included, add `--csv`:

```bash
pnpm benchmark:summarize -- tmp/model-series-a tmp/model-series-b \
    --csv tmp/model-comparison.csv
```

The CSV includes `agentCommit` with a dirty marker when applicable,
`knowledgeBaseCommit` and `reporterEnvironment`, alongside each run's
status, failure kind and measurements. For the rule comparison it has the
agent's `agentRule` and `agentFilePath`, verified or carried for review,
`agentEdit` for a verified rule only, and the maintainer's `humanFixCommit`,
`humanRules` (a JSON array of `rule`, `repositoryEdit` and `replacedRule`),
`humanRemovedRules` and `humanRulesError`.

A spreadsheet reads a cell that starts with `-`, `+`, `=` or `@` as a
formula, and filter rules often start with `-`. Import the rule columns as
text; the CSV keeps the raw values for scripts.

For parallel model series, use a different `--output-root` for each and an
explicit KnowledgeBase SHA. First run `pnpm benchmark:case:check -- --all`,
so historical extension builds are warm in `tmp/cache/extensions/historical/`
before starting the models.
Keep CloakBrowser auto-updates disabled: the CLI and benchmark default
`CLOAKBROWSER_AUTO_UPDATE` to `false` when unset and preserve an explicit
value, including one loaded from `.env`.

## Count the cost

The benchmark computes a cost only from a price file you supply. Without one
the cases still run, and each one that ran the agent prints:

```text
    cost: not computed, no price file (set LLM_PRICING_FILE)
```

A case that wrote no usage summary, such as a `site_unreachable` case,
prints `cost: unknown, the run wrote no usage summary` with or without a
price file.

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
from the agent. The suite checks it is readable before the first case and
reads the human fix only after each agent's run; the case checks read it
too. The oracle holds
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
