# FiltersAgent Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog], and this project adheres to
[Semantic Versioning].

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
[Semantic Versioning]: https://semver.org/spec/v2.0.0.html

## [Unreleased]

### Fixed

- Fixed a candidate that hides an anti-adblock modal but leaves the page
  unable to scroll being reported as verified: when the mouse wheel scrolls
  the unfiltered page and not the candidate page, the experiment fails the
  `page_scroll_preserved` check, and `apply_rule` returns `pageScroll` with
  the `html` and `body` styles that hold the lock in each phase.

## [1.1.0] - 2026-10-23

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
  from and let the review count blank space as layout instead of residue when
  a check names the element that holds it and shows it is not kept for the
  ad; geometry that is only the same before and after proves nothing.

### Changed

- Changed `LLM_VISION_MODEL` / `llmVisionModel` to be optional, defaulting
  to the effective reasoning model, including model overrides.
- Changed provider content refusals (`refusal`, `sensitive`,
  `content_filter`) and bodyless HTTP 400/404/413/422 errors to end the run
  as `llm_rejected`.
- Changed the vision image size cap to 5 MB for both APIs.
- Changed a forced run (`force`) that cannot investigate the issue, or fails
  during intake or investigation, to post a one-line notice with the link to
  the run instead of no comment: the page could not be accessed, or the report
  could not be processed. The notice is not the issue's report, so a retry
  and the backlog still investigate the issue.
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
- Changed the benchmark case set to 20 cases: added 15 historical cases and
  removed 8 whose site no longer answers, whose reported problem no longer
  appears, or whose reported state the benchmark cannot reach.
- Changed the candidate visual review to ask the baseline and candidate
  screenshots the same inventory question without naming which state they
  show, so the baseline inventory no longer reports the reporter's symptom on
  a capture that does not show it.
- Changed the candidate experiment to judge the candidate phase by the paired
  before/after review alone instead of a second single-image inventory, and
  added `failedCandidateChecks` to the `apply_rule` answer to name each runner
  check that kept a verified review from verifying the candidate.

### Removed

- Removed `--blocker-module` from `pnpm test:e2e`: every benchmark case is
  historical, and module filter lists cannot be pinned to the reporter's date.
- Removed the benchmark statuses `pass`, `agent_regression` and
  `environment_drift`, exit codes 1 and 2, and `e2e-result.json`: the
  benchmark exits 0 when every case has an agent outcome and 3 otherwise, and
  each case's outcome is in `benchmark-record.json`.

### Fixed

- Fixed raw JavaScript candidates (`#%#` without `//scriptlet`) never running
  in the AdGuard MV3 extension: every Chromium launch of a build with the
  `userScripts` permission now turns on Chrome's "Allow User Scripts", which
  Chrome ships off. A launch fails, naming the cause, when the extension's
  service worker does not start or three attempts of up to 10 seconds each
  leave the extension unable to call `chrome.userScripts`.
- Fixed a run crashing when its browser closed while the network guard was
  still checking a request: the process died on an unhandled `route.abort`
  rejection.
- Fixed a run exiting without a report while it waited out a pause the
  provider asked for, such as a 120-second `retry-after` on HTTP 522.
- Fixed an HTTP 429 rate limit, such as Anthropic's limit on concurrent
  requests, ending the run as `llm_error` after retries 2 and 4 seconds
  apart: a loop retry now waits 60 seconds and a second one 120, and a vision
  or intake call waits the same way after its quick transport retries, all
  within `LLM_REQUEST_MAX_ATTEMPTS`.
- Fixed visual reviews ending without a verdict when the vision model added
  a key of its own, such as `coverageObserved_note`, to a reply or to an
  object inside it; such a key is now ignored.
- Fixed visual reviews rejecting correct candidates for things the page shows
  without them: a flaw or a gap that the baseline capture shows unchanged no
  longer counts as damage or ad residue, and blank space where the ad was
  stops counting as residue once a DOM check names the element that holds it
  as page layout. Each such item is recorded in the review's `settlement`.
  In an ads review, a `not_resolved` answer with no remaining observation,
  residue with no AFTER observation, or, for a cosmetic rule, `regressed`
  with no listed flaw or named missing content now ends the review
  inconclusive after repair instead of rejecting the candidate.
