# Run instruction: uAssets-style filter repository with uBlock Origin Lite in Chromium

This file is the run instruction for a uAssets-style filter-list repository. The run's blocker is
uBlock Origin Lite (uBOL) in Chromium from the current public release, loaded as an unpacked MV3
build. Every step below is the run's obligation — perform it exactly as written: the host reads
the blocker state back itself and credits a phase only when that state holds exactly what this
instruction declares. Verification in uBO Lite does not replace the full uBlock Origin.

The candidate reaches uBOL through custom filters in developer mode — the route this instruction
enforces. Rebuilding uBOL's shipped DNR rulesets from the list with the candidate is the
maintainer's alternative; its elapsed time is measured on a runner, outside this run.

The run loads its filter guidance at start from these role documents:

- [uBlock Origin static filter syntax](https://github.com/gorhill/uBlock/wiki/Static-filter-syntax)
- [uAssets filtering policy](https://github.com/uBlockOrigin/uAssets/blob/master/CONTRIBUTING.md)

## Preparation

1. Download the current Chromium build of uBlock Origin Lite — the current release version only,
   never a frozen or pinned tag. Ask the public GitHub releases API
   `https://api.github.com/repos/uBlockOrigin/uBOL-home/releases/latest`. Take the asset named
   `uBOLite_<version>.chromium.zip`, where `<version>` is the release's own version between the
   fixed `uBOLite_` prefix and the fixed `.chromium.zip` suffix, and assert that exactly one
   asset in the release matches it. Zero or several matches stop preparation with a named failure
   detail: the suffix you tried and the asset names the release offered. Never take the `edge`,
   `firefox`, `safari` or `firefox_private` assets — this run drives Chromium only.
2. When the release offers no current-suffix asset, fall back to the older suffix: take the asset
   named `uBOLite_<version>.chromium.mv3.zip` — `uBOLite_`, the release's own version, then
   `.chromium.mv3.zip` — under the same exactly-one assertion: zero or several matches stop with
   the same named detail.
3. Unpack the archive into the prepared extension directory inside the run workspace so that the
   directory's root holds the build's `manifest.json` directly.
4. In the run's host-state directory — where the host resolves the declared target below, outside
   the repository checkout — create the custom-filters file
   `filters-agent/ubol/custom-filters.txt` empty. uBOL ships no custom filters, so an empty file
   is uBOL's own ground state; the rule-application step appends the candidate rule to it.
5. Before finishing, assert both artifacts exist in the run workspace: the unpacked extension
   directory whose root holds `manifest.json`, and the empty custom-filters file.

## Rule application

The candidate rule reaches uBOL only through `filters-agent/ubol/custom-filters.txt`, applied
through the Custom-filters editor with Developer mode enabled. Perform the steps in order, invent
none. A rule proposed under the linked syntax must be one uBOL's declarative DNR engine can
enforce: constructs the syntax page names that DNR cannot express are not proposed for uBOL.

1. If your goal is to apply the candidate rule: append it to
   `filters-agent/ubol/custom-filters.txt` as one exact line at the end of the file — no
   rewrites, no extra rules, nothing removed.
2. Open the uBOL blocker management surface your session names, and enable Developer mode in
   uBOL's settings.
3. Put the file's exact contents into uBOL's Custom-filters editor — the candidate rule last —
   and apply them.
4. Restart the browser session once if the target page does not reflect the applied custom
   filters.

## State verification

After the application steps the host reads the blocker state back itself; it never accepts the
session's own report. The host's declaration:

read: user-rules-file filters-agent/ubol/custom-filters.txt

The target is relative to the run's own host-state directory, which the host creates per run outside
the repository checkout; it resolves the target there, so nothing the run writes can ever be read
back as repository content. The file must be the very one preparation created empty and the
application steps appended to — one rule per line, the candidate appended last — and the host
credits that file's exact content.

This declaration does not run today. The only file-backed application the host can perform is
`managed-storage-file` beside a `launch: firefox` declaration — the uBO example, where the host
maintains the declared file and rebuilds Firefox's enterprise policies around it. uBOL keeps its
custom filters in Chromium-local storage the host cannot write, so a run loading this example
refuses before any paid work, naming the declared method (see
`docs/modules/browser-with-extension.md`).

The credit names the maintained custom-filters file, not uBOL's own storage: uBOL keeps custom
filters in its browser-local storage, which the host cannot read directly. The file is the source
the run maintains, and it is exactly what the Custom-filters editor was given.

The same reduced-engine honesty applies to this verification: a candidate verified in uBOL is
verified against its reduced MV3 declarative engine, not the full uBlock Origin.

A maintainer who wants the candidate inside uBOL's shipped rulesets takes the DNR-ruleset route
instead: rebuild those rulesets from the list with the candidate merged and record the elapsed
wall time — the runner measurement the open question about the rebuild's job-time fit needs.

## Placement

An accepted rule goes at the end of this repository's current-year filters file, preceded by a
comment line holding nothing but the issue URL — the placement the linked contributing guide
describes. The host takes it from this one declaration and proposes exactly that:

placement: filters/filters-{{year}}.txt comment: ! {{issueUrl}}

The run fills the year from the date it runs on and the URL from the issue it is working, so the
line needs no editing between runs. The custom-filters file named under State verification is the
in-browser application path only; it never receives the proposed rule.

## Issue selection

Take issues reported through the uBOL report form that report broken filtering on real pages —
ads, banners, trackers or similar elements this repository's lists should block. Work one issue
whose fix is a filter rule; skip feature requests, infrastructure or meta tickets, and anything
fixable only by changing uBOL itself rather than the lists.

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

Verification in uBO Lite does not replace the full uBlock Origin: uBOL applies the candidate
through its reduced MV3 declarative engine, so a rule verified here is not a confirmation it
holds in uBlock Origin.

### Policy rationale

{{policyRationale}}

### Place in the list

{{listPlace}}

Proposed placement: the file and comment line the Placement section declares — the end of the
current year's filters file, behind a comment holding the issue URL. The file named above is that
list file; the custom-filters file the run verified against is the in-browser application path
only.

### Missing information

{{missingInformation}}

### Screenshots

{{screenshots}}

### Artifacts

{{artifactsLink}}
