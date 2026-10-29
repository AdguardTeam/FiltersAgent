# AdGuard Filters Agent — Requirements and Design Notes

## 1. Goal

> The agent produces evidence-backed reports a filter maintainer can act on with confidence. It
> optimizes for reviewer confidence, not for the number of fixes it proposes.

The agent reads an issue in a filter-list repository, reproduces the reported problem in a real
browser with a real content blocker, writes a candidate rule and validates it, and posts a report
comment on the issue: what it found, the evidence, the rule and why that rule. A maintainer decides
what to commit.

The agent never closes an issue, never writes to the lists and opens no pull request. Its only
write to the repository is the report comment (and the screenshots the comment links).

The rest of this document describes the AdguardFilters repository, the first repository the agent
serves, and the design decisions behind the agent.

## 2. The AdguardFilters repository

### 2.1 Issue format

Most issues are opened by `adguard-bot` from the AdGuard reporter and carry:

- **Issue URL** — the page with the problem.
- **Comment** — the user's description of the problem.
- **Screenshots** — the missed ad or the broken page.
- **System configuration** — product, OS, browser and enabled filters.
- **Issue configuration** — a link that imports the reporter's settings.

### 2.2 Problem labels

| Label | Problem | What fixes it |
| --- | --- | --- |
| `T: Ads` | An ad is not blocked | A blocking rule |
| `T: Anti Adblock` | The site detects the blocker | A scriptlet, blocking the detector script, or hiding the overlay |
| `T: Incorrect Blocking` | A filter breaks the site | An exception rule (`@@`), or changing or removing the existing rule |
| `T: Annoyance` | An annoying element | A cosmetic rule |

Priority labels run from `P1: Critical` through `P2: High`, `P3: Medium` and `P4: Low` to
`P5: Lowest`.

### 2.3 Filter list layout

```
AdguardFilters/
├── BaseFilter/sections/         ← international sites and multilingual traffic; also holds a
│                                   section for languages without a filter of their own
├── CyrillicFilters/             ← Russian and Ukrainian sites
│   └── sections/common/         ← sites with both Russian and Ukrainian traffic; goes into both
├── ChineseFilter/sections/
├── FrenchFilter/sections/
├── GermanFilter/sections/
├── JapaneseFilter/sections/
├── DutchFilter/sections/
├── SpanishFilter/sections/
├── TurkishFilter/sections/
├── MobileFilter/sections/       ← mobile ads
├── AnnoyancesFilter/            ← annoyances
├── SocialFilter/sections/       ← social buttons and widgets
├── SpywareFilter/sections/      ← trackers
├── TrackParamFilter/sections/   ← tracking parameters in URLs
└── ExperimentalFilter/sections/ ← experimental rules
```

### 2.4 Placement rules of the filter team

| Site | Filter |
| --- | --- |
| International site or multilingual traffic | BaseFilter |
| Site in a language that has its own filter | That regional filter |
| Cyrillic site with both Russian and Ukrainian traffic | CyrillicFilters, `sections/common` |
| Site in a language without its own filter | BaseFilter, the section for other languages |
| Ad and tracking domains | The domain sections of the filter |
| Everything else, exceptions included | The `specific` section |

## 3. How filter engineers work

These notes come from the filter team and shape what the agent collects.

- **Process.** Open the reported site in a private window (clean cookies and storage), inspect it
  with DevTools (Elements, Network, Sources, Console, Application), find the ad element, tracker
  or breakage, write the rule, check it on a real device, commit.
- **Rule breadth.** There is no tool for it: an engineer adds the rule and browses around. A
  `$domain=` modifier is used often, and the rule's URL often contains the site's domain.
- **Duplicates.** Nobody checks for them by hand; there is no tooling.
- **Anti-adblock.** Scriptlets are the main tool. The simple cases block the detector script or
  hide the overlay; detection through DNS leaves only scriptlets.
- **Incorrect blocking.** An exception rule, a change to the existing rule, or sometimes removing
  the blocking rule.
- **Issues closed without a rule.** The problem no longer reproduces, the request contradicts the
  filter policy, or the rule would harm other users.
- **Validation.** AGLint runs in a pre-commit hook; nothing else runs on a pull request. The real
  check is manual, on a device.
- **What helps most.** A structured report of what is on the page — which problems to look at and
  where in the page, code or URLs — that accounts for the overlap between filters, with
  screenshots that mark the problem areas.

## 4. Architecture: a model with tools

The model is the brain; the tools are its hands. The model decides what to do and in which order;
the tools reach what it cannot reach itself.

- A **tool** is a primitive the model cannot perform: HTTP, the browser, the linter, the
  repository checkout.
- **Reasoning** stays with the model: reading the issue, analyzing the page, choosing the rule
  type, writing the rule, judging its risk, choosing the list file, interpreting the screenshots.
