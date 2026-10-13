# Browser with an extension

The module launches a real browser with an ad-blocker extension forced into it, and hands the
session to the agent's page tools. One interface, two extension channels, one per browser family:
Chromium-family engines load an unpacked extension directory (`adguardExtensionPath`), Firefox
loads a signed XPI through enterprise policies (`firefoxPolicies`). Each family's channel is a
compile-level pairing: an engine asked for a channel it cannot honor rejects the launch loudly
instead of dropping the configuration.

## Interface

- **Input**: a browser engine (`IBrowserEngine`), the extension install payload, and the
  extension's policies.
    - Firefox: signed XPI path (absolute, `file://` URL is built by `buildFirefoxPolicies`) and
      enterprise policies carrying `ExtensionSettings` plus `3rdparty.Extensions` managed storage.
    - Chromium: unpacked extension directory path (`adguardExtensionPath`).
- **Output**: a `BrowserSession` whose page tools — `get_dom`, `screenshot`, `inspect_page_state`,
  `evaluate_js`, `get_console_log`, `stabilize_page` — work on top of either family.
  `get_console_log` alone differs in what it returns, and says so in its `consoleCoverage`: Firefox
  delivers the page's own console output, while the stealth Chromium binary passes only the
  browser's own log entries (failed loads, `ERR_BLOCKED_BY_CLIENT`, browser warnings) and no page
  console API output or page error.

### Failure modes

- **The browser did not start.** The launch path raises `BrowserLaunchError` before any tool is
  reachable. Callers escalate to analysis-only output; nothing extension-specific is diagnosable
  past this point.
- **The extension did not load.** The session is up, but the expected extension behavior is
  absent — the reporting page loads its ordinary content with no filtering. There is no
  extension-settings API reachable from the harness (see Firefox limitations below), so the proof
  of load is behavioral: a page fixture with a known third-party request and a policy that filters
  it. uBO engages on its own schedule — a fresh force-install can take 30–45 s to start blocking,
  and it can also block on the first navigation — so poll for the block; assume neither an
  instant nor a fixed warm-up.

## Install mechanism for Firefox

**Playwright policies.** The patched Playwright Firefox build reads a custom `policies.json`
pointed at by the `PLAYWRIGHT_FIREFOX_POLICIES_JSON` environment variable (absolute path;
Playwright ≥ 1.53). The policies force-install the signed XPI (`ExtensionSettings` →
`installation_mode: force_installed`, `install_url: file://…xpi`) and feed managed storage through
the same file's `3rdparty.Extensions` block. `FirefoxEngine` stages the file into the profile
directory and merges the environment variable into the launch; `BrowserSession.create` accepts the
policies on `firefoxPolicies` and drives the persistent context for them.

Puppeteer with WebDriver BiDi and `webExtension.install` installs the same signed uBO XPI just as
well, and its installs persist across restarts, but it does not fit the architecture: BiDi needs a
second driver and a second browser channel, replaces none of the Playwright page tools, and exposes
no engine-neutral seams. playwright-core cannot drive a vanilla Firefox binary, and the patched
build cannot be driven by WebDriver BiDi alone, so the policies file is the one install channel.

## uBlock Origin managed storage

