# Runtime architecture

How a run is structured: one model with tools, how it selects an environment,
how issue input is bounded, and how a local run publishes its output. The
contracts here bind every change to these parts of the code.

There is one product agent: the fix model hosted by `AgentRuntime`. The host
refreshes the bounded tool list before every model turn, executes the
requested browser, vision and repository operations, and returns their typed
results to the same model conversation. A runner or host is infrastructure
around that loop; it is not a second decision-making agent. The LLM runtime
lives in `src/pi/`, the mode-session wiring in `src/session/`, and the prompts
as Markdown documents in `src/prompts/documents/`; [AGENTS.md](../../AGENTS.md)
describes the module layout.

## Environment selection

The initial tool surface exposes issue data, host-owned capability
descriptors, and `select_environment`, but no environment-specific preparation
tools. The agent chooses `browser_extension`, `adguard_cli`, or
`unsupported_product_case`; labels, product fields, and issue prose are
signals, not a routing table. The first accepted choice is locked, a later
request is retained as a rejected switch, and a capability gap never falls
back to another environment. `update_observed_intent` may refine the
classification after new evidence without changing that lock.

Selection provenance has explicit ownership boundaries. Declared issue-form
types and reported product, OS and browser values come from parsed input;
observed intent and rationale come from the model; actual product, browser
and version come only from the selected adapter. Keep these fields separate in
new tools, results, and reports. A reported browser the run did not drive is
recorded as an approximation, never as an exact reproduction.

The extension route runs CloakBrowser's Chromium with the unpacked `chrome-mv3`
build in three phases: A without the extension, B with the published rulesets,
C with the same build and settings plus one candidate rule. A Firefox-family
blocker (uBlock Origin from a signed XPI) runs in Playwright Firefox through the
same three phases;
[Browser with an extension](../modules/browser-with-extension.md) describes
both engines. The host-owned execution recorder binds browser artifacts to
their phase. Missing
provenance, an unsupported candidate operation, or incomplete cleanup fails
closed and cannot produce a verified candidate.

## Issue revisions and limits

A live issue and an `export issue` bundle enter the same verified-revision
handler. Source-integrity digests bind the complete captured revision;
prompt and work digests bind the bounded model-visible input regardless of
where it came from, so live and exported input reject the same oversized
content. The limits are fixed: 24,000 body characters, 12 prompt-visible
comments, 8,000 characters per comment, 16,000 comment characters in
aggregate, a 256,000-character raw-history cap, 12 attachments and 48 MiB of
attachment bytes.

Fixtures exercise exact limits and one-over-limit values through the
injectable reader and downloader; unit tests never call live GitHub or a
provider.

## Append-only local publication

The verified-revision runner collects untrusted bytes privately below
`<output-root>/collections/<uuid>/raw/`, guarded by its collection ownership
marker. That path is not consumer-visible and must not appear in a report or
model-visible artifact. After redaction and integrity checks, publication
creates a new exclusive `<output-root>/runs/<uuid>/` generation. It never
overwrites or reuses an earlier generation.

A generation contains `.publication-owner`, `manifest.json`, the manifest-bound
run and evidence files, and finally `PUBLISHED`. The final marker contains the
SHA-256 digest of the exact manifest bytes and is the visibility boundary:

- `listVerifiedLocalPublications()` and other consumers expose only marked,
  fully verified direct children of `runs/`;
- an unmarked directory is an unpublished quarantine, even if some expected
  files are present;
- `published` means the complete sanitized generation is trustworthy. A bound
  candidate also has `candidate.patch`, `review-receipt.json`, and `review/`;
  a legitimate no-candidate disposition has none of those review artifacts;
- `evidence_only` preserves safe diagnostics for a candidate-binding or review
  materialization failure and must have no patch or review checkout;
- a redaction or residual-secret failure destroys the exact marker-owned raw
  collection and unpublished generation and retains only a fixed secret-free
  diagnostic outside them;
- another non-secret unsafe-artifact or trust-boundary failure leaves the
  reservation unmarked and must not be reported as either visible outcome.

