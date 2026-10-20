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

Live runs load the pinned extension release. Historical lab runs assemble the
reporter's build from `extensionBuild`, with `historical_build` provenance
identifying its release code and autobuild filter lists.

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

On the extension route a run has one validation baseline. The environment is
built from the session whose `apply_rule` runs the first experiment, and every
later experiment replays that session's filter lists, Stealth Mode state and
browser profile. A call refused before the environment is built, such as an
edit the extension route cannot run, binds nothing. When the issue carries a
reporter settings import and the blocker takes settings at launch, only a
`reported_on_current` session with it can bind a verdict, so a call from any
other session is refused before the build and the locked baseline is always
one a verdict can come from. A Firefox-family blocker takes no settings, so
the import binds nothing there. A later session that differs from the locked
baseline gets a `validation_baseline_locked` refusal naming both baselines, so
a verdict is never read as one for a session it did not run in. The CLI route
has no such lock: its lists come from the activated CLI selection and its
browser profile from the latest session.

Pixels alone cannot tell whether blank space left after a candidate is ad
residue or the page's own layout, and two vision models can split on the same
captures. When the review rejects a candidate only for that residue, the agent
can send the same candidate again with DOM checks: read-only expressions held
to the `evaluate_js` rules, each with the claim it should prove. The runner
evaluates them in phases B and C on the page loads the screenshots come from,
records the bounded answers in the factual validation and the `apply_rule`
answer, and hands them to the review as untrusted page data. A check proves
layout only when it names the element that holds the space and shows the space
is not kept for the ad; blank space proved that way to be an empty transparent
grid track or the page's own margins counts as layout. Geometry that is merely
the same before and after proves nothing: hiding an ad that sits out of flow,
or whose slot was already empty, leaves exactly that, so where the baseline
showed the symptom such a check weighs nothing. An emptied container that still
paints a background or keeps a reserved height counts as residue; no check
outweighs visible advertising.
Code never interprets a check itself; how it acts on a check's answer is
described below with the settlement of the AFTER inventory. New checks make a new experiment of the
same candidate, which spends no candidate attempt but counts toward the three
runs one candidate gets in all, shared with retries after an inconclusive
review and with new reveal steps. Each check gets a few seconds on the page;
one that does not settle fails, and the phase skips the checks after it.

Every phase scrolls through the page and waits for its height to settle before
its reveal steps and captures, so the states the review compares were taken
after the same lazy loading rather than at whatever point a news feed had
reached. The reveal steps run after the scroll, so it cannot close a menu or an
overlay they opened. A page that never settles, such as an endless feed, is
captured anyway and the trace records why.

When a phase browser cannot load the reported page at all, the experiment stops
there and the `apply_rule` answer names the phase and the error. The environment
stays selected: the page stopped the phase, not the environment. The answer
follows who stopped it. A site refusal, such as HTTP 403, or a cause nothing
recorded separates may pass on one more experiment, and a rule whose
experiments fail to load the page twice gets no third. The runner's own
refusal, such as a redirect off the reported origin, closes the rule after one
experiment. When the unfiltered and baseline phases loaded and only the phase
with the candidate left the origin, the candidate most likely caused the
redirect, so the model is asked to change the rule; otherwise it is asked to
finish.

The review judges a candidate by what changed between the two states, so what
both states share does not count against it. The original-resolution tiles
span every element the candidate's selector matches, plus a viewport above
and below, so a rule that hides several slots is judged at each slot instead
of from the downscaled full-page overview. A span longer than one tile capture
can carry keeps its first rows, and the candidate state is tiled over the same
span as the baseline. A cookie banner or another overlay that both states show
unchanged, away from the reported problem, hides the same pixels in both and
leaves the comparison reliable; only one that changes between the states or
covers the problem makes the review inconclusive. In an ads review, blank
space the BEFORE state already records unchanged, such as an unloaded video
panel, is the page's own and not residue. Space where BEFORE showed the
reported problem is what the candidate had to clear, and nothing BEFORE
records outweighs visible advertising. An incorrect-blocking review has no
such rule: there an empty panel is the reported problem itself.

Each inventory request is blind to the state it looks at: the BEFORE and AFTER
images are asked the same question, and nothing in the prompt or the image
labels names the state; the code knows which images it sent and files the
answer. A request told that it looks at the page before the candidate answers
what that state is expected to show: one listed the reporter's advertising,
with the coordinates of the reporter's screenshot, on a filtered capture where
the candidate's selector matched nothing. Both states also list every visible
rendering flaw with its landmark, and the code marks each BEFORE flaw
`PRE-EXISTING:`, so the synthesis can still tell the page's own flaws from
damage the candidate causes.

