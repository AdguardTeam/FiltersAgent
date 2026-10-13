# FiltersAgent

[![license-badge]][license-url]

An AI agent for filter-list maintainers: it reproduces a reported website
problem in a real browser with an ad blocker, proposes a filter rule, verifies
it, and reports the result on the issue.

> **Note on repositories:** Active development happens in a private
> repository; this public [AdguardTeam/FiltersAgent][public-mirror] repository
> is a read-only mirror that is updated automatically from it.

## Description

Filter repositories such as
[AdguardTeam/AdguardFilters](https://github.com/AdguardTeam/AdguardFilters)
receive issues about missed ads, anti-adblock walls, broken pages and
annoyances. Each one needs a maintainer to open the site, find the cause and
write a rule. FiltersAgent does the routine part of that work and leaves the
decision to the maintainer.

For each issue the agent:

1. Reads the report and the page it names.
2. Opens the page in a stealth Chromium build, first without and then with the
   blocker the reporter uses: the AdGuard Browser Extension (MV3), or AdGuard
   CLI as a filtering proxy for desktop AdGuard reports.
3. Searches the repository's existing rules, drafts a candidate rule and
   applies it, reading the blocker's own state back to confirm what it applied.
4. Compares screenshots of the page with and without the rule through a vision
   model, and keeps the rule only when the symptom is gone and the page is
   intact.
5. Writes a report: the verified rule and the file it goes into, or why no rule
   was proposed.

The agent never merges rules, closes issues or pushes to a filters repository.
It works with any OpenAI-compatible LLM provider that offers a reasoning model
with tool calling and a vision model.

## Features

- Run the agent on new issues of your filters repository as a GitHub Action.
- Verify candidate rules in the AdGuard Browser Extension, in uBlock Origin in
  Firefox, or in any proxy blocker packaged as a blocker module.
- Teach the agent your filter policy, rule placement and report format in one
  instruction file.
- Investigate a single issue, or a snapshot of one, from the command line.
- Replay fixed historical issues as a benchmark and compare the agent's rules
  with the maintainers' commits.

## Get started

### Run it on your filters repository

You need an OpenAI-compatible LLM endpoint reachable from GitHub-hosted runners
and GitHub Issues enabled on the repository.

1. Copy
   [`docs/examples/filters-agent-workflow.yml`](docs/examples/filters-agent-workflow.yml)
   into the repository's `.github/workflows/`.
2. Add the provider's API key as the repository secret
   `FILTERS_AGENT_LLM_API_KEY`, and set the endpoint, the model names and
   their token limits in the copied workflow.
3. Open an issue. The report appears as a comment on it, and the full run is
   uploaded as a workflow artifact.

The workflow uses `AdguardTeam/FiltersAgent@v1`. The
[GitHub Action guide](docs/guides/github-action.md) covers the instruction
file, other blockers, rule placement, linting and the report template.

### Run it locally

You need Node.js 24 or newer, [pnpm](https://pnpm.io) and the same LLM
provider settings.

```bash
pnpm install
cp .env.example .env
```

Fill in the `LLM_*` values in `.env`, and `GITHUB_TOKEN` for commands that read
GitHub issues. The stealth Chromium build downloads on the first run.

## Quick start

Investigate one AdguardFilters issue and write the result to a local
directory:

```bash
pnpm start -- fix issue 12345 --repository AdguardTeam/AdguardFilters
```

The run reads the issue, drives the browser and writes the report with the
full evidence under `tmp/adguard-agent-runs/issue-12345-current/`. It posts
nothing to GitHub.

`pnpm start --help` lists the other commands; the
[CLI reference](docs/reference/cli.md) describes them.

## Documentation

- [GitHub Action guide](docs/guides/github-action.md) — connect the action and
  adapt it to your repository
- [Action inputs and outputs](docs/reference/action-inputs.md) — every input
  and output of the action
- [Benchmark guide](docs/guides/benchmark.md) — run the benchmark with your own
  LLM provider
- [CLI reference](docs/reference/cli.md) — local commands, environment
  variables and run output
- [Browser with an extension](docs/modules/browser-with-extension.md) — how the
  extension routes drive a browser
- [Publication comment format](docs/publication-comment-format.md) — the
  register and layout of the issue comment
- [Development](DEVELOPMENT.md) — set up the repository, run checks, build the
  AdGuard CLI module
- [Requirements](REQUIREMENTS.md) — product requirements and design notes
- [Changelog](CHANGELOG.md) — version history
- [Agent rules](AGENTS.md) — code style and conventions for contributors and
  coding agents

## License

[MIT](LICENSE) covers the sources in this repository.

The action image downloads two browsers from their publishers at build time:
Firefox through Playwright, and the CloakBrowser Chromium build from CloakHQ.
The CloakBrowser binary comes under its own
[binary license](https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md),
not under MIT: using it is free, redistributing it is not. Read it before you
run the action in your organization, and do not push an image that contains the
binary to a public registry.

The AdGuard CLI module downloads the AdGuard CLI release from AdGuard's GitHub
releases. Running it needs an AdGuard licence and is governed by AdGuard's own
terms, not by MIT.

[license-badge]: https://img.shields.io/github/license/AdguardTeam/FiltersAgent
[license-url]: https://github.com/AdguardTeam/FiltersAgent/blob/master/LICENSE
[public-mirror]: https://github.com/AdguardTeam/FiltersAgent
