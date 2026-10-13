# AGENTS.md

## Table of Contents

- [Project Overview](#project-overview)
- [Technical Context](#technical-context)
- [Project Structure](#project-structure)
- [Build And Test Commands](#build-and-test-commands)
- [Contribution Instructions](#contribution-instructions)
- [Code Guidelines](#code-guidelines)
    - [System Design](#system-design)
    - [Architecture](#architecture)
    - [Code Quality](#code-quality)
    - [Testing](#testing)
    - [Dependency Management](#dependency-management)
    - [Configuration & Documentation](#configuration--documentation)
    - [Other](#other)

## Project Overview

FiltersAgent is an AI agent for filter-list maintainers. It reads an issue in a filter-list
repository, reproduces the reported problem in a real browser with a real content blocker, proposes
a filter rule, verifies it, and reports the result as a comment on the issue. Maintainers run it as
a GitHub Action on their repository; developers also run it from a local CLI and replay fixed
historical issues as a benchmark.

## Technical Context

- **Language/Version**: TypeScript 5 (`typescript` in `package.json`) on Node.js 24 or newer
  (`engines.node`); sources run through `tsx`.
- **Primary Dependencies**: `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` (LLM
  runtime), `cloakbrowser` and `playwright-core` (browsers), `valibot` (schemas), `commander`
  (CLI), `@octokit/rest` (GitHub), `pino` (logging), `undici` (HTTP).
- **Storage**: N/A — a run writes its report and evidence to a local output directory.
- **Testing**: Vitest 3.
- **Target Platform**: a Linux container on GitHub Actions runners (`action.Dockerfile`) and
  developer machines (macOS, Linux) for the local CLI and the benchmark.
- **Project Type**: GitHub Action (container) plus a local CLI tool and a benchmark harness. A
  pluggable blocker module (`adguard-cli/`) is generated from the sources.
- **Performance Goals**: N/A — a run is bounded by `AGENT_INVESTIGATION_BUDGET_MS`.
- **Constraints**: an OpenAI-compatible LLM endpoint configured in full; the CloakBrowser binary
  must not be redistributed; the repository is mirrored publicly (see [Other](#other)).
- **Scale/Scope**: one issue per run, or a repository's open-issue backlog.

## Project Structure

```text
filters-agent/
├── action.yml                 # GitHub Action metadata; the container boots src/action/
├── action.Dockerfile          # Action image: Chromium, Firefox, the sources run through tsx
├── src/                       # Everything the action ships
│   ├── action/                # Action entry point and input binding
│   ├── entry/                 # One issue run and the backlog, shared by the action and the CLI
│   ├── orchestrator/          # Fix mode: AgentRuntime, phases, candidate validation and verdict
│   ├── session/               # Mode-session wiring every prompt-driven mode shares
│   ├── pi/                    # LLM runtime: provider, agent loop, single-shot calls, usage
│   ├── prompts/documents/     # Every prompt as a Markdown document
│   ├── agent/                 # Tool names, model-facing guidance, per-mode tool surfaces
│   ├── browser/               # Browser engines (CloakBrowser Chromium, Playwright Firefox), tools
│   ├── environment/           # Host/model boundary contracts and environment adapters
│   ├── local/                 # Local Host implementations: checkouts, issue capture, output
│   ├── adguard-cli/           # AdGuard CLI executor, a separately pluggable module
│   ├── types/                 # Shared Valibot schemas and value sets (fix outcome, run result)
│   └── ...                    # config, github, intake, knowledge, publisher, repo, rules, validator
├── lab/                       # Development tools outside the action: local CLI, benchmark
│   ├── cli/                   # CLI commands (commander); entry point lab/main.ts
│   ├── local/                 # Local fix cycle, run configuration, issue export
│   ├── e2e/                   # Golden end-to-end runner and case tooling (the benchmark)
│   ├── benchmark/             # Golden case data, run verification, diagnostics redaction
│   └── ...                    # pricing, repo
├── modules/adguard-cli/       # Setup action of the AdGuard CLI module
├── scripts/                   # Module build, AdGuard CLI fetch and seed, issue copy helper
├── lint/                      # Local oxlint rules and the prompt-document scan
├── tests/                     # Vitest suites mirroring src/ and lab/
└── docs/                      # Guides, reference, explanation, module docs, examples
```

## Build And Test Commands

- **Install**: `pnpm install`; `pnpm exec playwright-core install firefox` once for Firefox runs.
- **Type-check**: `pnpm typecheck` — `tsc` over `src/`, `lab/` and `tests/` without emitting.
- **Build**: `pnpm build` — `tsc` with emit to `dist/` (nothing consumes it; the CLI and the action
  run sources through `tsx`).
- **Build the AdGuard CLI module**: `pnpm build:adguard-cli` — writes `adguard-cli/`.
- **Build the action image**: `docker build -f action.Dockerfile .`
- **Test**: `pnpm test` (Vitest). CI runs `pnpm vitest run` without
  `tests/browser/strict-route-proxy-contract.test.ts`, whose real browser launch fails on the CI
  runner.
- **End-to-end benchmark**: `pnpm test:e2e`, `pnpm benchmark:case:add`,
  `pnpm benchmark:verify-run` — real LLM calls; see `docs/guides/benchmark.md`.
- **Lint**: `pnpm lint` — oxlint plus `lint/scan-prompt-documents.mjs`.
- **Format**: `pnpm fmt` — oxfmt plus `eslint --fix` on `src/` and `lab/`; `pnpm fmt:check`
  checks without writing.
- **Run**: `pnpm start -- <command>` — the local CLI; `pnpm start --help` lists commands.

## Contribution Instructions

- You MUST verify your change with the type checker, the linter and the formatter.

  Use the following commands:
    - `pnpm typecheck` to check for type errors
    - `pnpm lint` to run the linter; `0 errors` is the success criterion
    - `pnpm fmt:check` to check formatting
    - `pnpm fmt` to fix formatting issues

- You MUST update the tests for changed code, following [Testing](#testing).

- You MUST run `pnpm test` and make it pass.

- You MUST add an entry under `[Unreleased]` in `CHANGELOG.md` for every change a user of the
  action or the CLI can notice, as part of the same change.

- You MUST update `README.md`, `DEVELOPMENT.md`, `REQUIREMENTS.md` and the affected pages under
  `docs/` when a change affects what they describe.

- When the project structure changes, you MUST update the Project Structure section of this file.

- If a prompt asks you to refactor or improve existing code, check whether the result can be
  phrased as a code guideline; if so, add it to the relevant Code Guidelines subsection of this
  file.

- Before committing, you MUST check the change against [Public repository
  hygiene](#public-repository-hygiene): every file merged to `master` is published.

- After completing the task, you MUST verify that the code you wrote follows the Code Guidelines in
  this file.

## Code Guidelines

### System Design

The project ships as a container GitHub Action and runs locally as a CLI tool.

- A run investigates one issue and exits; the backlog mode runs issues one after another. Nothing
  stays running between runs.
- The action's only write to a repository is the report comment and the screenshots it links. It
  never closes issues, never opens pull requests and never writes to the lists.
- `fix` exits 0 for any sealed cycle; the outcome lives in `cycle-result.json`'s own `status`
  field. A non-zero exit means an unsealed crash, the one case where a retry is the right response.
- Fail fast with a message that names the problem: a missing configuration variable fails with a
  `ConfigError` naming it before any browser or model work starts.
- `--verbose` adds debug-level logs on stderr; reports and evidence go to the output directory.
- `--no-sandbox` is opt-in through `NO_SANDBOX`; never detect CI to turn it on.
- The strict-route browser's `TMPDIR` stays a short flat `/tmp` directory, never the route root:
  Chromium crashes at startup when its socket path passes the 108-byte `sun_path` limit.
- Never rely on the page console: the stealth Chromium passes no page console message to the run.
  Read what a page reports from the page itself, and let each engine's `ConsoleCoverage` say what
  `get_console_log` can see.

### Architecture

- **Separation of Concerns** — one folder per concern (`src/types/`, `src/config/`, …).
- **Single Responsibility Principle** — keep a file under ~500 lines; when it grows past that, split
  it along responsibility seams. Existing oversized modules shrink progressively: split what you
  touch, do not grow it further.
- **Dependency Direction** — dependencies point from modes down to the runtime; see the flow below.
- **Explicit Boundaries** — no barrel files: do not create `index.ts` re-export entry points;
  import from the exact source file (`from '../types/issue-facts'`, not `from '../types'`).
- **Data Flow Clarity** — a run flows from the issue revision through environment selection and
  the three validation phases to one sealed result.
- **Minimize Coupling, Maximize Cohesion** — modes share session wiring through `src/session/` only.
- **Make Invalid States Impossible** — Valibot schemas at boundaries and typed value sets for every
  discriminant.
- **Observability Built-in** — see [Diagnostics and logging](#diagnostics-and-logging).
- **Keep It Boring** — the model decides; the code validates its answer and returns the reason when
  it refuses it.

Layers, from top to bottom:

```text
lab/ (local CLI, benchmark)        src/action/ (GitHub Action)
              ↓                              ↓
            src/entry/ (one issue run, backlog)
                          ↓
      src/orchestrator/ (fix mode: AgentRuntime, phases, verdict)
                          ↓
      src/session/ (mode-session wiring shared by the modes)
                          ↓
      src/pi/ (LLM runtime: provider, agent loop, single-shot)
```

- `src/pi/` holds the LLM runtime every mode runs on and nothing app-specific.
  `@earendil-works/pi-*` is imported only from `src/pi/`.
- `src/session/` holds what every prompt-driven mode shares; no mode folder reaches into another
  mode's folder for its session wiring.
- `src/environment/` holds the Host/model boundary contracts and the shared path-free vocabularies;
  `src/local/` holds the local Host implementations that consume them. A `src/environment` module
  must not import from `src/local`.
- `src/` is the action; `lab/` holds the development tools built on it (local CLI, benchmark,
  end-to-end cases). The dependency runs `lab/` → `src/` only: `src/` never imports `lab/`
  (enforced by the `local/no-lab-imports` oxlint rule).
- `src/adguard-cli/` is a separately pluggable executor; the action and the lab register it by
  importing it. The `adguard_cli` name MUST NOT appear in `src/` outside that folder (enforced by
  `local/no-adguard-cli-vocabulary`) — import its constants instead.
- Prompts live as Markdown in `src/prompts/documents/`: edit the Markdown, never build prompt prose
  in code. Every declared `{{camelCase}}` placeholder must be filled and every fill declared, or the
  render throws.
- A new tool is declared once in `ToolName` (`src/agent/tool-names.ts`) with its guidance in
  `src/agent/tool-catalog.ts`; the guidance map is total over `ToolName`, so a missing entry is a
  compile error.

[Runtime architecture](docs/explanation/runtime-architecture.md) explains the agent loop,
environment selection, input limits, local publication, the browser runtime and the contract of
each module.

### Code Quality

**JSDoc on declarations.** Every declaration carries a JSDoc block (`/** ... */`):

- **Classes** — a description of what the class represents.
- **Functions and methods** — a description, `@param` for each parameter and `@returns` for the
  return value. Type annotations in `@param`/`@returns` are not required (TypeScript owns the
  types); descriptions are mandatory. This applies to exported and module-private functions alike.
- **Interfaces** — a description of the interface.
- **Interface properties** — every property has a `/** ... */` comment describing its purpose,
  even when the name seems self-explanatory.

JSDoc comments use the multi-line format: `/**` on its own line, a `*` prefix on each content line,
`*/` on its own line. Single-line `/** text */` is forbidden (enforced by `local/jsdoc-multiline`).

```ts
/**
 * Configuration for connecting to an LLM provider.
 */
export interface LLMConfig {
    /**
     * The OpenAI-compatible API base URL.
     */
    baseUrl: string;
}
```

Exempt: exported `const` declarations such as Valibot schemas (their name documents them), test
files (`*.test.ts`) and constructors (`checkConstructors: false`).

**Style.**

- Indentation 4 spaces, single quotes, semicolons, trailing commas in multi-line constructs.
- Line width 100 characters (enforced by oxfmt, not oxlint).
- Import specifiers carry no file extension (`import { foo } from './module'`).

**Enumerations.** Declare a set of allowed values once as an `as const` object and derive its union
type from it. The object is PascalCase and shares its name with the type, and its members are
PascalCase too, exactly like a TypeScript `enum` — one import brings value and type, and call sites
read `RuleKind.Scriptlet`:

```ts
export const RuleKind = { Network: 'network', Scriptlet: 'scriptlet' } as const;
export type RuleKind = (typeof RuleKind)[keyof typeof RuleKind];
```

- Add a value array such as `export const RULE_KIND_VALUES = Object.values(RuleKind)` only when
  something reads it — a Valibot `picklist`, a listing; an array nobody reads is dead code.
- Comparisons, sets, `switch` cases and Valibot `picklist`s use the object's members, never raw
  string literals. In type position, do not write anonymous inline literal unions
  (`'a' | 'b' | 'other'`) in signatures, return types or interface properties — use the named type,
  or `typeof RuleKind.Scriptlet` for a single member.
- UPPER_CASE is for plain constants — value arrays such as `RULE_KIND_VALUES`, lookup tables, config
  records, allowlists — not for anything used as an enumeration.

**No magic values.** A literal that carries meaning gets a name; the enumeration rule above is one
case of this, and it applies to numbers, strings and regexes alike — a byte cap, a retry count, a
timeout, a marker, a sentinel path. Two questions decide it: would a reader have to look elsewhere
to know what this literal means, and would a second occurrence have to change with it? Either yes
means declare it once, next to what it constrains, with a JSDoc block saying why that value and not
another.

- A value belonging to a set that is already declared is never respelled as a literal — write
  `BrowserFallbackReason.HttpBlocked`, not `'http_blocked'`, everywhere including object keys
  (`[BrowserFallbackReason.HttpBlocked]:`) and type position
  (`typeof BrowserFallbackReason.HttpBlocked`).
- Exempt: a literal whose meaning is exhausted by the expression it sits in — `slice(0, 1)`,
  `length === 0`, `?? 0` — and a value fixed by an external contract quoted at its single use, such
  as an HTTP status compared once.

**Schemas.** Valibot for all validation; types derived with `v.InferOutput`.

**CLI.** The local CLI uses `commander`; `buildProgram(onCommand, opts)` is the factory that keeps
it testable.

**Static analysis.** `pnpm lint` (oxlint with JSDoc enforcement and the local rules in
`lint/local-rules.mjs`, plus the prompt-document scan) and `pnpm fmt:check` (oxfmt plus the ESLint
formatting rules) gate every change. Fix the code, not the configuration.

### Testing

Write few, durable, high-value tests — not tests for everything.

- Tests use Vitest and live under `tests/`, mirroring `src/` and `lab/`
  (`src/repo/search.ts` → `tests/repo/search.test.ts`); read-only fixtures sit beside the tests
  that use them.
- Write the failing test first, then the minimal implementation.
- **Test contracts, not implementation choices.** Assert observable behavior at a public or runtime
  boundary, validated against the real consumer's contract. Never pin incidental details — exact
  prose strings, formatting, internal ordering, private structure — that are free to change; a test
  that blesses current output without that check freezes bugs.
- **Behavioral tests only.** Do not read implementation files and assert on source text,
  formatting, file layout, command spelling, private symbols or internal structure — including
  substring or regex checks against Dockerfiles, GitHub Actions workflows, shell scripts and
  TypeScript source. Exercise the relevant command, parser, build, workflow validator or runtime in
  a focused integration or smoke test instead.
- **Never assert the contents of a config file.** A test that greps a workflow, Dockerfile or other
  configuration for a present or absent substring restates the file rather than exercising it.
  Intent a config must keep belongs in a comment in that file. Assert configuration only where a
  runtime consumer parses it and a real contract breaks.
- **Before writing a test, name the user-visible contract that breaks when it fails.** If you cannot
  name one, do not write the test.
- Prefer one integration-shaped test at a seam over many micro-tests restating the code, and keep
  one authoritative suite per contract.
- Unit tests never call live GitHub or an LLM provider: Octokit paths are mocked and configuration
  loaders take a fake environment. The pilot corpus test reads public commits and needs network
  access. The golden end-to-end cases call a real provider and run only through `pnpm test:e2e`.

### Dependency Management

- Use `pnpm` for every dependency and script command.
- `@earendil-works/pi-*` packages are pinned to one exact version and kept in step through
  `pnpm.overrides` in `package.json`.
- Prefer the standard library when it solves the problem; add a dependency only for significant
  value, from a well-established, actively maintained project.
- Minimize the dependency count; justify every addition.
- When adding a dependency, check the registry for the latest stable version instead of copying a
  version number from memory.

### Configuration & Documentation

- Runtime configuration comes from environment variables; `.env.example` is the inventory. The local
  CLI loads `.env` with dotenv; the action reads its inputs from `action.yml`
  (`docs/reference/action-inputs.md`).
- Configuration loaders are pure functions of an `env` argument (`loadCoreConfig(env)` in
  `src/config/config.ts`); `process.env` appears only as an entry point's or a loader's default
  argument, so tests pass a fake environment. A subprocess gets an environment built from an
  explicit list (`buildBrowserSubprocessEnvironment`, `HOME`/`PATH`/`LANG` for the AdGuard CLI),
  not the parent's.
- No default LLM provider and no secret in code: a missing variable fails with a `ConfigError` that
  names it.

### Other

#### Git workflow

- **One ticket per change.** Every change is tracked by its own `AG-<number>` ticket, and the
  branch, the commits and the PR name that ticket — not the umbrella ticket the work belongs to. A
  change without a ticket of its own gets one before it gets a branch; when you cannot create it,
  ask for it instead of reusing a neighbour's.
- **Branch names**: `<type>/<ticket>-<slug>`, with the types of the
  [Conventional Branch](https://conventionalbranch.org/) specification:
    - `feature` — new behavior; `fix` — a bug fix; `chore` — a change that does not alter the
      action's behavior: CI, lint, configuration, dependencies, documentation, agent rules;
      `release` — a release; `hotfix` — an urgent fix to a released version.
    - No other type exists: not `feat`, `enhance`, `ci` or `docs`.
    - The ticket is the key as the tracker writes it, upper case (`AG-12345`). This departs from
      the specification's lower case on purpose, so Jira links the branch to the ticket.
    - The slug is required and short: two to four kebab-case words saying what the change does —
      `chore/AG-12345-hygiene-check`, `feature/AG-12346-benchmark-any-provider`.
    - Nothing else goes in the name: no author initials (`mt/…`), and the ticket never replaces the
      type prefix (bare `AG-12345-…` slugs).
- **Commit and PR titles**: `AG-<number> <imperative sentence>` — the same ticket as the branch,
  then what the change does, no type prefix, no trailing period. PRs are squash-merged, so the PR
  title is the commit that lands on `master`.

#### Public repository hygiene

Everything merged to `master` is mirrored, history included, into the public
[AdguardTeam/FiltersAgent](https://github.com/AdguardTeam/FiltersAgent) repository. A file that
lands here is published.

You MUST NOT commit any of the following, in code, tests, fixtures, comments or documents:

- **Internal infrastructure.** No internal company hosts and no internal LLM gateway by name or URL.
  Use `example.com` / `example.org` in tests and read real endpoints from configuration.
- **Personal accounts and forks.** No personal GitHub accounts, forks or links to their issues.
  Use `example-owner/example-repo`, or the public upstream repository when the reference is real.
- **Tracker ids.** No ticket numbers in code, tests, test names or documents. The ticket goes in
  the branch, the commit and the PR title (see Git workflow) and nowhere else. Explain the behavior
  a test protects, not the ticket that added it.
- **Developer machine paths.** No macOS volume or home-directory paths. Build paths from
  `os.tmpdir()` or use a neutral `/tmp/...`.
- **Non-English text.** Documents and comments are English only. Test data may be in another
  language when the test exercises exactly that text — localized filter names, IDN domains, Unicode
  handling.
- **Secrets.** No real keys, tokens or credentials; tests use obviously fake values.

No check enforces these rules. Keep them when you write a file, and flag a violation you meet in
review.

#### Diagnostics and logging

Failures must be diagnosable from a single run.

- When a failure class can only report "unknown", add diagnostics first — not more guesses and not
  another blind rerun.
- Prefer rich structured context over opaque minimal codes: phase, finite classification, and safe
  upstream detail (for example tokens from pinned public catalogs).
- Redaction protects secrets (licence keys, credentials), not all native output. Tee full raw
  transcripts (subprocess stdout/stderr, browser and network errors) to a local git-ignored log for
  post-mortem diagnosis, with secrets redacted; public and serialized boundaries may stay code-only
  as long as a local log preserves the full picture.
- When in doubt, log it: an extra line costs nothing next to a run that has to be repeated to learn
  why it failed.
- Never swallow an error into a bare code. `catch { throw fail('foreground_failed') }` is forbidden:
  log the caught error — message, and stack or subprocess output where available — before mapping
  it to the typed code.
- A capability gate must exercise the capability, not its prerequisites. Checking that a binary's
  shared libraries resolve (`ldd`) proves nothing about ABI compatibility; start the thing and
  observe it work.