`verifyLocalPublication(generationPath)` is the required inspection boundary.
It rechecks the single-link ownership marker, the `PUBLISHED` manifest digest,
all manifest artifact sizes and SHA-256 digests, and image records. Raw PNGs
without a Host-issued pixel-redaction proof are represented only as typed
omissions, with neither copied bytes nor a digest. A trusted capture is
decoded, pixel-redacted, stripped of metadata, deterministically re-encoded,
and bound to its normalization proof before publication.

For a bound candidate, verification also checks the detached depth-one
`review/` checkout without consulting the original source: HEAD stays at the
locked commit, the index is unchanged, no branch or remote is retained, and the
sole unstaged diff exactly matches `candidate.patch`. Human edits are allowed
for exploration, but they intentionally make later integrity verification fail;
copy or regenerate a proposal instead of treating an edited checkout as the
locked result.

Private collection bytes are deleted after the new normal or `evidence_only`
generation passes `verifyLocalPublication()`. A proven secret-taint failure
also destroys the exact owned collection and reservation. Other trust failures
retain the owned private collection and unmarked generation for explicit
secure handling; neither is exposed in ordinary reports or model output.
Subsequent cycles preserve both visible generations and quarantines.

Retention cleanup is a separate programmatic action and is never called by a
later cycle. Use `cleanupLocalPublication(generationPath)` with the exact
`runs/<uuid>` path for a completed generation; it verifies publication and
ownership before removal. Use
`cleanupUnpublishedLocalPublicationReservation(generationPath)` only for an
exact owned unmarked reservation after deciding its quarantined evidence can be
discarded. Both APIs reject roots, globs, symlinks, foreign directories, and
mismatched ownership, manifest, or visibility state. There is no cleanup CLI.

## Browser runtime

- `--no-sandbox` is opt-in through `NO_SANDBOX` (`parseBool(env.NO_SANDBOX, false)` in
  `src/config/config.ts`); there is no CI-based auto-detection. An action workflow that needs it
  sets `NO_SANDBOX` on the action step.
- The stealth binary passes no page console message and no uncaught page error to Playwright,
  not even through a raw CDP `Runtime.enable` subscription; `page.on('console')` sees only the
  browser's own entries (failed loads, `ERR_BLOCKED_BY_CLIENT`). Each engine declares this as
  its `ConsoleCoverage` (`src/browser/browser-interfaces.ts`), and `get_console_log` returns it
  beside the messages, so the guidance never names a browser. Anything reported only to the
  console must be read another way: a proxy blocker's page reports are read from the page itself
  (`src/blocker-contract/page-evidence.ts`).
- The strict-route browser's `TMPDIR` comes from `strict-route-temp-dir` (a short flat `/tmp`
  directory, never the route root): Chromium checks
  `$TMPDIR/org.chromium.Chromium.XXXXXX/SingletonSocket` against the 108-byte `sun_path` and
  crashes at startup when the path overflows it.

## Module contracts

- `src/browser/` — `IBrowserEngine`, `IBrowserSession`, `BrowserSession`, `browser-tools`,
  `har-redactor`. Chromium-family routes, an Edge or explicit-MV2 reporter's included, drive
  CloakBrowser (`cloakbrowser-engine.ts`); Firefox-family blockers drive Playwright Firefox
  (`firefox-engine.ts`). A named browser the run did not drive surfaces as the
  `FidelityLimitationCode.BrowserApproximation` conflict. Strict-route launches are diagnosed by
  `strict-route-diagnostics` (Chromium `--log-file`, browser-output tee, crashpad kept enabled) and
  `launch-resource-snapshot` (fd limit, `/dev/shm`, memory headroom per launch); a failed launch
  preserves the route root for the diagnostics artifact.
- `src/environment/environment-selection.ts` — `refreshFidelityLimitations()` compares the
  reporter's named product and browser against the context the run bound and records the typed
  `FidelityLimitationCode` conflicts; the prepared-extension bind names the browser it really drove.
