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
- Added benchmark flags `--output-root` and `--knowledge-base-sha` to retain
  comparable model runs.
- Added per-case `benchmark-record.json` results and
  `pnpm benchmark:summarize` for model comparisons and CSV export,
  including intake skips and mixed-pin warnings.
- Added a free reachability check of each benchmark case's site before the
  agent starts; a site that does not answer ends the case as
  `site_unreachable` without spending a model.
- Added `domChecks` to `apply_rule`: after a review rejects a candidate only
  for ad layout residue, the agent can send it again with read-only DOM
  checks, which run on the baseline and candidate pages the screenshots come
  from and let the review count blank space the page's own layout leaves as
  layout instead of residue.

### Changed

- Changed `LLM_VISION_MODEL` / `llmVisionModel` to be optional, defaulting
  to the effective reasoning model, including model overrides.
- Changed provider content refusals (`refusal`, `sensitive`,
  `content_filter`) and bodyless HTTP 400/404/413/422 errors to end the run
  as `llm_rejected`.
- Changed the vision image size cap to 5 MB for both APIs.
- Changed benchmark scoring to read each case's outcome from the agent's own
  result (`verified`, `proposed`, `reproduced`, `not_reproduced`) and record
  the maintainer's rule beside it, instead of re-checking the maintainer's
  fix in a browser.
- Changed historical case checks to ignore rules already present in the
  base checkout and warn when removed rules are absent from the build.
- Changed the CLI and benchmark to default `CLOAKBROWSER_AUTO_UPDATE` to
  `false`, preserving explicit values.
- Changed benchmark runs to show the agent each issue as open, without `A:`
  labels or an assignee, and to refuse a case whose checkout loads a
  repository instruction.
- Changed analysis-only runs on any report but incorrect blocking to carry
  a rule the visual review rejected only for ad layout residue, with the page
  intact and undamaged, as the candidate for review instead of dropping it.
- Changed `apply_rule` to tell the agent how many candidate attempts the run
  has left, so it tries further rules instead of stopping early.
- Changed the AdGuard CLI module to install the stable AdGuard CLI 1.4.13
  instead of 1.5.0-rc.1, and to refuse a pre-release `releaseUrl`. Seed the
  CLI home again after upgrading.

### Removed

- Removed `--blocker-module` from `pnpm test:e2e`: every benchmark case is
  historical, and module filter lists cannot be pinned to the reporter's date.
- Removed the benchmark statuses `pass`, `agent_regression` and
  `environment_drift`, exit codes 1 and 2, and `e2e-result.json`: the
  benchmark exits 0 when every case has an agent outcome and 3 otherwise, and
  each case's outcome is in `benchmark-record.json`.

### Fixed

- Fixed a model response that stops streaming after it opened ending the
  whole run as `request_deadline_exceeded`: the request is now retried within
  `LLM_REQUEST_MAX_ATTEMPTS`, and a run whose retries are spent ends as
  `llm_error`.
- Fixed benchmark failures before the filters checkout being reported as a
  filters-base mismatch instead of the original error.
- Fixed benchmark cases ending as infrastructure failures, and
  `pnpm benchmark:case:add` rejecting issues, when the reporter's settings
  import link carries `&amp;` separators.
- Fixed sites that redirect within themselves (`www.example.com` to
  `example.com`, `http` to `https`): `interact_page` no longer reports
  `external_destination` for steps that stay on the site, and a verified
  candidate is no longer refused because its phases landed on the redirected
  address. `open_page` now treats a redirect to a sibling host
  (`shop.example.com`) or another tenant of a shared host (`a.github.io` to
  `b.github.io`) as another site, and the agent opens the landing page in a
  new session.
- Fixed `launch_browser` refusing the reported page when the issue writes its
  URL with `&amp;` separators, and binding the session to a copy with broken
  query parameters instead.
- Fixed intake errors reporting provider rejections as generic extraction
  failures.
- Fixed provider tuning validation errors omitting the environment variable
  names.
- Fixed CSS injection (`#$#`) candidates getting no structural facts in
  `apply_rule`: the probe now measures the rule's selector without its style
  block.
- Fixed browser-verified CSS injection (`#$#`, `#$?#`) rules being reported
  as unverified candidates instead of proposed patches.