Extension ID: `uBlock0@raymondhill.net` (uBO's published Firefox ID). uBO reads `adminSettings`
from `browser.storage.managed`; filters arrive as a `userFilters` string of filter lines, and
`selectedFilterLists` containing `user-filters` applies them (uBlock-issues#3685). Subscribing only
`user-filters` also keeps a fresh install from downloading real filter lists.

```json
{
    "policies": {
        "ExtensionSettings": {
            "uBlock0@raymondhill.net": {
                "installation_mode": "force_installed",
                "install_url": "file:///abs/path/ublock-origin.firefox.signed.xpi"
            }
        },
        "3rdparty": {
            "Extensions": {
                "uBlock0@raymondhill.net": {
                    "adminSettings": {
                        "userFilters": "||ads.example^",
                        "selectedFilterLists": ["user-filters"]
                    }
                }
            }
        }
    }
}
```

The policies file is built by `buildFirefoxPolicies({ extensionId, xpiPath, managedStorage })` —
the managed storage passes through verbatim, so the uBO shape above is the caller's data. The
result is handed to `BrowserSession.create` as `firefoxPolicies`; the run instruction owns the
managed-storage document, and the host places the declared user-filters file's content into it at
the key path the instruction named (`buildManagedStorageWithUserFilters`).

## Proving the block: the network-log seam vs the DOM

Observed on Firefox with uBO active:

- A request blocked by uBO fires Playwright's `requestfailed` with failure error text
  `NS_ERROR_ABORT`; `BrowserSession` records it in `getNetworkLog()` with `statusCode: 0`.
- The DOM corroborates: a blocked image never decodes, so `img.naturalWidth === 0` — observable
  through `evaluate_js`.

Neither signal alone attributes a block, and two traps make a fixture prove nothing:

- **uBO exempts loopback hosts from blocking by design.** A fixture serving its "ad" from the
  loopback server (any port) can never produce a blocking signal.
- **An unresolvable host imitates a block.** `ads.example` does not resolve, so without uBO the
  same request would still land as `statusCode 0` with `naturalWidth === 0` — from a DNS failure
  (`NS_ERROR_UNKNOWN_HOST`), not a cancel.

The discriminating signal is the failure error text: extension cancel is `NS_ERROR_ABORT`, DNS
failure is `NS_ERROR_UNKNOWN_HOST`. A block proof checks both the network-log entry and the
error text; the DOM proof travels with them.

## Evidence design: what the host verifies itself

Between an A/B/C phase opening and its observation, the candidate is applied (or the baseline
plugged back in) by following an application contract's steps. On the built-in AdGuard route those
steps are a fixed message protocol and the host performs them itself in code; an instruction that
writes its own `## Rule application` is performed by a bounded model session instead. Either way
trust ends at the last step, and two rules govern what the recorded proof may claim.

**The host reads the blocker state back itself.** After those steps the host opens the state at
the instruction's declared read and credits the phase only on exact match:

- **candidate (phase C)**: the user-rule content, newline-joined, hashes to exactly the
  candidate's sha256 (`candidateDigest`) — one extra user rule is a different state;
- **baseline (phase B and the prepared launch)**: the enabled filter list set equals the prepared
  set exactly, and user rules stay empty;
- a `user-rules-file` or `managed-storage-file` read verifies the file at the declared path by
  content hash. Neither method can observe the enabled filter set, so phase B is credited on empty
  user rules and phase C on the exact content alone, and the application detail records what could
  not be observed. What the proof then reports as the enabled set depends on whether the executing
  blocker declared one: the Chromium route leaves it `null` — rendered as not observed, never an
  empty list — while the Firefox family reports the selection its instruction declared and the
  browser applied at startup (see below).

**Which verification methods run.** `extension-state` runs on the Chromium route: the host
queries the running AdGuard extension over its own message transport, and on the built-in route it
performs the application over that same transport — readiness, `applySettingsJson`, the bounded
three-round `disableFilter` reconciliation of the enabled set, and `saveUserRules` for a candidate.
Of the file-backed methods
exactly one pairing runs — `managed-storage-file` beside a `launch: firefox` declaration in the
instruction's `## Preparation` section — and the host performs that application itself, because no
model session can: preparation writes only inside its own workdir and never learns where the run's
host-state directory is, and the application session carries page tools only. For that pairing the
host writes the declared file (empty for the baseline goal, exactly the candidate line for the
candidate goal), rebuilds the enterprise policies with the file's exact content at the declared key
path, relaunches the browser — Firefox reads `policies.json` only at startup, so a running browser
can never pick up new managed storage — and reads the file back through the file reader. The phase
proof's detail names the file and the relaunch beside what the credit could not observe.

**That file is host state, not repository content.** A declared relative target resolves against the
run's host-state root — a fresh per-run directory the runtime creates under the OS temp root
(`src/orchestrator/host-state-root.ts`), removed on the run's terminal path — and both places that
need the path, the between-phases application and every launch, resolve it there through
`src/orchestrator/blocker-file-target.ts`, so a launch can never serve a different file than the
read-back credits. A relative target that escapes that root is the typed
`ApplicationInstructionGap.VerificationTargetOutsideHostState` refusal, taken before the file is
read; an absolute target is honored as written, as part of the instruction's trusted content. The
directory lies outside the checkout by construction, which is what keeps the checkout walks honest:
a target inside the checkout would make the safety gate's duplicate scan reject a verified
candidate as one that "already exists in the checkout", and would move the verdict's recomputed
hostname baseline away from the hash the apply-time context recorded.

Everything else file-backed still refuses before any paid work: `user-rules-file` names a file whose
content only a Chromium blocker's own storage would carry (the uBlock Origin Lite example), and a
`managed-storage-file` without a Firefox launch declaration names no policies to rebuild. Rather
than discover that late, after paying for a whole investigation, such a run refuses immediately —
before the repository checkout, the issue fetch, or any LLM call — naming the declared method, what
a runnable declaration would have to say, and
`InfrastructureFailureReason.FileBackedApplicationUnsupported`. The uBlock Origin example runs
through A, B and C; the uBlock Origin Lite example always refuses; the built-in and Edge MV2
instructions declare `extension-state`, which this limitation does not touch.

**A Firefox run's launch family travels on the prepared extension.** `PreparedExtension.launch` is
either the Chromium family (the unpacked directory and its manifest generation) or the Firefox
family (the extension id, the signed XPI, the managed-storage document and the key path inside it
that must hold the user filters). The preparation session declares the Firefox family in its
terminal payload — it never writes a policies file — and every launch of the run takes its engine,
its user-agent family and its extension channel from that descriptor
(`src/browser/prepared-extension-launch.ts`), rebuilding the policies from the declaration plus the
file's content at that moment.

## What a uBlock Origin run in Firefox does

One executor name (`browser_extension`), one adapter per launch family. A Firefox-family run never
touches the AdGuard route's pieces — there is no unpacked root to lock, no bundled filter catalog to
converge against and no `moz-extension://` page to drive — so it takes its own three seams:

- **Its baseline is the instruction's list selection, not AdGuard's catalog.**
  `src/environment/declared-filter-baseline.ts` reads the `selectedFilterLists` sitting beside the
  declared user-filters key in the managed-storage document, unions in `user-filters` (without it
  uBO applies no user rule at all), and reports them as `declared:<list>` keys. The environment
  selection takes that decision instead of resolving the reported names — a uBO report names uBO's
  own lists, which the official AdGuard catalog can never resolve — and the reporter's names are
  compared against the selection for the report only: a covered name is silent, an uncovered one is
  recorded, a subscription URL is a skipped source. Nothing refuses.
- **Its launch baseline is the declaration itself.** `launchExtensionBaseline` credits a
  Firefox-family session through `src/orchestrator/firefox-launch-baseline.ts`: the browser applied
  the policies when it force-installed the XPI, which is what readiness means here, so the launch
  reports `settingsVerified` with the exact `settingsEnabledLists` it ran with and says plainly that
  the blocker exposes no host-readable live state. `sessionBaselineCredited` is the one predicate
  every gate reads, so a session credited through either channel — the AdGuard read-back or this
  declaration — may reach the filtering environment, and neither family is credited by the other's
  evidence.
- **Its phases come from `src/environment/firefox-extension-environment.ts`.** Preparation locks the
  declared selection as the executable baseline with no resources and every list named
  `unattributedListKeys` (no list file is ever opened, so nothing is claimed byte-proven). Phase A
  launches the same Firefox build with no extension; B and C force-install the XPI and hand the
  session to the host-side file application above. The phase proof records that read-back and adds
  one thing: the enabled set is the declared selection, because a file read-back cannot observe it
  and the declaration is what the browser applied. `packageVersion` and `manifestVersion` are the
  `signed-xpi` marker — Firefox validates the archive itself and the host never unpacks it — and the
  identity is in the proof's execution context (`uBlock0@raymondhill.net`, Playwright Firefox) and
  the prepared-build provenance beside it. The run report names the same things: the blocker's id,
  its XPI, and the declared list selection, never "AdGuard" or `Chromium + MV3 only`.

**Placement works on the repository's own layout.** `generatePlacementMap` keys every `.txt` list
file by its checkout-relative path in either layout; what the checkout's shape decides is how those
files group into filters. A directory holding more than one list file directly at the top level is a
container of independent lists — a uAssets-style `filters/*.txt` — so each file is its own list; one
directory per filter, as AdguardFilters ships it (`BaseFilter/filter.txt`,
`BaseFilter/sections/*.txt`), keeps naming its whole subtree after the directory. Without that
split a uAssets checkout would collapse into one filter with one section index: one placement
target, no alternatives, and no cross-list selector classification.

Which of those lists a rule goes into is the agent's choice: its draft names the file, by the
repository path `search_rules` reports for every match, and `finish_fix` only checks that the rule
can be inserted there (`candidate-placement-check.ts`) — the file is one of the map's own lists, it
exists, and it is the declared one when the run instruction declares a placement for the rule's
kind — returning the reason otherwise. Code never picks another file: a file chosen by heuristics
can be a list that is not a rule list at all, such as a file of bare dead domains at the repository
root. The position inside the chosen file is the sorted one when that file's own order proves it
sorted (`sorted-insertion.ts`), and otherwise the domain block, terminal section, or end of file.

**The AdGuard extension is driven by its built-in instruction.** How to apply settings and rules
to it lives in `src/prompts/documents/instructions/adguard-extension.md`, which a run without its
own instruction reads through the prompt-document loader; no code path drives the extension's
options page. The instruction's steps run through the application session's one declared write
tool, `send_extension_message`: it sends a runtime message from the prepared blocker surface page
only — any other page refuses — and returns the background response, so `evaluate_js` on that
privileged surface stays read-only and the host-assembled action log records every message. The
host builds the settings payload from the prepared expectation (the enabled official filters) and
the task hands it over as a fill. The host read-back above covers the AdGuard extension too: the
built-in instruction declares `read: extension-state user-rules`, so the host queries the running
extension's own options data, user rules, and limit counters over its message transport.

Three properties of the recorded evidence follow:

- **The action log is host-assembled** from the application session's recorded tool calls. It is
  evidence of what was done, never that it was done — the model's self-report of its own steps
  never enters the proof.
- **A missing instruction section is a recorded refusal, never a guess.** An instruction with no
  rule-application section (`no-application-method`) or no state-verification section
  (`no-verification-method`) refuses before any model turn and the gap lands in the run's
  limitation record; a method the declaration names but the executor cannot read refuses the same
  way.
- **The phase credit is exact.** A near miss — one added user rule, one filter off the prepared
  set — reads back as unverified, the phase never opens, and the mismatch detail names what the
  read-back actually contained.

## Firefox limitations

- **Main-world evaluation.** The trusted-page evaluator's isolated CDP world does not exist on
  Firefox; `createTrustedPageEvaluator` probes CDP once, falls back to main-world
  `page.evaluate`, and keeps that choice per page. The isolated-world anti-tamper hardening is
  degraded accordingly: evaluation results can be influenced by page scripts.
- **No `moz-extension://` access.** uBO's own pages cannot be opened or driven, so extension
  settings and version cannot be verified the way the Chromium reporter flow does. Verification
  is the managed-storage contract plus observed filtering behavior: the enabled set in a phase proof
  is the declaration the browser applied, and the user-filter state is the declared file read back.
- **A narrowed enabled set is refused.** The declared selection is applied whole at every browser
  start, so there is no channel that would switch part of it off for one phase; a phase request
  naming `enabledListKeys` is refused rather than answered with the whole selection.
- **Signed XPIs only.** Firefox has no unpacked-directory equivalent of the Chromium load flag;
  `FirefoxEngine` rejects a non-empty `extensionPaths` with a configuration error,
  and Chromium-family engines conversely reject `firefoxPolicies`. Each family must use its own
  channel.