That mark only helps when both passes call the same thing a flaw, and an
ordinary element nobody calls broken in BEFORE, such as the site's own footer
graphic, can come back from the AFTER pass as a broken image. Ordinary gaps
between sections read as reserved ad space the same way. So before the
synthesis the runner settles the AFTER inventory. Each AFTER flaw, and in an
ads review each AFTER instance the inventory marked as only blank space, is
shown beside the BEFORE images where its content can sit: for a tile, the
BEFORE tiles from the one at the same height down by the height the document
lost, since a hiding candidate only collapses space, or up by the height it
gained; for the viewport, the BEFORE viewport. A request that finds it
unchanged there and cites one of those BEFORE images takes it out of the
AFTER inventory; a pair of images too large for one request is not compared.
Blank space where BEFORE showed the symptom never leaves that way, since it
is what the candidate had to clear: the request may place it at a BEFORE
observation of the symptom, and the code itself refuses a match on a BEFORE
image where the inventory recorded blank space as the symptom. Blank space
left open goes to one narrow request with the agent's DOM checks: the check
must name the element that holds the space and show it is not kept for the ad.
The runner acts on a layout answer only when the cited check measured both
page loads and its expression queries the named element with a literal
selector, ID or class name, through `querySelector`, `getElementById` or a
similar call. This request is the only place a check can prove layout: the
synthesis sees the checks only as evidence of residue and never dismisses an
observation on one, so a layout answer the code refused leaves the space
counted.
Visible advertising, labels and frames are never set aside. The review
records everything it set aside, with its ground, under `settlement`. The
trace counts the attribution answers the code refused by reason, and lists
each answer of the DOM-check request with the reason it was refused.

The synthesis must back its summary with what it reconciled. In an ads review
an unresolved symptom needs an AFTER observation it kept as remaining, and
present residue needs an AFTER observation at all, which it may still
reconcile as not the symptom: that is the residue-only shape the agent hands
a maintainer. Residue of a third-party host block is exempt. In that review,
for a cosmetic candidate, a regressed page needs a flaw the AFTER inventory
still lists or non-target content the synthesis names as gone, such as an
article block an over-broad rule hid. A reply that breaks this is repaired
like any invalid reply, and the review stays inconclusive if repair fails;
the code never rewrites a field toward a passing verdict.

The final step of the review is a text-only synthesis: it never sees the
screenshots, only what the inventory requests reported about them, and it must
reconcile every numbered observation of both states. So it is either shown all
of them or not asked at all. Each request's symptom scope, damage and
rationale are sent once, inside that request's record. The context limit is
derived from the inventory's own bounds: the most observations a state may
hold and the most requests a state makes, each at its largest size, with the
request's damage left out because at its bound it would set the limit near a
million characters. When the full context passes the limit, every request
rationale is cut to a thousand characters, the one text that explains a batch
rather than reports what it saw. When even that does not fit, the review ends
inconclusive and names the size and the limit. The trace records the context
size, the limit, and whether the rationales were cut or the context refused,
since whether a review fits depends on how verbose the vision model is, which
would otherwise be invisible.

Phases A and B each get a single-image inventory, which decides whether the
baseline reproduces the symptom. Phase C gets none: the paired review judges
it. A lone after image has no before to compare and no DOM measurements, and
its own reading once outvoted a review that had reconciled every observation:
a downscaled overview it called too small to judge counted as the symptom
still present, so a correct rule ended inconclusive. The symptom presence and
capture coverage recorded for phase C now come from the review. A host block
the requests proved stopped, or a resolved symptom with nothing remaining, is
absent; an unresolved symptom or any remaining instance is present. A breakage
candidate whose probe measured the named element is still judged by that
element's geometry, unless the review sees the breakage while phase A's
inventory found the page clean, and a host block by its requests. On top of a
verified review the runner checks that phase C navigated cleanly, that the
symptom is gone, that the page stayed usable, and that the reveal steps
prepared phase C like the baseline. The experiment verifies the candidate only
when every check passes. When the review verified, the `apply_rule` answer
lists every failed check in `failedCandidateChecks`, so the agent learns why
the candidate still did not verify. Otherwise the list is empty: a review that
could not decide leaves the symptom and the page open, and naming those checks
would tell the agent the symptom stayed and the page broke.

