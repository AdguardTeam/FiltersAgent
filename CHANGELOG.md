# FiltersAgent Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog], and this project adheres to
[Semantic Versioning].

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
[Semantic Versioning]: https://semver.org/spec/v2.0.0.html

## [Unreleased]

### Fixed

- Fixed the AdGuard CLI environment stopping rule verification for the rest of
  the run after one edit or removal named a line the published filter lists do
  not carry; that call is now refused with a hint to validate an added rule,
  and later candidates still run.
- Fixed `apply_rule` accepting a candidate rule or an edited line that spans
  several lines; such a call is now refused before any browser phase runs.
- Fixed the AdGuard CLI route leaving an edited filter list in effect when its
  first restore failed and cleanup retried it.
- Fixed fix runs on Claude models, which failed on the first request because
  the `finish_fix` tool schema had `anyOf` at the top level.

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

[Unreleased]: https://github.com/AdguardTeam/FiltersAgent/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/AdguardTeam/FiltersAgent/releases/tag/v1.0.0
