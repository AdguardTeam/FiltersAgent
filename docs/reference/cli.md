# CLI reference

The local command-line interface of FiltersAgent: its commands, the
environment variables it reads, and the files a run writes. Setup is in
[README.md](../../README.md#run-it-locally); the GitHub Action has its own
[reference](action-inputs.md).

- [Invocation](#invocation)
- [Commands](#commands)
- [Environment variables](#environment-variables)
- [Blocker modules](#blocker-modules)
- [Repository identity](#repository-identity)
- [Run output](#run-output)

## Invocation

The CLI is named `filters-agent` and runs through `tsx` from the repository
root, with no build step:

```bash
pnpm start -- <command> [options]
```

`--` separates pnpm's own flags from the CLI's. `pnpm start --help` prints the
command list, and `pnpm start <command> <subcommand> --help` prints every
option of one command.

The CLI loads the workspace `.env` into the process environment at startup;
variables already exported in the shell take precedence.

## Commands

| Command | Description |
| --- | --- |
| `fix issue <number>` | Investigate one issue in the browser and write the locked result locally; never posts to GitHub |
| `show issue <number>` | Extract the issue through the LLM and print the filled report (read-only) |
| `export issue <number>` | Export an issue and its images as a revision bundle for an offline run (read-only) |
| `backlog` | Run the agent on open issues without an agent report, newest first, up to `--limit` |
| `repo search` | Search rules in the `REPOSITORY_PATH` checkout by `--domain`, `--selector`, `--url-pattern` or `--scriptlet` |
| `repo map` | Generate `placement-map.json` from the `REPOSITORY_PATH` checkout |

`backlog` posts its reports as issue comments whenever `GITHUB_TOKEN` is set;
pass `--no-comment` to keep them in the output directory only.
`backlog` takes `--executors` and `--blocker-module` with the same meaning as
`fix issue`.

### `fix issue` options

| Option | Description |
| --- | --- |
| `--repository <owner/repo>` | Repository the issue belongs to; see [Repository identity](#repository-identity) |
| `--browser <mode>` | `auto` (default) or `on`; `off` is accepted only by `show` |
| `--executors <names>` | Comma-separated executors the run may select: `browser_extension` and the executors of the plugged-in modules; defaults to all of them |
| `--blocker-module <manifest>` | Plug in the blocker module this manifest describes; repeatable. Refused with `--environment historical`. See [Blocker modules](#blocker-modules) |
| `--issue-file <path>` | Read the issue from an `export issue` bundle instead of GitHub |
| `--environment <mode>` | `current` (default) runs against the filters' current state; `historical` uses the filters commit and reporter extension build in `--run-config` |
| `--run-config <path>` | JSON case file with the issue identity, historical filters commit, and `extensionBuild` (`version`, `releaseTag`, `autobuildCommit`) |
| `--output-dir <path>` | Output directory; defaults to `./tmp/adguard-agent-runs/issue-<number>-<environment>` |
| `--instruction <path>` | Run instruction file, relative to the checkout; defaults to `.github/filters-agent/AGENTS.md` when present |
| `--lint-command <command>` | The filters repository's own lint command, run over each candidate rule |
| `--model <name>` | Override the reasoning model for this run; vision follows it when `LLM_VISION_MODEL` is unset |
| `--routing-check` | Stop right after the agent locks its environment selection |
| `--keep-temporary-files` | Keep the disposable checkouts for debugging |
| `--verbose` | Debug-level logging on stderr |

An offline run of an exported issue:

```bash
pnpm start -- export issue 12345 --output-dir /tmp/issue-12345-bundle
pnpm start -- fix issue 12345 \
    --issue-file /tmp/issue-12345-bundle/issue.json \
    --output-dir /tmp/issue-12345-run
```

The bundle holds at most 12 attachments and 48 MiB in total. A malformed or
digest-mismatched bundle ends the run with an `invalid_snapshot` result before
any model, browser or checkout work starts.

## Environment variables

`.env.example` lists every variable with an example value. The LLM variables
marked required have no default: a missing one fails the run with a
`ConfigError` that names it.

Invalid request timeouts, retry counts and reasoning efforts name their
`LLM_*` variable in the error. Intake provider rejections are identified as
provider rejections and retain the stop reason in the run's failure detail.
Benchmark judge settings use the same validation under `E2E_JUDGE_*`; see
[Configure the judge](../guides/benchmark.md#configure-the-judge).

`anthropic-messages` uses adaptive thinking and targets Claude models that
support it (Claude 5.x).

On Anthropic, `LLM_REASONING_EFFORT=off` registers a non-reasoning entry and
omits `thinking`; a model that thinks by default keeps thinking. With loop
effort on, `LLM_SINGLE_SHOT_REASONING_EFFORT=off` sends
`thinking: {type: "disabled"}` on reasoning-enabled entries. Claude Opus 5.5
and Sonnet 5.5 reject this with HTTP 400; Haiku 5.5 accepts it.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `LLM_BASE_URL` | Yes | — | OpenAI chat-completions or Anthropic Messages API base URL; for Anthropic use `https://api.anthropic.com` without `/v1` (a versioned suffix is rejected at startup) |
| `LLM_API` | No | `openai-completions` | API for both model roles: `openai-completions` or `anthropic-messages` |
| `LLM_API_KEY` | Yes | — | Provider API key; never written to run artifacts |
| `LLM_MODEL` | Yes | — | Reasoning and tool-calling model |
| `LLM_VISION_MODEL` | No | Effective reasoning model | Model that reads screenshots; follows `--model` when unset, so the effective reasoning model must accept images |
| `LLM_CONTEXT_WINDOW_TOKENS` | Yes | — | Context window registered for both models |
| `LLM_MAX_OUTPUT_TOKENS` | Yes | — | Completion cap of the reasoning model, sent on every loop request |
| `LLM_VISION_MAX_OUTPUT_TOKENS` | When the vision model differs | `LLM_MAX_OUTPUT_TOKENS` | Completion cap of the vision model |
| `LLM_REASONING_EFFORT` | No | `high` | Thinking effort of loop requests: `off`, `minimal`, `low`, `medium` or `high` |
| `LLM_SINGLE_SHOT_REASONING_EFFORT` | No | `low` | Thinking effort of single-shot calls: issue extraction and vision verdicts |
| `LLM_REQUEST_TIMEOUT_MS` | No | `300000` | Per-attempt stall deadline: time to the response headers, then the longest gap between streamed deltas (30000–300000) |
| `LLM_REQUEST_MAX_ATTEMPTS` | No | `2` | Total attempts for transient LLM failures (1–3) |
| `LLM_PRICING_FILE` | No | — | JSON price file runs are priced from; without it the cost is not computed ([format](../guides/benchmark.md#count-the-cost)) |
| `GITHUB_TOKEN` | For GitHub reads and comments | — | GitHub token scoped to the repository operation |
| `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME` | No | — | Repository identity, set together |
| `REPOSITORY_PATH` | For `repo` commands | — | Path of a local filters repository checkout |
| `ADGUARD_LICENSE_KEY` | With the AdGuard CLI module | — | AdGuard licence the CLI is activated with for each run |
| `ADGUARD_CLI_PATH` | No | `adguard-cli/bin/adguard-cli` | Path of the official `adguard-cli` executable the AdGuard CLI module runs |
| `ADGUARD_CLI_HOME_ARCHIVE` | No | — | Seeded CLI home archive the AdGuard CLI module restores instead of activating |
| `HEADLESS` | No | `true` | Run the browser headless |
| `CLOAKBROWSER_AUTO_UPDATE` | No | `false` | CloakBrowser auto-updates in the CLI and benchmark; an explicit value, including one from `.env`, is preserved |
| `NO_SANDBOX` | No | `false` | Pass `--no-sandbox` to Chromium |

The `ADGUARD_*` variables reach the AdGuard CLI module only: see
[Blocker modules](#blocker-modules). Running the CLI locally is described in
[DEVELOPMENT.md](../../DEVELOPMENT.md#run-the-adguard-cli-executor).

## Blocker modules

A blocker module adds an executor beside the built-in browser extension. It is
a process that speaks the blocker protocol on stdio, described by a JSON
manifest. Current `fix issue` and `backlog` runs take
`--blocker-module <manifest>`; the action takes the same manifests in its
`blockerModules` input. Historical local runs and the benchmark refuse
`--blocker-module` because module lists cannot be pinned to the reporter's date.

- A relative manifest path resolves against the working directory, which is
  the repository root under `pnpm start`.
- The run registers the module's executor before it resolves `--executors`.
  Without `--executors` the run locks `browser_extension` and every plugged-in
  module.
- The module process receives `PATH`, `HOME`, `LANG`, `TMPDIR`, the variables
  the manifest lists in `env` and `optionalEnv`, and nothing else from the
  environment.
- A manifest that cannot be read, is not valid JSON or is not a manifest stops
  the run before any model or browser work, naming the file. So does a
  variable from the manifest's `env` that neither the environment nor `.env`
  sets.

The AdGuard CLI module is committed in `adguard-cli/`; plug it in with
`--blocker-module adguard-cli/blocker-module.json`.

## Repository identity

The repository is never written in code. Commands that read GitHub resolve it
in this order:

1. the `--repository <owner/repo>` option;
2. the `GITHUB_REPO_OWNER` and `GITHUB_REPO_NAME` pair;
3. `GITHUB_REPOSITORY`, as GitHub Actions sets it;
4. the origin remote of the `REPOSITORY_PATH` checkout.

With none of them present the command fails with a `ConfigError` that names
every source.

## Run output

A `fix issue` run writes `cycle-result.json` to its output directory: the
cycle's own UUID, the selection provenance and the outcome. The investigation
itself is in the nested `investigation/` directory:

| File | Content |
| --- | --- |
| `agent-decision.json` | The typed payload the agent ended the run with; absent when the host had to end the run |
| `agent-observations.json` | The sanitized tool results delivered to the model |
| `run-result.json` | Host facts: environment, browser and settings status, evidence bindings |
| `agent-report.md` | Human-readable rendering of the locked result |
| `llm-usage-summary.json` | Requests, tokens and cost per model |
| `candidate.patch` | The proposed change to the filters checkout, when there is one |
| `agent-run-manifest.json` | SHA-256 digests binding all files above and everything under `artifacts/` |
| `artifacts/` | Traces (`trace-<run-id>.json`), screenshots, DOM, HAR and logs |

`AGENT_RUN_DIRECTORY=<directory> pnpm benchmark:verify-run` checks a run
directory against its manifest; the
[benchmark guide](../guides/benchmark.md#read-the-results) shows it on a
benchmark case.
