# FiltersAgent Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog], and this project adheres to
[Semantic Versioning].

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
[Semantic Versioning]: https://semver.org/spec/v2.0.0.html

## [Unreleased]

### Added

- Added `LLM_API` / `llmApi` with `anthropic-messages` to run Claude with
  your own Anthropic key, prompt caching and thinking. Its base URL has no
  `/v1`; a URL ending in `/v1` fails at startup.
- Added `pnpm benchmark:case:check` to check or migrate historical cases.

### Changed

- Changed `LLM_VISION_MODEL` / `llmVisionModel` to be optional, defaulting
  to the effective reasoning model, including model overrides.
- Changed provider content refusals (`refusal`, `sensitive`,
  `content_filter`) and bodyless HTTP 400/404/413/422 errors to end the run
  as `llm_rejected`.
- Changed the vision image size cap to 5 MB for both APIs.
- Changed benchmark scoring to classify missing extension provenance and
  reporter-build version mismatches as infrastructure failures rather than
  agent regressions.
- Changed historical case checks to ignore rules already present in the
  base checkout and warn when removed rules are absent from the build.

### Fixed

- Fixed the usage summary leaving out single-shot attempts that failed and
  were retried.
- Fixed historical benchmark and local historical `fix` runs using current
  lists instead of reporter builds pinned in `run.json` v3.
- Fixed historical runs accepting `--blocker-module` when module lists
  cannot be pinned to the reporter's date.
- Fixed historical investigations accessing later AdguardFilters commits
  or retaining unrelated redirect origins.
- Fixed browser request checks missing popups and other pages in the same
  browser context.
- Fixed redirects staying permitted after a page load returns an HTTP
  error.

## [1.0.1] - 2026-10-15

### Fixed

- AdGuard CLI route: a failed edit of a line missing from the published lists
  no longer disables the environment for the rest of the run.
- AdGuard CLI route: an edited list is restored when the first restore fails.
- `apply_rule` rejects multi-line rules.
- Claude models: runs no longer fail on the first request.

## [1.0.0] - 2026-10-14

### Added

- Initial release with four components:
    - GitHub Action — investigates a reported issue, or the repository's
      open-issue backlog, in a real browser with an ad blocker, verifies a
      candidate filter rule and posts the report as an issue comment.
    - `adguard-cli` setup action — plugs AdGuard CLI in as a filtering proxy,
      so desktop AdGuard reports are verified in the blocker they name.
    - Local CLI — investigates a single issue or an exported issue snapshot,
      exports snapshots, runs the backlog and searches the repository's rules.
      `--blocker-module <manifest>` plugs in a blocker module the same way as
      the action's `blockerModules` input.
    - Benchmark — replays fixed historical issues and compares the agent's
      rules with the maintainers' fixes.

[Unreleased]: https://github.com/AdguardTeam/FiltersAgent/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/AdguardTeam/FiltersAgent/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/AdguardTeam/FiltersAgent/releases/tag/v1.0.0
