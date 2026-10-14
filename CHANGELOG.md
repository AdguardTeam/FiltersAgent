# FiltersAgent Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog], and this project adheres to
[Semantic Versioning].

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
[Semantic Versioning]: https://semver.org/spec/v2.0.0.html

## [Unreleased]

### Added

- Initial release with four components:
    - GitHub Action — investigates a reported issue, or the repository's
      open-issue backlog, in a real browser with an ad blocker, verifies a
      candidate filter rule and posts the report as an issue comment.
    - `adguard-cli` setup action — plugs AdGuard CLI in as a filtering proxy,
      so desktop AdGuard reports are verified in the blocker they name.
    - Local CLI — investigates a single issue or an exported issue snapshot,
      exports snapshots, runs the backlog and searches the repository's rules.
    - Benchmark — replays fixed historical issues and compares the agent's
      rules with the maintainers' fixes.
- `--blocker-module <manifest>` of the local CLI's `fix issue` and `backlog`
  and of the benchmark: plugs in a blocker module by its manifest, the same way
  as the action's `blockerModules` input.

[Unreleased]: https://github.com/AdguardTeam/FiltersAgent/commits/master
