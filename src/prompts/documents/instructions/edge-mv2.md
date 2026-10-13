# Run instruction: AdGuard filter-list repository with the AdGuard Browser Extension MV2 build in Microsoft Edge

This file is the run instruction for an AdGuard filter-list repository. The run's blocker is the
MV2 build of the AdGuard Browser Extension, running in branded Microsoft Edge from the build the
run prepares out of the current public release. Every step below is the run's obligation — perform
it exactly as written: the host reads the blocker state back itself and credits a phase only when
that state holds exactly what this instruction declares.

The run loads its filter guidance at start from these role documents:

- [AdGuard filter syntax](https://adguard.com/kb/general/ad-filtering/create-own-filters/)
- [AdGuard filter policy](https://adguard.com/kb/general/ad-filtering/filter-policy/)

## Preparation

1. Confirm the machine prerequisites: branded Microsoft Edge is installed on the machine, and the
   machine's applied policies do not force-disable MV2 extension support. The host itself launches
   the prepared build with the MV2 runtime enabled for a manifest-2 build — preparation creates no
   browser or OS policy file; the machine must merely permit MV2 extensions.
2. Download the current MV2 build of the AdGuard Browser Extension — the current release version
   only, never a frozen or pinned tag. Ask the public GitHub releases API
   `https://api.github.com/repos/AdguardTeam/AdGuardBrowserExtension/releases/latest` and take the
   asset named `edge.zip`; save it inside the run workspace.
3. Unpack the archive into the prepared extension directory inside the run workspace so that the
   directory's root holds the build's `manifest.json` directly.
4. Before finishing, assert both artifacts exist in the run workspace: the saved archive and the
   unpacked extension directory whose root holds `manifest.json`.

## Rule application

The candidate rule reaches AdGuard only through the extension's own options application. Perform
the steps in order, invent none:

1. Open the AdGuard Browser Extension options page at
   `chrome-extension://<extension id>/pages/options.html`. Use the extension id of the prepared
   build your session was launched with.
2. Wait until the options application reports it has finished initializing: call
   `send_extension_message` with `{"type": "getIsAppInitialized"}` and repeat the call while it
   answers `false` — its background message handlers and default filters settle asynchronously
   after a fresh load, and settings applied in that window can be overwritten.
3. Apply the prepared settings through the options application: call `send_extension_message` with
   `{"type": "applySettingsJson", "data": {"json": "<the settings payload your task hands you>"}}`,
   passing the payload exactly as written, so the extension enables exactly the official filters
   the report asked for and the reported Tracking-protection state. Do not add, remove, or edit any
   other filter.
4. If your goal is to apply the candidate rule: add it as one exact user rule through the same
   channel: call `send_extension_message` with
   `{"type": "saveUserRules", "data": {"value": "<the candidate rule your goal names>"}}`, passing
   the candidate rule exactly as written, as one line, and nothing else. No rewrites, no extra
   rules, nothing removed.

## State verification

After the application steps the host reads the blocker state back itself; it never accepts the
session's own report. The host reads the live extension state:

read: extension-state user-rules

The read-back holds the prepared build's user rules; the host credits the phase only when they
contain exactly the candidate content the application steps saved.

This live-extension method is fully supported today. Of the file-backed methods only
`managed-storage-file` beside a `launch: firefox` declaration runs — the uBO example, where the
host maintains the declared file and rebuilds Firefox's enterprise policies around it;
`user-rules-file` (the uBOL example) still refuses before any paid work, because nothing writes the
file it names (see `docs/modules/browser-with-extension.md`).

## Issue selection

Take issues that report broken filtering on real pages — ads, banners, trackers or similar
elements this repository's lists should block. Work one issue whose fix is a filter rule; skip
feature requests, infrastructure or meta tickets, and anything fixable only by changing the
extension itself rather than the lists.

- labels: T: Ads
- max-age-days: 30

## Report template

### Outcome

{{outcome}}

{{outcomeReason}}

{{versionUpdateHint}}

### Reproduced symptom

{{symptom}}

### Rule

{{rule}}

### Repository lint

{{repositoryLint}}

### Candidate for review

{{candidateForReview}}

### Still visible after the rule

{{stillVisible}}

### Executor and version

{{executor}} {{executorVersion}}

### Policy rationale

{{policyRationale}}

### Place in the list

{{listPlace}}

Proposed placement: the list file chosen for this rule and its position there. This instruction
declares no placement, so the rule goes into the list the repository already keeps rules like this
one in, at the position that list's own order implies — its sorted place in a sorted list, the end
otherwise. The user rule the run verified against is the in-browser application path only; the list
file is where the fix is proposed to ship.

### Missing information

{{missingInformation}}

### Screenshots

{{screenshots}}

### Artifacts

{{artifactsLink}}