- `src/environment/third-party-filter-catalog.ts` pins the registry's third-party filter IDs, so
  reporter settings that name filters absent from the installed build degrade onto the convergent
  subset with a classified conflict instead of a hard failure.
- `src/browser/adguard-filtering-log.ts` — the extension's own filtering log behind
  `get_applied_rules`. The pinned build records only while its `pages/filtering-log.html` is
  connected, and its `onOpenFilteringLogPage` message throws, so the host opens that page when a
  session launches and keeps it for the session — before the Baseline application, because the
  build keeps Chrome's declarative-match log only when that page is open while its engine is
  configured.
- List slices (`settings.slice` of `launch_browser`): `src/browser/extension-list-text.ts` reads a
  list's text from the build's own declarative ruleset (`metadata.filterContent`, byte-identical to
  the published list) and cuts a line range from it, checksum lines dropped;
  `src/local/loopback-text-server.ts` serves the slice on `127.0.0.1`;
  `src/browser/chrome-user-scripts-toggle.ts` flips Chromium's per-extension "Allow User Scripts"
  (Chromium 138+ exposes `chrome.userScripts` only behind it, and the pinned MV3 build runs no
  custom filter without that API); `src/orchestrator/list-slice-baseline.ts` runs the slice
  session's Baseline and `src/orchestrator/list-slice-launch.ts` refuses a bad slice before any
  launch. A slice session refuses `apply_rule`.
- `src/browser/page-state-probe.ts`, `src/browser/page-state-budget.ts` — the bounded
  `inspect_page_state` probe: sections are admitted round-robin against a byte ceiling so no
  section starves another. What it replaced is recorded in `REQUIREMENTS.md` §6.2.
- `src/pi/` — `runtime.ts` (registers both model roles on the configured API and supplies their
  handles), `session-runner.ts` (`runAgentSession`, the agent loop), `session-tools.ts` (tool
  adaptation, gate refusals, result truncation), `terminal-tool.ts` (the schema-validated tool a
  mode ends through; every other seal is an infrastructure ending), `single-shot.ts` (metered
  one-off completions) and `usage-collector.ts` (the run's Usage Summary).
- `src/session/` — `mode-session.ts` (render the three prompt documents, map configured bounds
  onto the pi runner, record turns and compactions into the trace, attach the usage summary),
  `registry-session-tools.ts` (adapt a `ToolRegistry` surface to a frozen pi session tool set) and
  `analysis-only-fallback.ts` (the zero-write outcome a mode continues with when its session sealed
  without an accepted terminal payload). The fix mode owns only what differs, in
  `orchestrator/fix-session.ts`.
- `src/prompts/documents/` — `system.md` (universal, byte-stable prefix), `tasks/<mode>.md`, and
  the fix-context and fix-targeting snippets. Fills are strict `{{camelCase}}` placeholders: every
  declared placeholder must be filled and every fill declared, or the render throws
  (`src/prompts/template.ts`); `prompt-documents.ts` is the name registry. Edit the Markdown, never
  build prompt prose in code.
- `src/agent/tool-names.ts`, `src/agent/tool-catalog.ts` — the one authority for tool names and
  their model-facing guidance. A tool name is declared once in `ToolName` and the guidance map is
  total over it, so a new tool or a typo is a compile error; `tool-factory.ts` and
  `tool-registry.ts` build the per-mode surfaces from them.
- `src/validator/` — `rule-applicator.ts` (pattern and selector extraction, rule-kind dispatch),
  `anti-adblock-check.ts` (anti-adblock wall detection through `evaluate_js`) and
  `phase-orchestrator.ts` (three-phase A/B/C validation returning `FactualValidationResult`); the
  `apply_rule` tool is registered in `src/agent/tool-factory.ts`.
- `src/analyzer/site-analyzer.ts` — `SiteAnalyzer`, the findings accumulator the `report_finding`
  tool fills; `src/types/site-analysis.ts` holds its Valibot schemas.
- `lab/e2e/repro-profile.ts` — `deriveReproProfile()` and `profileFallbacks()`, the golden browser
  oracle's profile fallbacks.