- Fixed visual reviews rejecting correct candidates for ads seen only on the
  downscaled full-page overview: the overview now goes in front of every tile
  batch as a map that cannot be cited, each tile is labelled with its place,
  such as `TILE 2 of 5, y=1080–2160`, and only what a tile or the viewport
  shows counts. A page more than eight times taller than wide gets a map of
  the span its tiles cover instead of none. A review whose tiles cover only a
  window of the page now reports `tile window only` with the inspected range,
  and a clean window review now ends verified instead of inconclusive. The
  review answers for the window around the rule's targets, or for the first
  five screens of the page when there is none to measure, such as for a
  scriptlet; breakage below them goes unseen. A block of the reported site's
  own requests is reviewed over the first five screens and the window around
  its ad, without the screens between them. A window cut short by the tile
  limit still ends inconclusive, and the report says why. An overview past the 5 MB vision
  limit no longer blocks the review.
- Fixed two benchmark cases started at once on a fresh `--output-root`
  failing with `EEXIST` while creating the shared output directory.
- Fixed `###id` element-hiding rules being validated against the selector
  without its `#`, so the experiment never found the element the rule hides.
- Fixed `apply_rule` answering only `inconclusive` when a phase browser could
  not load the reported page; the answer now names the phase and the error,
  such as HTTP 403, and a candidate gets no third such experiment.
- Fixed `apply_rule` on a breakage report blaming the symptom description when
  the `adElementSelector` element stayed visible while the review saw the
  breakage; the answer now names the selector.
- Fixed the baseline and candidate phases being captured at different points
  of a page's lazy loading, which made a correct rule look like it emptied
  parts of a news feed.
- Fixed refused and failed `open_page` navigations and full-page screenshot
  failures missing from the run log.
- Fixed a model response that stops streaming after it opened ending the
  whole run as `request_deadline_exceeded`: the request is now retried within
  `LLM_REQUEST_MAX_ATTEMPTS`, and a run whose retries are spent ends as
  `llm_error`.
- Fixed incorrect-blocking experiments ending as `baseline_symptom_absent`
  when the named element still renders with the breakage inside it, such as
  an anti-adblock wall in a player iframe: a baseline or candidate phase that
  vision finds broken while the unfiltered page is not now counts as showing
  the symptom, so such a candidate also stays unverified even when the
  element renders again.
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
- Fixed the report's "Place in the list" quoting the neighbouring rule whole,
  which for a shared rule is a wall of domains with the selector at the end:
  it now links the file, and the line the rule goes before or extends, at the
  commit the run analyzed.
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
- Fixed the candidate visual review of a long page ending inconclusive after
  its final step saw only some of the observations it had to reconcile: it
  now sees every observation, or, when they cannot all fit, the review ends
  inconclusive without that step and names the context size and limit.
- Fixed a candidate being proposed as a verified patch when its vision review
  verified it but its controlled experiment did not: the `apply_rule` answer
  now leads with `environmentExperiment`, and `finish_fix` names the failed
  checks.
- Fixed a run keeping a verified patch when its recorded environment
  evidence could not back it: such a run now ends `failed` with
  `environment_unavailable` and no patch, and every other run keeps its
  status; `run-result.json` names the refused check in
  `environmentProjectionRefusal` and the trace records it.
- Fixed Firefox runs never carrying their environment execution in
  `run-result.json` once an experiment reached the candidate phase: a signed
  XPI reports no version, and the run now binds it that way.
- Fixed a cosmetic rule (hiding or CSS injection) whose selector matches
  nothing on the filtered baseline being verified on screenshots alone:
  `apply_rule` now ends such an experiment `baseline_symptom_absent`, names
  the selector in `unmatchedBaselineSelector`, and suggests `revealSteps` for
  an element that appears only after a click, a scroll or a key press.
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
- Fixed phases on pages that scroll smoothly (`scroll-behavior: smooth`, as in
  Bootstrap 5) losing their viewport screenshot, which left `apply_rule`
  inconclusive; the trace now records why a phase captured no viewport.

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

[Unreleased]: https://github.com/AdguardTeam/FiltersAgent/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/AdguardTeam/FiltersAgent/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/AdguardTeam/FiltersAgent/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/AdguardTeam/FiltersAgent/releases/tag/v1.0.0
