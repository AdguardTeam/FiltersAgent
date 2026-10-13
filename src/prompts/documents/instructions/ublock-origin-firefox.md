# Run instruction: uAssets-style filter repository with uBlock Origin in Firefox

This file is the run instruction for a uAssets-style filter-list repository. The run's blocker is
uBlock Origin (uBO) in Firefox, force-installed from the current signed release through Firefox
enterprise policies. Every step below is the run's obligation — perform it exactly as written:
the host reads the blocker state back itself and credits a phase only when that state holds
exactly what this instruction declares.

The run loads its filter guidance at start from these role documents:

- [uBlock Origin static filter syntax](https://github.com/gorhill/uBlock/wiki/Static-filter-syntax)
- [uAssets filtering policy](https://github.com/uBlockOrigin/uAssets/blob/master/CONTRIBUTING.md)

## Preparation

The run image provides `curl`, `jq`, `node`, `git` and `unzip` for these steps; there is no
`python`, `perl` or `wget`.

launch: firefox

uBlock Origin is installed into Firefox as a signed XPI, force-installed through enterprise
policies; the host writes the policies file itself before every browser start, so do not write one.
Your job is to fetch the XPI and declare how the host must install it.

1. Download the current signed Firefox build of uBlock Origin — the current release version only,
   never a frozen or pinned tag. Ask the public GitHub releases API
   `https://api.github.com/repos/gorhill/uBlock/releases/latest` and take the asset whose name
   ends with `.firefox.signed.xpi`; save it inside the run workspace.
2. Assert the saved XPI exists in the run workspace and is not empty.
3. Finish with the Firefox launch declaration in your terminal payload:
    - `launchFamily`: `firefox`.
    - `extensionId`: `uBlock0@raymondhill.net`, uBO's published Firefox id.
    - `xpiPath`: the saved XPI, as a path relative to the working directory.
    - `managedStorage`: the managed-storage document uBO reads from `browser.storage.managed`, as
      JSON text — exactly the document below, this repository's baseline lists plus
      `user-filters`. Without `user-filters` in the selection uBO never applies the candidate rule
      at all. This selection is the run's executable baseline: it is what every phase runs with and
      what the run report names, and nothing in it is resolved against any other product's filter
      catalog.
    - `userFiltersKeyPath`: `["adminSettings", "userFilters"]` — the key inside that document the
      host fills with the exact contents of the user-filters file named under State verification.
      Do not create or write that file yourself: the host creates and maintains it. Nothing here
      needs the XPI unpacked or inspected; once it is saved and checked, finish.

The managed-storage document, verbatim:

```json
{
    "adminSettings": {
        "selectedFilterLists": [
            "user-filters",
            "ublock-filters",
            "ublock-badware",
            "ublock-privacy",
            "ublock-unbreak",
            "easylist",
            "easyprivacy"
        ]
    }
}
```

## Rule application

The host maintains the user-filters file `filters-agent/ublock/user-filters.txt` itself; there are
no steps for a session to perform. Between phases the host writes that file — empty for the
baseline goal, exactly the candidate rule as one line for the candidate goal — rebuilds the
enterprise policies with the file's exact contents at the declared key path, relaunches the browser
so the force-installed uBO reads the regenerated managed storage at startup, and then reads the
file back. uBO consumes managed storage while Firefox applies the policies, never from a running
session's settings UI, which is why the relaunch is part of the application and not an extra step.

## State verification

After the application steps the host reads the blocker state back itself; it never accepts the
session's own report. The host's declaration:

read: managed-storage-file filters-agent/ublock/user-filters.txt

The target is relative to the run's own host-state directory, which the host creates per run outside
the repository checkout; it resolves the target there, so nothing the run writes can ever be read
back as repository content. The file is the one the host maintains and the one whose contents the
enterprise policies carry into uBO's managed storage — one rule per line, the candidate rule alone
for a candidate phase.

The empty file credits the baseline phase and the exact candidate line credits the candidate phase.
The run's three phases are the ones every validation uses: Firefox with no extension, Firefox with
uBO and the lists declared above on an empty user-filters file, and the same plus exactly the
candidate rule. The file read-back cannot see `selectedFilterLists`, so the phase proof reports the
enabled set from the declaration above — the lists Firefox applied when it force-installed the XPI —
and records that the user-filter state itself was credited from the file's content alone (see
`docs/modules/browser-with-extension.md`).

## Placement

An accepted rule goes at the end of this repository's current-year filters file, preceded by a
comment line holding nothing but the issue URL — the placement the linked contributing guide
describes. The host takes it from this one declaration and proposes exactly that:

placement: filters/filters-{{year}}.txt comment: ! {{issueUrl}}

The run fills the year from the date it runs on and the URL from the issue it is working, so the
line needs no editing between runs. The user-filters file named under State verification is the
in-browser application path only; it never receives the proposed rule.

## Issue selection

Take issues that report broken filtering on real pages — ads, banners, trackers or similar
elements this repository's lists should block. Work one issue whose fix is a filter rule; skip
feature requests, infrastructure or meta tickets, and anything fixable only by changing uBO
itself rather than the lists.

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

uBlock Origin in Firefox, installed from the signed release XPI named under Preparation.

### Policy rationale

{{policyRationale}}

### Place in the list

{{listPlace}}

Proposed placement: the file and comment line the Placement section declares — the end of the
current year's filters file, behind a comment holding the issue URL. The file named above is that
list file; the user-filters file the run verified against is the in-browser application path only.

### Missing information

{{missingInformation}}

### Screenshots

{{screenshots}}

### Artifacts

{{artifactsLink}}