Phase B has one check that outranks its inventory. When the report is not
incorrect blocking and the candidate is a cosmetic rule (hiding or CSS
injection), not an exception, the structural probe measures the rule's own
selector on the filtered baseline. If that measurement ran and matched no
element, the rule has nothing to hide or restyle, so phase B records the
symptom absent whatever the inventory saw, and the experiment ends `baseline_symptom_absent` without
phase C or the paired review. The inventory alone cannot settle this: one
read the reporter's advertising into a baseline where the selector matched
nothing, because the site rendered the block only after a click the reveal
steps never made, and the review then verified a rule that hid nothing. The
`apply_rule` answer names the selector under `unmatchedBaselineSelector` and,
even when reveal steps were passed, tells the agent to rehearse a click, a
scroll or a key press with `interact_page` and pass it as `revealSteps`. The
answer counts toward the same two baseline-absent experiments per candidate
and plan as any other. The gate stays out wherever an empty match proves
nothing: a measurement that did not run, such as an extended-CSS selector
(`:contains`) the page cannot query; a selector the page answers with an empty
list without failing, such as a pseudo-element (`::before`, `:after`) or a
legacy `[-ext-` attribute; and a baseline whose reveal steps did not
complete. The probe reads the top document only, so a rule whose element sits
in an iframe or a shadow root is reported as matching nothing even when it is
right; the answer states the fact, and the agent can reword the selector or
finish analysis-only.

The experiment's verdict, not the review's, is the one the run acts on. Every
`apply_rule` answer leads with it as `environmentExperiment`. When it refuses
a review that verified the candidate, the answer adds what phase C showed and
says that only new reveal steps or new DOM checks earn the same candidate
another experiment. The candidate ledger records that review as rejected, so
the same plan cannot run again in that session, and `finish_fix` refuses a
draft for it with the failed checks rather than sending the agent back to the
review. The candidate binding a draft needs to publish its patch is withheld
unless the experiment verified, so a verified review on its own can no longer
make a run propose a patch.

Because a proposed patch now implies a verified experiment, the canonical
environment execution recorded after cleanup must be able to back that
decision. When its projection into the run result refuses, the run decision
and the evidence disagree, which is a defect in the agent's own result
assembly rather than something a page or a model can cause. What the refusal
costs depends on what the run proposed. A verified patch whose evidence was
refused has lost its proof, so the run fails the way an incomplete cleanup
fails it: `failed` with `environment_unavailable`, no patch, verification
unavailable, and neither the candidate binding nor its verified screenshots.
Any other run proposed no verified patch and keeps its status, including a run
whose last experiment verified a candidate it did not propose and a run that
had already failed, which keeps its own reason. Every refusal is named in the
run result's `environmentProjectionRefusal` and recorded in the trace as an
`environment_projection` decision, beside the run status and the disposition
the projection was asked to back, so the defect can be found from the one run
that hit it.

The projection binds an extension experiment to the product version the run
context reports. A Chromium build reports the version its own manifest
records, read from the directory the browser loaded. A Firefox build is a
signed XPI that Firefox validates itself and the host never unpacks, so no
version is ever read: its phase proofs carry a `signed-xpi` marker and the run
context reports no version. For a Firefox-family build that marker binds an
absent version; before, every Firefox experiment that reached phase C was
refused and its canonical execution never reached the run result.

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
  list's text from the build's own declarative ruleset (`metadata.filterContent` in 5.5 or
  `metadata.rawFilterList` in 5.4, byte-identical to the published list) and cuts a line range from
  it, checksum lines dropped;
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
- `src/validator/` — `candidate-selector.ts` (the selector a candidate's evidence is bound to),
  `anti-adblock-check.ts` (anti-adblock wall detection through `evaluate_js`) and
  `phase-orchestrator.ts` (the A/B/C experiment over blocker-established filtering states),
  `phase-capture.ts` (the capture of one phase) and `structural-snapshot.ts` (the target and
  landmark structure probe); the blocker, never the validator, applies the rules. The
  `apply_rule` tool is registered in `src/agent/tool-factory.ts`.
- `src/analyzer/site-analyzer.ts` — `SiteAnalyzer`, the findings accumulator the `report_finding`
  tool fills; `src/types/site-analysis.ts` holds its Valibot schemas.
