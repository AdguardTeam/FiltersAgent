# Run the benchmark with your own LLM provider

The benchmark replays historical AdguardFilters issues that maintainers have
already fixed. For each case the agent investigates the issue as it was
reported, before the fix existed. A browser then checks the agent's rule
against the rule the maintainer committed. Any OpenAI-compatible provider
works: you supply the endpoint, the key, the models, and optionally the
prices.

- [Before you start](#before-you-start)
- [Configure the provider](#configure-the-provider)
- [Run one case or the whole set](#run-one-case-or-the-whole-set)
- [Read the results](#read-the-results)
- [Count the cost](#count-the-cost)
- [Add a case](#add-a-case)

## Before you start

You need:

- **Node.js 24 or newer** and **pnpm 10**.
- **git** and network access to `github.com`. Each case clones
  AdguardFilters at the commit before the fix and downloads the pinned
  AdGuard Browser Extension release.
- **An OpenAI-compatible endpoint** (chat completions) with two models:
    - a reasoning model that supports tool calling;
    - a vision model that accepts images. It can be the same model.
- **A GitHub token** with public read access, only to add cases. Running
  cases works without one; set `GITHUB_TOKEN` anyway if GitHub rate-limits
  your anonymous clones.

You do not need a browser install: the stealth Chromium build is downloaded
on the first run. You do not need the AdGuard CLI either: every case is a
Chrome MV3 browser extension report, and the benchmark does not use the
desktop executor.

Install the dependencies from the repository root:

```bash
pnpm install
```

## Configure the provider

Put the provider settings in `.env` at the repository root. The benchmark
commands read it; variables already exported in your shell take precedence.

```dotenv
LLM_BASE_URL=https://llm.example.com/v1
LLM_API_KEY=your-key
LLM_MODEL=example-reasoning-model
LLM_VISION_MODEL=example-vision-model
LLM_CONTEXT_WINDOW_TOKENS=131072
LLM_MAX_OUTPUT_TOKENS=32768
LLM_VISION_MAX_OUTPUT_TOKENS=8192
```

| Variable | Value |
| --- | --- |
| `LLM_BASE_URL` | Base URL of the OpenAI-compatible API, up to `/v1` |
| `LLM_API_KEY` | API key of that endpoint |
| `LLM_MODEL` | Reasoning model id, as the provider spells it |
| `LLM_VISION_MODEL` | Vision model id, as the provider spells it |
| `LLM_CONTEXT_WINDOW_TOKENS` | Context window of the models |
| `LLM_MAX_OUTPUT_TOKENS` | Completion limit of the reasoning model |
| `LLM_VISION_MAX_OUTPUT_TOKENS` | Completion limit of the vision model |

There are no defaults. Take the limits from your provider's model page: a
value above the model's own limit fails every request with HTTP 400. Set
`LLM_MAX_OUTPUT_TOKENS` to the model's full limit, because the model's
reasoning and its final answer share it. `LLM_VISION_MAX_OUTPUT_TOKENS` may be
left out only when both model variables name the same model.

A missing or empty variable stops the command before the first case and names
the variable:

```text
Invalid configuration:
  - llm.model: LLM_MODEL is required
```

Optional tuning variables (reasoning effort, request timeout, retries,
gateway routing) are listed in the
[CLI reference](../reference/cli.md#environment-variables).

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
minutes per case. Each run of a case replaces that case's previous output.

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

The files of each case are in two directories under `tmp/`:

| Path | Contents |
| --- | --- |
| `tmp/e2e-runs/<case>/agent-report.md` | The agent's report |
| `tmp/e2e-runs/<case>/run-result.json` | The agent's result: status, proposed rule, evidence |
| `tmp/e2e-runs/<case>/candidate.patch` | The proposed filter change, when there is one |
| `tmp/e2e-runs/<case>/llm-usage-summary.json` | Tokens and cost, per model and in total |
| `tmp/e2e-runs/<case>/agent-run-manifest.json` | Digests that lock the files above |
| `tmp/e2e-evaluations/<case>/e2e-result.json` | The comparison: status, detail, agent rule, human rule |

The agent's run is locked before the human fix is read, so the agent never
sees the answer. To check that a run directory still matches its lock, for
example before sharing it:

```bash
AGENT_RUN_DIRECTORY=tmp/e2e-runs/nettg-pl-235988 pnpm benchmark:verify-run
```

It prints the run id and exits 0 when every file matches its digest. It
exits 1 and names the problem otherwise.

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
reporter's environment. It writes the case to
`lab/benchmark/e2e/cases/<domain>-<issue>/`: `run.json` and the issue snapshot
in `issue/`, which the agent sees, and `oracle.json` with the human commit,
which only the comparison reads. Pass `--case-name <name>` to choose the
directory name. An existing case is never overwritten. The command prints the
case name; run it with `pnpm test:e2e -- --case <name>`.
