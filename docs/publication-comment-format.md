# Publication comment format

The comment the agent will post into a public `AdguardTeam/AdguardFilters` issue once
stage-3 publication is enabled. This document is the contract the renderer must implement
and reviewers check drafts against.

## Register rules

- **Impersonal.** No second person anywhere. The comment is read by the whole thread —
  reporter, maintainers, people with the same problem — not by one addressee, and the bot
  must not carry a conversational persona. Write "the report comes from…", never "you
  reported…".
- **No internals.** Never include the report key, revision/prompt digests, agent source
  SHA, links to the private repository, or links to Actions artifacts (they do not open
  for the public and expire). The only provenance that appears is the AdguardFilters
  commit the analysis ran against, in the footer and in the line permalinks of the
  `Suggested placement` sentence.
- **Facts over hedging.** State what was observed with numbers (element counts, pixel
  sizes, request counts). A `Limitation` section appears **only** when the verification
  environment differed from the reporter's product; when the check ran on the reporter's
  own product and settings, no caveat is written.
- **Footer, verbatim shape:** `Automated analysis against filters at <sha7>. Posted by a
bot; a maintainer reviews before anything is merged.` — always last, always `<sub>`.

## Publication gate

A comment is published only for an outcome **plus** its mandatory evidence (see the
policy table in the intake plan). `patch_proposed` requires the verified rule and
before/after evidence. Everything attributable to our own infrastructure stays silent,
except for a run a maintainer forced (`force`): when it cannot investigate the issue, or
fails during intake or investigation, it posts a fixed one-line notice — the page could not be accessed, or the report
could not be processed — with the link to the workflow run and no reason. The notice is
not the issue's report: a retry and the backlog still take the issue.

A run that passes those local gates is then checked against the upstream issue **as it
stands at publication time**, not as it was when the run was queued: of 18 proposals in one
day, 7 targeted issues maintainers had closed within a day. The guard reads the issue and
its timeline right before rendering and posting and stays silent when any of these holds, in
this order:

1. **Issue closed** (`issue_closed`) — whatever the reason; nothing is posted into a closed
   thread.
2. **Fix referenced** (`fix_referenced`) — a commit in `AdguardTeam/AdguardFilters` or a
   pull request against it mentions the issue. Maintainers close by commit message
   (`Fix #N`), so this is the landed fix; a commit in a fork is ignored — the `pull[bot]`
   mirrors re-reference every upstream commit under their own name.
3. **Maintainer engaged** (`maintainer_engaged`) — a comment by a human whose association
   is `OWNER`, `MEMBER` or `COLLABORATOR`, an assignee, or the `A: In progress` label.
   `adguard-bot` is stamped `MEMBER` too and is excluded as a bot; any earlier maintainer
   comment counts, not only one after the analysed revision.

If the issue cannot be read, the state is unknown and the run stays silent
(`upstream_unreadable`) with the error recorded. The rehearsal notice lists every signal
found, not only the one that decided.

## Suggested placement

Names the file and, when the run recorded a place, the spot inside it. A bare line number would
drift between rendering and reading, so a line is always a permalink to the AdguardFilters commit
the analysis ran against (`https://github.com/AdguardTeam/AdguardFilters/blob/<full sha>/<file>#L<line>`)
and points at the line as it was in that commit. The file is always a permalink to the same
commit. No neighbouring rule is quoted: a shared rule can be a wall of domains with its selector
at the end.

The place is the agent's choice, read from the file's own outline, not a position the run picked.
The sentence names the basis the recorded edit carries, and adds the heading and the platform
condition the rule lands under when the file held them there. Both are repository text and render
as inert code spans.

- **`chosen_line`:** ``Before [line N](<permalink>).`` Under a heading it reads
  ``Under the heading `<heading>`, before [line N](<permalink>).``, with the condition after the
  heading when the line sits inside one.
- **`sorted_position`:** ``At its sorted position among the existing rules, before [line N](<permalink>).``
  The rule sorts inside the region the agent named: the line of an outline marker the outline flags
  as sorted, or the region before the first marker when the agent left the line out. A rule that
  sorts last in that region has no line to precede and reads
  ``At its sorted position among the existing rules.``
- **`append_eof`:** `At the end of the file:` followed by the agent's reason, which closes the
  sentence unless it already ends one. A recorded end-of-file insert with no reason, as an earlier
  run may have written it, reads `At the end of the file.`
- **`domain_block`:** ``Next to the site's existing rules, before [line N](<permalink>).`` Earlier
  runs only.
- **`terminal_section`:** ``At the end of the file's regular rules, before [line N](<permalink>).``
  Earlier runs only.
- **`append_eof` with a declared comment:** ``At the end of the file, behind the comment line `<comment>`.``
- **An `extend_domains` edit:** ``By adding the domain to the existing rule on [line N](<permalink>).``
- **No recorded place:** the file only.

