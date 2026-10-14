# Development

How to set up FiltersAgent locally, run the checks, and work on the agent,
the AdGuard CLI module and the action.

- Code style, architecture and Git conventions live in [AGENTS.md](AGENTS.md);
  this document does not repeat them.
- Commands, environment variables and run output are listed in the
  [CLI reference](docs/reference/cli.md).

## Table of Contents

- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
    - [Install dependencies](#install-dependencies)
    - [Configure the environment](#configure-the-environment)
    - [Run the agent](#run-the-agent)
    - [Run the AdGuard CLI executor](#run-the-adguard-cli-executor)
- [Development Workflow](#development-workflow)
    - [Branching and pull requests](#branching-and-pull-requests)
    - [Package scripts](#package-scripts)
    - [Code style and linting](#code-style-and-linting)
    - [Testing](#testing)
    - [Type-checking and building](#type-checking-and-building)
- [Common Tasks](#common-tasks)
    - [Debug an agent run from its trace](#debug-an-agent-run-from-its-trace)
    - [Run the backlog without posting](#run-the-backlog-without-posting)
    - [Build the AdGuard CLI module](#build-the-adguard-cli-module)
    - [Try a change on a fork of AdguardFilters](#try-a-change-on-a-fork-of-adguardfilters)
- [IDE Configuration](#ide-configuration)
- [Troubleshooting](#troubleshooting)
    - [`error: unknown command '--help'`](#error-unknown-command---help)
    - [`ConfigError: Invalid configuration` on startup](#configerror-invalid-configuration-on-startup)
    - [`repo` commands fail with "REPOSITORY_PATH is required"](#repo-commands-fail-with-repository_path-is-required)
    - [A run fails with "Run repository is not configured"](#a-run-fails-with-run-repository-is-not-configured)
    - [`adguard cli activation failed` in the run log](#adguard-cli-activation-failed-in-the-run-log)
    - [GitHub API returns 401](#github-api-returns-401)
- [Additional Resources](#additional-resources)

---

## Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| Node.js | 24 or newer (`engines.node` in `package.json`) | Runtime |
| pnpm | 10.x (lockfile `lockfileVersion: '9.0'`) | The only supported package manager |
| An LLM endpoint | Any OpenAI-compatible API | Powers the agent loop and the vision review |
| A GitHub token | Public read access | Reading issues; not needed for offline runs |
| `gh`, `jq`, `perl` | Any recent | `scripts/copy-upstream-issue.sh` |
| Docker | With BuildKit | Building the action image (`action.Dockerfile`) |
| 1Password CLI (`op`) | Optional | Passing the AdGuard licence without writing it to `.env` |

No global CLI install is required: everything runs through `tsx` and the local
`node_modules`. A local clone of
[AdguardTeam/AdguardFilters](https://github.com/AdguardTeam/AdguardFilters),
named by `REPOSITORY_PATH`, is needed only for the `repo` commands.

```bash
node -v     # v24 or newer
pnpm -v
```

## Getting Started

### Install dependencies

From the repository root:

```bash
pnpm install
```

The `cloakbrowser` Chromium binary downloads on the first browser launch; no
manual step is needed for it. Firefox-family runs and their tests use
Playwright's Firefox build, which you install once:

```bash
pnpm exec playwright-core install firefox
```

### Configure the environment

```bash
cp .env.example .env && chmod 600 .env
```

`.env.example` is the variable inventory. The agent CLI (`pnpm start`),
`pnpm test:e2e` and `pnpm benchmark:case:add` load `.env` into the process
environment with plain dotenv; variables already exported in the shell win.

Every agent run needs an OpenAI-compatible provider named in full:
`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_VISION_MODEL` and the token
limits. There is no default provider, and a missing variable fails the run
with a `ConfigError` that names it. The
[benchmark guide](docs/guides/benchmark.md#configure-the-provider) shows a
complete `.env` and what each value must be.

Set `GITHUB_TOKEN` only for commands that read a live GitHub issue; a run from
an exported issue file does not need it.

Executable entry points read the environment once and pass it to pure loaders
such as `loadConfig()` in `src/config/config.ts`. The loaders take the
environment as an argument, so tests pass a fake one without touching
`process.env`.

### Run the agent

```bash
pnpm start --help                         # list commands
pnpm start -- show issue 12345            # print the model-filled report
pnpm start -- fix issue 12345 --verbose   # investigate one issue
pnpm start -- repo search --domain example.com
```

`--` separates pnpm's flags from the arguments forwarded to `lab/main.ts`. The
[CLI reference](docs/reference/cli.md) lists every command, option and output
file.

### Run the AdGuard CLI executor

The `adguard_cli` executor investigates reports from desktop AdGuard products
through [AdGuard CLI](https://github.com/AdguardTeam/AdGuardCLI) running as a
filtering proxy. Local runs plug it in the same way the action does: as the
blocker module committed in `adguard-cli/`, named with `--blocker-module`. The
module needs two variables:

| Variable | Purpose |
| --- | --- |
| `ADGUARD_LICENSE_KEY` | AdGuard licence the CLI is activated with for each run |
| `ADGUARD_CLI_PATH` | Absolute path of the `adguard-cli` executable; without it the module runs `adguard-cli/bin/adguard-cli` |

To run it locally:

1. Download the official release for your platform from
   https://github.com/AdguardTeam/AdGuardCLI/releases and extract it. Do not run
   its installer.
2. Set both variables in `.env` or in the environment, and name the module:

   ```bash
   ADGUARD_CLI_PATH=/path/to/adguard-cli \
   ADGUARD_LICENSE_KEY=<your-licence-key> \
   pnpm start -- fix issue 12345 --browser on \
       --blocker-module adguard-cli/blocker-module.json
   ```

   To keep the licence out of `.env` and the shell history, pass a 1Password
   reference through the 1Password CLI instead. `op run` resolves an `op://`
   reference only from the command line or an `--env-file`:

   ```bash
   ADGUARD_CLI_PATH=/path/to/adguard-cli \
   ADGUARD_LICENSE_KEY='op://<vault>/<item>/<field>' \
   op run -- pnpm start -- fix issue 12345 --browser on \
       --blocker-module adguard-cli/blocker-module.json
   ```

Without `--blocker-module` a run has only the browser extension. Without
`ADGUARD_LICENSE_KEY` the run stops before it starts and names the variable.
The run executes the bundle, not the sources: after changing
`src/adguard-cli/`, rebuild it as described in
[Build the AdGuard CLI module](#build-the-adguard-cli-module).

What a run does with the CLI (`src/adguard-cli/adguard-cli-proxy.ts`):

- It creates a fresh mode-0700 HOME for the CLI under `/tmp/agcli-`. The
  control socket lives under HOME, and the CLI fails to start once that path
  exceeds the 104-byte socket path limit, so the HOME path is kept short.
- It writes `proxy.yaml` in manual proxy mode on a loopback port. The run's
  filter lists and the agent's rules go into `filters:` as files instead of
  `flm://`, so the CLI executes exactly the lists the run downloaded.
- It runs `adguard-cli activate <key>` and checks `adguard-cli license`:
  `activate` exits 0 even when it only printed a login link. Then it runs
  `adguard-cli cert` and declines the system-store install. The browser trusts
  the CLI's authority by SPKI pin; no keychain or system trust store is
  touched.
- It starts `adguard-cli start --no-fork` and restarts it for every rule or
  list change.
- It runs `adguard-cli reset-license` when the run stops, and also when its own
  preparation fails after the activation, then deletes the HOME.

The licence key is passed to `activate` in argv, because the CLI reads it from
nowhere else, so it is briefly visible in the process list. The CLI host
replaces the key in every transcript it writes, and the run redacts
`ADGUARD_LICENSE_KEY` in its logs.

#### Seeded CLI home

Every activation binds one licence device until its reset. To keep parallel
runs on one device, activate the CLI once and pack its HOME as a seed:

```bash
ADGUARD_LICENSE_KEY=... scripts/seed-adguard-cli-home.sh /path/to/adguard-cli /tmp/agcli-home.tar.gz
```

Set `ADGUARD_CLI_HOME_ARCHIVE` to the archive. The run extracts a private copy,
checks `license`, and filters without activating. It never resets a restored
HOME: every copy shares the seed's device, and a reset on one would unbind them
all. When the seed's licence is no longer active, the run log shows
`seeded licence not active, activating instead`, and the run activates and
resets on its own. `scripts/pack-adguard-cli-home.sh` repacks an existing HOME
without activating another device.

The seed holds licence state and the CLI's own CA key. Keep it out of places
where untrusted code runs.

#### Licence devices

The seed takes one device; runs without a seed take one each while they run.
When the devices are exhausted, the run log shows
`adguard cli activation failed` with `Maximum devices exceeded`, the desktop
run ends without an evidence route, and extension runs are unaffected. A
`licence reset FAILED` line, or a killed run, leaves a device bound: unlink it
under Devices in the AdGuard account (https://my.adguard.com).

## Development Workflow

### Branching and pull requests

Development happens in AdGuard's internal repository; the public
[AdguardTeam/FiltersAgent](https://github.com/AdguardTeam/FiltersAgent)
repository is a read-only mirror of it, and pull requests opened there are not
merged. Report problems in the public repository's issues.

In the internal repository, branch off `master`, keep each branch to one
change, and open the pull request against `master`. Branch, commit and pull
request names follow the Git workflow rules in [AGENTS.md](AGENTS.md). Run
the checks below before requesting review; the `checks` workflow runs them on
every pull request.

### Package scripts

| Script | What it runs |
| --- | --- |
| `pnpm start` | The local CLI (`lab/main.ts`) |
| `pnpm test` | The Vitest suite |
| `pnpm test:e2e` | The golden end-to-end cases (`lab/e2e/run.ts`), with a real LLM provider |
| `pnpm benchmark:case:add` | Adds a golden case (`lab/e2e/case-add.ts`) |
| `pnpm benchmark:verify-run` | Verifies one benchmark run's output (`lab/benchmark/verify-run.ts`) |
| `pnpm lint` | oxlint plus the prompt-document scan |
| `pnpm fmt` | oxfmt plus `eslint --fix` on `src/` and `lab/` |
| `pnpm fmt:check` | The formatter checks without writing |
| `pnpm typecheck` | `tsc` over `src/`, `lab/` and `tests/` without emitting |
| `pnpm build` | `tsc` with emit to `dist/` |
| `pnpm build:adguard-cli` | Rebuilds the committed AdGuard CLI module in `adguard-cli/` |

The [benchmark guide](docs/guides/benchmark.md) covers the `test:e2e` and
`benchmark:*` scripts.

### Code style and linting

Code style and architecture conventions are documented in
[AGENTS.md](AGENTS.md). The toolchain that enforces them:

```bash
pnpm lint        # oxlint (code quality and JSDoc) plus the prompt-document scan
pnpm fmt         # oxfmt plus eslint --fix on src/ and lab/
pnpm fmt:check   # the same checks without writing, as CI runs them
```

`0 errors` from `pnpm lint` is the success criterion; warnings do not fail it.

### Testing

Tests use [Vitest](https://vitest.dev) and live under the root `tests/`
directory, mirroring `src/` and `lab/` (`src/repo/search.ts` →
`tests/repo/search.test.ts`); read-only fixtures sit beside the tests that use
them. Write the failing test first, then the minimal implementation.

```bash
pnpm test              # the whole suite, once
pnpm test tests/repo   # one directory or file
```

Paths that use Octokit are mocked, so the suite needs no `GITHUB_TOKEN`. The
pilot corpus integrity test reads ten public human commits to prove that their
rules are absent from agent-visible input, so the complete suite needs network
access. The test makes ten sequential shallow fetches from the public
AdguardFilters remote; an anonymous fetch has taken 18–27 seconds, so this one
test can take several minutes, and its timeout is ten minutes.

CI runs `pnpm vitest run` without
`tests/browser/strict-route-proxy-contract.test.ts`: that suite launches a real
browser through the strict route, and the launch fails on the CI runner. Run it
locally when you change the strict route.

For changes to the extension route, this subset is a quicker regression gate
than the complete suite:

```bash
pnpm exec vitest run \
  tests/environment/filtering-environment-execution-recorder.test.ts \
  tests/environment/browser-extension-environment.test.ts \
  tests/environment/environment-result-projection.test.ts \
  tests/browser/browser-session.test.ts \
  tests/validator/phase-orchestrator.test.ts \
  tests/orchestrator/agent-runtime.test.ts \
  tests/orchestrator/fix-core.test.ts \
  tests/types/fix-run-result.test.ts
```

The golden end-to-end cases are the benchmark: adding a case, running one or
all of them, reading the results and counting the cost are covered in the
[benchmark guide](docs/guides/benchmark.md). They call a real LLM provider and
are not part of `pnpm test`.

### Type-checking and building

```bash
pnpm typecheck   # type-check src/, lab/ and tests/
pnpm build       # tsc with emit to dist/
```

Nothing consumes `dist/`: the CLI runs through `tsx`, and the action boots its
sources through `tsx` inside the image `action.Dockerfile` builds.

## Common Tasks

### Debug an agent run from its trace

Every `fix` run records a trace at `artifacts/trace-<run-id>.json` in its
investigation directory: every LLM turn and tool call in order. Add
`--verbose` for debug-level logs on stderr during the run, and set
`HEADLESS=false` to watch the browser.

### Run the backlog without posting

`backlog` posts its reports as issue comments whenever `GITHUB_TOKEN` is set,
on whichever repository the identity resolves to. Pass `--no-comment` to keep
the reports local:

```bash
pnpm start -- backlog --repository AdguardTeam/AdguardFilters \
    --limit 2 --no-comment --output-dir "$PWD/tmp/backlog-runs"
```

Each issue's report is written to its own artifacts directory under
`--output-dir`.

### Build the AdGuard CLI module

The `adguard-cli` setup action, which a workflow plugs in as
`uses: AdguardTeam/FiltersAgent/adguard-cli@<ref>` once a release carries it,
is generated: `scripts/build-adguard-cli-module.ts` bundles the module process
from `src/adguard-cli/` and copies the setup action from
`modules/adguard-cli/action.yml` together with the scripts it runs:
`scripts/fetch-adguard-cli.mjs`, which installs a pinned release and verifies
its checksum and signature, and the seed scripts.

GitHub reads `adguard-cli/` from the repository at the referenced ref, so the
built module is committed. Rebuild it and commit the result whenever you change
`src/adguard-cli/`, a source module it imports, `modules/adguard-cli/`, one of
the copied scripts, or a dependency the bundle includes:

```bash
pnpm run build:adguard-cli
git add adguard-cli/
```

The build empties `adguard-cli/` and writes it again. Its output depends only on
the sources and the lockfile, so two builds give byte-identical files. The
`Checks` workflow rebuilds the module and fails when the result differs from the
committed copy.

The action image leaves `src/adguard-cli/` out, so the action itself never
carries the CLI code. The local CLI and the benchmark run the same bundle
through `--blocker-module adguard-cli/blocker-module.json`; see
[Run the AdGuard CLI executor](#run-the-adguard-cli-executor).

### Try a change on a fork of AdguardFilters

A fork of `AdguardTeam/AdguardFilters` gives you real reports without touching
the upstream issues. A workflow in a public fork can only use a published
release of the action, so an unreleased change runs through the local CLI
against the fork's issues.

1. Fork `AdguardTeam/AdguardFilters` and enable Issues in the fork's settings;
   forks start with Issues off.
2. Copy an upstream issue into the fork:

   ```bash
   scripts/copy-upstream-issue.sh 239744 <you>/AdguardFilters --no-label
   ```

   The script copies the body and the human comments and wraps every mention
   and issue reference in a code span, so nothing notifies upstream.
   `--no-label` leaves out the `filters-agent` label that starts a connected
   action.
3. Run your change on the copied issue:

   ```bash
   pnpm start -- fix issue <number> --repository <you>/AdguardFilters
   ```

   The report and the full evidence land in the output directory the
   [CLI reference](docs/reference/cli.md) describes.

To try the released action on the fork, enable Actions as well, disable the
workflows the fork inherited (`gh workflow disable <workflow> --repo
<you>/AdguardFilters`), connect it as the
[GitHub Action guide](docs/guides/github-action.md#connect-it-to-your-repository)
describes, and copy an issue without `--no-label`. Keep the base URL in a
secret too: workflow artifacts of a public fork are readable by anyone.

## IDE Configuration

**JetBrains IDEs** import the TypeScript configuration and the ESLint setup
from the repository automatically.

**VS Code** has no committed workspace settings. Install the TypeScript and
ESLint extensions and enable ESLint format-on-save with the flat config
`eslint.config.js`. `oxfmt` has no VS Code extension yet, so run `pnpm fmt`
before committing.

## Troubleshooting

### `error: unknown command '--help'`

You ran `pnpm start -- --help`. Use `pnpm start --help`, or
`pnpm start <command> <subcommand> --help` for one command.

### `ConfigError: Invalid configuration` on startup

A required environment variable is missing or malformed. Agent runs require
`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_VISION_MODEL` and the token
limits; commands that read GitHub also require `GITHUB_TOKEN` and a repository
identity. The error message names every missing or invalid variable.

### `repo` commands fail with "REPOSITORY_PATH is required"

`repo search` and `repo map` need a local checkout of the filters repository:

```bash
git clone https://github.com/AdguardTeam/AdguardFilters.git ../AdguardFilters
export REPOSITORY_PATH="$PWD/../AdguardFilters"
```

### A run fails with "Run repository is not configured"

The run has no repository to read the lists from: `REPOSITORY_PATH` is unset
or points at a checkout without a parseable `origin` remote, and no repository
is named. Set `REPOSITORY_PATH` to a git checkout of the filters repository or
pass `--repository <owner>/<repo>`.

### `adguard cli activation failed` in the run log

`adguard-cli license` reported no active licence after `activate`. The log
entry carries both commands' output. With `Maximum devices exceeded` the
licence has no free device: see [Licence devices](#licence-devices). Otherwise
check `ADGUARD_LICENSE_KEY`.

### GitHub API returns 401

`GITHUB_TOKEN` is missing, expired, or lacks read access to the repository.
Regenerate the token with at least public repository read access.

## Additional Resources

- [AGENTS.md](AGENTS.md) — code style, toolchain, and architecture conventions
- [README.md](README.md) — what the project is and how to start
- [CHANGELOG.md](CHANGELOG.md) — version history
- [DEPLOYMENT.md](DEPLOYMENT.md) — what a release contains and how to cut one
- [CLI reference](docs/reference/cli.md) — commands, environment variables and
  run output
- [Action inputs](docs/reference/action-inputs.md) — every input of the action
- [GitHub Action guide](docs/guides/github-action.md) — connect and configure
  the action
- [Benchmark guide](docs/guides/benchmark.md) — golden cases and the benchmark
- [Runtime architecture](docs/explanation/runtime-architecture.md) — the agent
  loop, environment selection, input limits and local publication
- [Browser with an extension](docs/modules/browser-with-extension.md) — how
  the extension routes drive a browser
- [Publication comment format](docs/publication-comment-format.md) — the
  register and layout of the issue comment
- [REQUIREMENTS.md](REQUIREMENTS.md) — product requirements and design notes
- [TODO.md](TODO.md) — open work: what the agent does not do yet
- [`.env.example`](.env.example) — every supported environment variable