- Fixed full-page visual review on Claude vision models: screenshots longer
  than 8000 px are now scaled to the provider's image limits instead of being
  rejected, and a provider rejection of a vision request is reported as a
  rejection.
- Fixed GIF and WebP reporter screenshots being sent to the vision model
  labelled as PNG.
- Fixed the usage summary leaving out single-shot attempts that failed and
  were retried.
- Fixed historical benchmark and local historical `fix` runs using current
  lists instead of reporter builds pinned in `run.json` v3.
- Fixed local historical `fix` runs accepting `--blocker-module` when module
  lists cannot be pinned to the reporter's date.
- Fixed historical investigations accessing later AdguardFilters commits
  or retaining unrelated redirect origins.
- Fixed browser request checks missing popups and other pages in the same
  browser context.
- Fixed redirects staying permitted after a page load returns an HTTP
  error.
- Fixed benchmark cases ending as `not_reproduced` when the agent saw the
  reported problem with the prepared blocker but verified no rule: the
  unfiltered session and the candidate phase no longer decide reproduction.
- Fixed `apply_rule` running a session's experiment on the filter lists,
  Stealth Mode state and browser profile of the session that ran the first
  experiment, while reporting the verdict as this session's: such a call is
  now refused with both baselines named. A call refused before its
  experiment locks nothing, and on an issue with a reporter settings import
  only the `reported_on_current` session runs experiments.
- Fixed Firefox-family runs never verifying a rule when the issue carries an
  AdGuard settings import: the blocker takes no settings, so the import no
  longer binds its verdicts.
- Fixed report comments cutting the reproduced symptom, the policy rationale
  and long rules mid-word: text up to 2,000 characters now renders whole,
  longer text ends at a sentence and says it was shortened, and rules are
  never shortened.
- Fixed report comments showing HTML entities such as `&#39;` and `&#35;` in
  their Markdown, and several blank lines under the outcome line.
- Fixed report comments turning `x_www.host` and `_GH-13_` in the agent's
  text into a live link and an issue reference, and text starting with `~~~`
  into a code block that swallowed the rest of the comment.
- Fixed the report's "Policy rationale" showing the agent's reasoning instead
  of the policy decision's reasons; a run without a policy decision has no
  such section.
- Fixed the outcome line of a run the filter policy decided reading
  "Analysis-only findings, no verified change": it now names the policy
  verdict.
- Fixed runs ending as rejected after the `defaults_plus_required`
  comparison closed an unfinished reporter-profile session: `finish_fix` now
  asks to relaunch that profile instead of capturing in the closed session.
- Fixed analysis-only results reporting the settings of the last
  `defaults_plus_required` comparison instead of the reporter-profile
  session, which the benchmark counted as `agent_mismatch`.
- Fixed the AdGuard CLI route tunneling sites unfiltered when their
  certificate chain ends at a root with SCT constraints, such as USERTrust RSA
  or GlobalSign Root R3.
- Fixed the candidate visual review of a rule that hides several slots
  seeing only the first one at original resolution: the screenshot tiles now
  span every element the rule's selector matches, and a span longer than one
  capture can carry keeps its first rows instead of losing every tile. On a
  long page such a review can take up to 48 tiles per state.
- Fixed the candidate visual review ending inconclusive over a cookie or
  consent banner left unchanged in both states; only an obstruction that
  changes between the states or covers the reported problem still does.
- Fixed the candidate visual review counting blank space the page already
  had without the candidate, such as unloaded video panels, as ad layout
  residue.
- Fixed the AdGuard CLI route reporting a ready environment while it decrypted
  no HTTPS: preparation now sends an HTTPS request to the issue's site through
  the CLI, and a run whose request does not go through the filter ends
  capability-limited with `https_filtering_unproven`.
- Fixed `apply_rule` never giving a verdict on pages too tall for one
  full-page screenshot, about 17,500 px and taller in Chromium: the
  original-resolution tiles now prove such a page, the trace records the
  browser's error for the missing screenshot, and a full-page screenshot over
  the 5 MB vision limit on such a page no longer blocks the review.
- Fixed `inspect_full_page_capture` refusing a complete tile capture as
  incomplete when the browser could not take the full-page screenshot.
- Fixed a repeated `apply_rule` after a filtering environment failure reading
  like a new failure: the answer now says it repeats the earlier failure and
  ran no experiment.

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