`before_line`, `sorted` and `file_end` are the position kinds the agent names in its draft; the
basis values above are what the recorded insert edit carries and what this section describes.

## Posting

A run posts its comment whenever it has a token (the `githubToken` or the
`githubUserToken` input) and the workflow does not set `noComment`. The issue is read again
and the guard re-run right before posting: the render may be minutes old, and a maintainer
can act in between. One text of an issue gets one report: the run finds its earlier report
by the hidden marker and its own login. Its own comments never count as a maintainer on the
issue, whichever account posts them.

## Worked example: patch_proposed, same-product verification

Real data from run 2026-08-30 for
[AdguardTeam/AdguardFilters#239744](https://github.com/AdguardTeam/AdguardFilters/issues/239744).
No `Limitation` section: the check ran on the reporter's product (Browser Extension MV3,
Chrome) with the reporter's imported settings.

---

Proposed rule:

```adblock
cashbackrabat.pl##section[class^="CookiePopup_styles_root__"]
```

**Checked automatically.** On `https://www.cashbackrabat.pl/` with the settings imported
from this report — AdGuard Browser Extension MV3 in Chrome, all 18 reported filters,
including the Polish GDPR-Cookies list — the reported cookie bar is a single first-party
element: `section.CookiePopup_styles_root__TINaW`, fixed to the bottom of the viewport,
96 px tall. With the rule applied it is gone (matched elements 1 → 0, height 96 → 0) and
the rest of the page renders unchanged: document height identical before and after, no
leftover gap, nothing else hidden.

The page's network log contains no third-party consent vendor, so the banner ships in the
site's own HTML and element hiding is the right shape of fix. The selector targets the
stable component prefix (`CookiePopup_styles_root__`) rather than the build-hashed suffix
(`TINaW`), and matches exactly one element on the live page. No existing rule covers this
domain or selector family.

**Suggested placement:** `BaseFilter/sections/foreign.txt`. A cookie-notice section of
`AnnoyancesFilter` may be the better home — the report has the Cookie Notices filter
enabled, and cookie bars usually live there; the automatic placement does not weigh that.

<sub>Automated analysis against filters at `8def98a`. Posted by a bot; a maintainer
reviews before anything is merged.</sub>

---

## Worked example: patch_proposed, proxy verification (Limitation present)

Real data from run 2026-08-29 for
[AdguardTeam/AdguardFilters#239393](https://github.com/AdguardTeam/AdguardFilters/issues/239393)
The reporter runs AdGuard for Mac; the check ran through the app filtering engine in a desktop browser, so the `Limitation` section is mandatory.

---

Proposed rule:

```adblock
apetta.ru###apetta-consent-banner
```

**Checked automatically.** On `https://apetta.ru/` with the filter set from this report,
the cookie bar is a single first-party element — `div#apetta-consent-banner`, fixed to
the bottom of the viewport, 50 px tall. With the rule applied it measures 0 px and the
rest of the page renders unchanged: no gap, no shifted layout, nothing else hidden.

The page's 166 requests contain no third-party consent vendor, so the banner ships inside
the site's own HTML and element hiding is the right shape of fix — a network rule would
have nothing to block.

**Suggested placement:** `BaseFilter/sections/specific.txt`.
`AnnoyancesFilter/Cookies` may be the better home: the report has the Cookie Notices
filter enabled, and cookie bars usually live there. The automatic placement does not
weigh that.

**Limitation.** The check ran in a desktop browser through AdGuard's app filtering
engine, not in the reported app itself. The rule is cosmetic and behaves identically in
both, so this does not change the result.

<sub>Automated analysis against filters at `ed2168b`. Posted by a bot; a maintainer
reviews before anything is merged.</sub>

---

## Screenshots

A publishable comment carries two own-browser viewport captures of the candidate: the page
without the rule and the page with it. They sit in a collapsed `<details>` block titled
"Without and with the rule", as a two-column table, under the `Screenshots` heading. In the
built-in template the link to the artifacts follows it, and the footer stays the last element.

Where the images live follows the token input of the run. With `githubToken` they are committed
to a dedicated branch of the repository the comment is posted to — `filters-agent-screenshots`
unless the workflow's `screenshotsBranch` input names another — at `issues/<issue>/before.png`
and `issues/<issue>/after.png`, and linked by the commit that holds them. Writing the branch
needs the `contents: write` permission. With `githubUserToken` they are uploaded as attachments
and linked by their `https://github.com/user-attachments/assets/…` addresses; nothing is
committed.

A comment posts without the block when the run's generation holds no such captures, when the
report template has no `{{screenshots}}` placeholder, when an attachment upload fails, and when
the token may not write the branch (`contents: read`). Any other failure of the branch write
stops the report from posting.

## Other outcome classes

Templates for "already fixed, update filters", "not reproduced" and "needs a person with
access" follow the same register rules; drafts live with the publication-policy work and
join this document as each class gets a live worked example.