- There are no analysis modules between the model and the tools. When the model can judge a
  question, the model decides and the code validates the answer and returns the reason when it
  refuses it.

## 5. LLM boundary

The application defines no LLM abstraction of its own. The provider is configured once in
`src/pi/runtime.ts`, and all code reaches the model in exactly two ways: `runAgentSession`
(`src/pi/session-runner.ts`), a multi-step session with tools that ends only through a
schema-validated terminal tool, and `SingleShotClient` (`src/pi/single-shot.ts`), a single metered
call with a structured (Valibot) answer. `@earendil-works/pi-*` is imported only inside `src/pi/`.

## 6. Tools

### 6.1 Where tools are declared

Tool names are declared once, in `src/agent/tool-names.ts`; their model-facing guidance is in
`src/agent/tool-catalog.ts`. Each mode gets its own tool surface from `src/agent/tool-factory.ts`.
`read` is the one tool no mode surface declares: the session runner adds it when the repository
ships a skill the agent is shown, confined to the skills directory. The fix session counts its calls
in the same enumeration backstop as every registry tool.

### 6.2 Shipped tool surface

The tools the original design planned ship differently or not at all; this section is the one
place that records how, and AGENTS.md points here rather than restating it. `get_cookies`,
`get_storage` and `get_frames` are superseded by the single bounded probe `inspect_page_state`:
cookie values are never returned, storage values are redacted and truncated, and one call cannot
approach the session tool-result ceiling. It is the only path to those APIs, because `evaluate_js`
rejects cookie and storage access. `intercept_requests`, `stop_interception` and
`inspect_class_family` are removed — request interception never substituted for `apply_rule`
validation, and no run called them. `resolve_placement` is removed: the agent
names the list file in its draft from what `search_rules` shows, and `finish_fix` only checks
that the rule can be inserted there (section 8). `score_risk` is removed as well: the agent states the
rule's risk itself — a level and the reasons — and nothing gates publication on it beyond the
check that the rule is scoped to the reported domain. `bisect_rule` is not built:
`get_applied_rules` returns the rules the session's filtering engine itself reported acting on
the page, each with its list (lists outside AdguardFilters included), and the agent names the
culprit from that answer; what the engine applies without naming it is stated in the answer. A
session whose engine cannot report does not offer the tool. When no session offers it, or its
answer names nothing that explains the problem, the agent halves the reporter's lists one
browser session per step. A single list is halved in place: `launch_browser`'s `settings.slice`
runs a line range of the build's own text of the list as a trusted custom filter (the answer's
`enabledLists` gives the line counts, `listSlice` the slice's facts), and such a session
validates no candidate.

## 7. Validation: three filtering states

A candidate is validated in the environment the run selected, across three filtering states:

| State | Filtering |
| --- | --- |
| A | Filtering disabled: the site's own baseline |
| B | The reporter's filters, as reported |
| C | The reporter's filters plus the candidate rule |

- **Ads and annoyances:** the symptom is present in B and gone in C after the same bounded
  interaction sequence, and the page is not broken. A is the disabled control.
- **Incorrect blocking:** B shows the breakage, and C shows the function restored with no new ads
  anywhere on the page. A domain-scoped exception (`@@` or `#@#`) is the preferred candidate. To
  find the rule that breaks the page, the agent reads `get_applied_rules` or halves the reporter's
  lists, and then a single list, one browser session per step.

## 8. Rule placement

The agent chooses the list file; the code only checks that the rule can be inserted there.

- The agent names the list file in its draft (`ruleProposal.placement.filePath`) exactly as
  `search_rules` shows the path: the file that already holds the site's rules, otherwise the file
  that holds similar rules (the team's rules in 2.4, the `placement` topic of
  `lookup_rule_guidance`).
- When the run instruction declares a placement for the rule's kind, the agent names that file.
- `finish_fix` checks that the file is one of the repository's own lists, exists in the checkout,
  and matches the placement declared for that kind of rule. If not, the agent gets the reason and
  chooses again. The code never picks another file for the agent.
- The code picks the position inside the file when it builds the patch: the sorted position in a
  sorted file, otherwise the domain's block, the closing section, or the end of the file. When the
  file already holds the same rule shared by other sites, the reported domain is added to it
  instead of a new line.

## 9. Policy and risk

- **Policy** belongs to the repository. Its rules come from the run instruction: which reports close
  without a rule (`propose_close`) and which go to a maintainer (`needs_human_review`). The model
  applies them as written and cites the rule; without such rules every report is open to rule
  generation (`allow_rule_generation`). A draft that the policy decision does not allow is not
  published as a rule.
- **Risk** is the agent's own assessment: a level and the reasons, judged from what the rule matched
  on the page and what else it could match. Nothing gates publication on it beyond the check that
  the rule is scoped to the reported domain.
