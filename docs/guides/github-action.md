# Run the agent as a GitHub Action

The FiltersAgent action investigates a reported filtering issue in a real browser running an
ad-blocker extension, proposes and verifies a candidate filter rule, and posts a short report as
a comment on the issue. This guide connects it to a filters repository and adapts it to that
repository's blocker, policy and linter. Every input and output is listed in the
[action reference](../reference/action-inputs.md).

## What it does

When it runs against an issue, `filters-agent`:

1. Reads the issue and the page it reports a problem on.
2. Reproduces the problem in a real browser with an ad-blocker extension loaded.
3. Proposes a candidate filter rule and verifies it against that extension — the action reads the
   extension's own state back after applying the rule, rather than trusting its own report of what
   it did.
4. Posts a short report as a comment on the issue, with the page before and after a verified rule,
   and uploads the full run (report, traces, screenshots) as a workflow artifact.

## Requirements

- An LLM endpoint speaking the OpenAI chat-completions or Anthropic Messages API, reachable
  from GitHub-hosted runners. The action calls it directly; nothing is proxied or hosted for you.
- GitHub Issues enabled on your repository — that's where reports come from, and where the action
  posts its findings.

## Connect it to your repository

1. Copy [`docs/examples/filters-agent-workflow.yml`](../examples/filters-agent-workflow.yml)
   into your repository's `.github/workflows/`.
2. Add your LLM provider's API key as the repository secret `FILTERS_AGENT_LLM_API_KEY`. The
   endpoint URL, the reasoning model, the optional vision model and the reasoning model's limits
   are not secret — edit them directly in the workflow file you just copied, which ships with an
   OpenRouter-shaped placeholder. Set `llmApi: anthropic-messages` for Anthropic and use
   `llmBaseUrl: https://api.anthropic.com` without `/v1`; otherwise `llmApi` defaults to
   `openai-completions`. Without `llmVisionModel`, vision uses the effective reasoning model,
   including the `model` override, which must then accept images. Take the limits from your
   provider's model page: `llmContextWindowTokens` and
   `llmMaxOutputTokens` for the reasoning model, and `llmVisionMaxOutputTokens` when the vision
   model is a different one. A limit above the provider's own fails every request, so the action
   has no defaults for them, and a run without them fails before it spends anything. For a model
   that does not reason, also set `llmReasoningEffort: 'off'`. The agent is developed and tested
   on DeepSeek V4 Flash for reasoning (context window 1048576, completion cap 384000) and Gemini
   3.7 Flash for screenshots (completion cap 65536).
3. Add `.github/filters-agent/AGENTS.md` to your repository. It holds your filter policy — which
   reports close without a rule, see [Your own rules for the agent](#your-own-rules-for-the-agent);
   without it the agent proposes a rule for every report. It also links your guidance documents,
   and describes your blocker when your users run something other than the built-in AdGuard
   Browser Extension. See
   [`docs/modules/browser-with-extension.md`](../modules/browser-with-extension.md) for how the
   module drives a browser extension, and the example instructions in
   [`src/prompts/documents/instructions/`](../../src/prompts/documents/instructions/) — specifically
   `ublock-origin-firefox.md`, `ublock-origin-lite.md` and `edge-mv2.md` — for the shape a custom
   instruction takes. The same file is also how a repository that stays on the built-in extension
   points the run at its own filter guidance: see
   [An instruction that only adds guidance](#an-instruction-that-only-adds-guidance).
4. Optional: list the labels of issues the agent must never open, such as reports about adult
   sites, in the `excludedLabels` input. Such an issue is skipped before the run opens its page
   or commits a screenshot. If your maintainers label an issue they pick up, name that label in
   `inProgressLabels`; if a reporting tool files your issues through a bot account that GitHub does
   not mark as a bot, name its login in `reportBots`.
5. Open an issue: the example workflow runs on every new issue. Each run is a paid LLM call; to
   run only on issues a maintainer picks, switch the workflow's trigger from `opened` to `labeled`
   as its comment describes, and label an issue `filters-agent` to start a run. Either way, you can
   run the workflow manually with an issue number. A label or manual run should pass `force`, as the
   example workflow does, so an issue a maintainer is already on still gets the report. The
   trigger label is the workflow's own choice: `filters-agent` is only what the example's `if:`
   names, and any label works.
6. The report appears as a comment on the issue, unless the issue no longer needs one: it is
   closed, a commit or pull request of your repository references it, a maintainer (see
   `trustedRoles`) commented or is assigned (unless the run is forced), or the report for its
   current text is already there.
   The run checks this before it spends anything, and again right before it posts. An issue the
   run skips because it is not a filter report, or names no page, gets no comment either, and
   neither does a run that fails or cannot investigate the report (an unsupported product, no
   usable browser, a page it cannot reach) unless it still found a rule to review; the reason is
   in the run log and the uploaded artifact. A forced run that cannot investigate the report, or
   fails during intake or investigation, posts a one-line notice instead — the page could not be
   accessed, or the report could not be processed — with the link to the run, whatever your
   report template; the reason stays in the artifact. The notice is not the report: label the issue again or rerun the workflow to
   retry. For a verified
   rule the report shows the page without and with the rule. GitHub has no API to attach an image
   to a comment, so the run commits the images to a branch of your repository, named by the
   `screenshotsBranch` input (`filters-agent-screenshots` by default), which is why the example
   workflow grants `contents: write`. With `contents: read` the report posts without the images
   and the run log says which permission is missing.
   The full run — report, traces, screenshots — is uploaded as a workflow artifact; find it on the workflow run's Summary page. Preparation steps in an instruction run inside the action image, which provides `curl`, `jq`, `node`, `git` and `unzip`.

Releases are tagged `vX.Y.Z`, and `v1` follows the latest 1.x release; the example uses `@v1`.
Pin a full version to stay on one release.

Every job builds the action's own Docker image from scratch, including two browsers, before it
can start — expect it to add several minutes ahead of the actual analysis.

## What works today

Out of the box, with no `.github/filters-agent/AGENTS.md` in your repository, the action
investigates and verifies against the **built-in AdGuard Browser Extension** in Chromium.

An instruction file switches the run to another blocker. Three examples ship under
`src/prompts/documents/instructions/`:

- **uBlock Origin in Firefox** runs end to end. The example declares `launch: firefox` and a
  managed-storage user-filters file; the action force-installs the current signed uBO release
  through Firefox enterprise policies, applies the candidate rule through that file, relaunches the
  browser and reads the file back. Copy `ublock-origin-firefox.md` as your instruction and adjust
  the list selection to the lists your repository publishes.
- **uBlock Origin Lite** (Chromium) does not run yet: nothing in a run writes its rule file, so a
  run configured for it refuses immediately, before it checks out your repository or spends any
  LLM budget.
- **The AdGuard Browser Extension (MV2 build) in Microsoft Edge** reads its state back the same
  way the built-in route does, but the action cannot yet drive a branded Edge browser.

See [`docs/modules/browser-with-extension.md`](../modules/browser-with-extension.md) for the
detail behind each route.

### Plug in another blocker

Besides the built-in extension, a run can verify the rule through any proxy blocker packaged as a
blocker module. A module is a program the action starts once per run and drives through six
operations — `describe`, `start`, `apply`, `state`, `log`, `stop` — sent as JSON lines on its
stdin. The action applies each phase's lists and the candidate rule through `apply` and credits the
phase only when `state` reads back exactly that; the model never drives the blocker itself. The
operations are defined in [`src/blocker-contract/blocker-contract.ts`](../../src/blocker-contract/blocker-contract.ts).

A module ships a manifest beside its code:

```json
{
    "executor": "my_proxy",
    "selectionGuidance": "Which reports this blocker verifies, in prose the model reads.",
    "command": ["node", "./module.mjs"],
    "env": ["MY_PROXY_LICENSE_KEY"],
    "optionalEnv": ["MY_PROXY_CACHED_STATE"]
}
```

`command` words starting with `./` resolve against the manifest's directory. The module receives
`PATH`, `HOME`, `LANG`, `TMPDIR`, the variables `env` lists, the variables `optionalEnv` lists that
are set, and `FILTERS_AGENT_BLOCKER_WORKSPACE`, a private directory for its files. It must write nothing but protocol lines to stdout, and stop
whatever it holds when its stdin closes.

To plug a module in:

1. Put the module and its manifest into the workspace in a step before the action.
2. Pass the manifest path as `blockerModules` and add the executor to `executors`, for example
   `executors: browser_extension,my_proxy`. Leave `browser_extension` out to run the module alone.
3. Set every variable the manifest lists in the action step's `env:`, from secrets. A missing
   one fails the step named, before the run starts.

#### The AdGuard CLI module

The `adguard-cli` setup action of this repository installs a ready module: it verifies the rule
through [AdGuard CLI](https://github.com/AdguardTeam/AdGuardCLI) running as a filtering proxy in
front of the browser, the way a desktop AdGuard user sees the page. With both executors enabled,
the agent picks AdGuard CLI for reports from AdGuard for Windows, Mac and the mobile apps, and the
extension for reports from the AdGuard Browser Extension.

To connect it:

1. Add your AdGuard licence key as the repository secret `ADGUARD_LICENSE_KEY`.
2. Add the setup step below before the action. It downloads the pinned CLI release, checks its
   checksum and AdGuard's signature, and installs it with the module.
3. Pass the licence in the action step's `env:`, the step's `manifest` output as `blockerModules`,
   and add `adguard_cli` to `executors`:

```yaml
- name: Install the AdGuard CLI module
  id: adguard-cli
  uses: AdguardTeam/FiltersAgent/adguard-cli@v1

- name: Analyze the issue
  uses: AdguardTeam/FiltersAgent@v1
  env:
      ADGUARD_LICENSE_KEY: ${{ secrets.ADGUARD_LICENSE_KEY }}
  with:
      blockerModules: ${{ steps.adguard-cli.outputs.manifest }}
      executors: browser_extension,adguard_cli
      # ...the rest of the inputs as in the example workflow
```

Without a seed, each run activates the licence on one device and resets it when it ends, so two
parallel runs hold two devices. A run killed before its reset (a cancelled job, a runner lost
mid-run) leaves its device bound; unlink it in your AdGuard account if activations start to fail.

A seed lets parallel runs share one device. Activate the licence once in a manually dispatched
workflow on the default branch:

```yaml
name: Seed the AdGuard CLI home
on: workflow_dispatch
permissions:
    contents: read
jobs:
    seed:
        runs-on: ubuntu-latest
        steps:
            - uses: AdguardTeam/FiltersAgent/adguard-cli@v1
              env:
                  ADGUARD_LICENSE_KEY: ${{ secrets.ADGUARD_LICENSE_KEY }}
              with:
                  seedHome: 'true'
```

It saves the activated CLI home to the repository's Actions cache. From then on the setup step
restores the newest seed and the module starts from it without activating or resetting anything.
The `homeRestored` output says whether it did. Seed again after a CLI release bump, or after
GitHub evicts the cache (seven days without a run). Each seed binds one more device; unlink the old
one in your AdGuard account.

The seed holds licence state, and any workflow in the repository can restore it from the cache,
including one started by a pull request from a fork. Do not seed in a repository whose workflows
run code from pull requests.

The setup step's inputs and outputs:

| Name | Kind | Description |
| --- | --- | --- |
| `path` | Input | Workspace-relative directory the module is installed into; defaults to `.filters-agent/adguard-cli`. |
| `releaseUrl` | Input | Stable AdGuard CLI release archive to install; defaults to the pinned release. Change it together with `releaseSha256`. A pre-release (rc, beta, nightly) is refused. |
| `releaseSha256` | Input | SHA-256 of the release archive. |
| `seedHome` | Input | `'true'` activates the licence once and saves the seed instead of preparing a run. |
| `manifest` | Output | Workspace-relative path of the module manifest; pass it as `blockerModules`. |
| `homeRestored` | Output | `'true'` when the run restored a seed. |

How the module is built from this repository's sources is in
[DEVELOPMENT.md](../../DEVELOPMENT.md#build-the-adguard-cli-module).

### How a rule gets applied between phases

To measure a candidate the action has to put your repository's filters and the candidate rule into
the blocker before each phase. Your instruction decides how, and there are three shapes:

- **No instruction, or one declaring `application: adguard-extension`.** The built-in AdGuard route.
  Its steps are a fixed message protocol, so the action performs them itself in code: wait for the
  extension to finish installing, import the prepared settings, turn off any filter the import left
  on that your settings do not name, and save the candidate as the only user rule. No model is
  involved, so an application takes seconds instead of the several minutes a model spent sending the
  same messages one turn at a time.
- **An instruction declaring a file-backed read** (`read: managed-storage-file` or
  `read: user-rules-file`). The action writes the file itself, relaunches the browser so it picks the
  file up, and reads it back. The uBlock Origin in Firefox example is this shape.
- **An instruction writing its own `## Rule application` steps.** The model performs exactly those
  steps — nothing else — which is how a blocker with its own way of adding a rule gets driven.

Whichever shape applies, the action then reads the blocker's own state back and credits the phase
only when that state holds exactly what it expected: the candidate rule and nothing else for a
candidate phase, no user rule at all for a baseline. Nothing is taken on the model's word.

### An instruction that only adds guidance

An instruction does not have to switch the blocker. Every part of it is optional on its own: leave
out the preparation, the launch, the placement, the issue selection or the report template, and the
run keeps its built-in behaviour for that part. The application steps are the one part no run can
invent, so an instruction that adds nothing but guidance documents names the built-in route that
applies its rules, on one line:

```
application: adguard-extension
```

`adguard-extension` is the only route today: the built-in AdGuard Browser Extension in Chromium,
which the action prepares, launches, applies and reads back itself. The line says how a rule is
applied when a run uses the extension; it does not choose the blocker. A run with
[the AdGuard CLI module](#the-adguard-cli-module) among its `executors` still picks AdGuard CLI for
reports from AdGuard apps, so do not describe the extension as the run's only blocker in the
instruction's prose either: the agent follows that prose. Without that line an instruction
is expected to carry its own `## Rule application` and `## State verification` sections, and a run
whose instruction carries neither spends its whole budget before refusing to apply anything.
Declaring the route *and* writing those sections is a contradiction: the run fails at start, naming
the instruction and both facts.

A complete guidance-only instruction, for a repository whose runs use the built-in extension and
the AdGuard CLI module:

```markdown
# Run instruction: AdguardFilters

The run verifies a rule in one of two blockers, chosen per report by the routing guidance: the
built-in AdGuard Browser Extension in Chromium, or AdGuard CLI as a filtering proxy for reports
from AdGuard apps that filter at the network level. The host prepares, launches and reads both back
itself. This file adds nothing to those routes but the guidance documents this repository writes
its rules against.

application: adguard-extension

The run loads its filter guidance at start from these role documents:

- [AdGuard filter syntax](https://github.com/AdguardTeam/KnowledgeBase/blob/master/docs/general/ad-filtering/create-own-filters.md)
- [AdGuard filter policy](https://github.com/AdguardTeam/KnowledgeBase/blob/master/docs/general/ad-filtering/filter-policy.md)
- [AdguardFilters contributing guide](https://github.com/AdguardTeam/AdguardFilters/blob/master/CONTRIBUTING.md)

Rule placement is deliberately not declared: this repository files rules per language and per rule
kind across `<Filter>/sections/*.txt` — more distinctions than a declaration can name — so the file
is chosen from where the repository already keeps rules like the new one.
```

The link labels are what bind the documents: a label containing `syntax`, `policy` or
`contributing` binds that role, and `lookup_rule_guidance` then answers every topic from your
documents. A topic whose role you did not link is answered by a notice saying so, which the run's
report carries as missing information. Without an instruction the run serves one document: AdGuard's
filter syntax at a pinned KnowledgeBase commit. It serves no policy document, so no policy applies
until your instruction states one.

### Your own rules for the agent

Rules your maintainers keep applying by hand go into the same instruction file, in plain prose under
a `##` heading of their own. The run puts the whole instruction into the agent's task word for word,
and tells the agent that it governs over its default guidance. Write each rule the way you would
explain it to a new maintainer: the situation, the rule to write, the rule not to write, and why. A
real issue with the rule you rejected and the rule you wrote teaches the agent faster than the
principle alone.

Continuing the guidance-only instruction above:

```markdown
## Maintainer rules

### Anti-adblock popups: disable the detector, do not hide the popup

When a site shows an anti-adblock popup or wall, do not propose a cosmetic rule that hides the
popup: the detector keeps running, so the site can still lock content or show the popup in another
layout. Find the script that detects the blocker and neutralize it with a scriptlet, usually
`set-constant` or `abort-on-property-read` on the detector's property.

Example, AdguardTeam/AdguardFilters#243463 (wzielonej.pl):

- Hides the popup only: `wzielonej.pl###tie-popup-adblock`
- Disables the detector: `wzielonej.pl#%#//scriptlet("set-constant", "tie.ad_blocker_detector", "")`
```

The same place holds your filter policy: which reports your repository closes without a rule and
which it hands to a maintainer. The action has no policy of its own: without such rules every
report is open to a rule, and the agent closes a report only on a rule your instruction states. For
AdguardFilters, following the AdGuard filter policy:

```markdown
## Filter policy

- The site's own advertising (first-party ads): close without a rule.
- Paywalls: close without a rule.
- German anti-adblock walls: close without a rule.
- Any other anti-adblock wall: write a rule only after the network log shows the detector script;
  without it, hand the report to a maintainer.
```

The agent records which rule decided and quotes it in the report's `{{policyRationale}}`.

Two limits apply:

- Some `##` headings carry a function: a heading containing `preparation`, `application`,
  `verification`, `selection`, `which issues` or `report template` is read as that part of the
  instruction. Name your rules' heading something else, such as `## Maintainer rules`.
- Each linked document role binds one document: link one policy document, and put the rules that
  extend it in the instruction text.

The instruction, without its linked documents, is capped at 16 000 characters; a longer one fails
the run at start rather than being cut.

### Skills

A repository can also give the agent procedures it loads only when a task matches. Put each skill
in `.github/filters-agent/.agents/skills/<name>/SKILL.md`:

```markdown
---
name: report-style
description: How this repository writes its report.
---

Read `references/report.md` and follow it when you write the report.
```

- The location is fixed: `instructionPath` changes the instruction file, never the skills
  directory.
- In a skill folder the file is named exactly `SKILL.md`. A `skill.md`, a folder whose name starts
  with a dot and a `SKILL.md` symlink to a missing file are skipped without a warning.
- `name` is lowercase letters, digits and hyphens, at most 64 characters, and defaults to the
  folder name. `description` is required, at most 1024 characters, and says when the skill applies.
- The agent sees every skill's name and description in its prompt. Once it has read the issue, it
  reads each skill whose description matches the issue or a step it is about to take, and before
  its final answer each one that covers the report. Only those lines ride every prompt, so keep
  them short. A skill with `disable-model-invocation: true` is never listed to the agent.
- Point to another file by a path relative to the skill's folder, as the example does: the agent
  resolves it from the `SKILL.md` location. Nothing outside the skills directory is readable, and a
  skill folder symlinked to a place outside it is listed but cannot be read.
- Only text files are read: a file containing a NUL byte is refused. A single line over 50 KB
  cannot be read either, so keep reference files broken into lines rather than minified.
- Scripts bundled with a skill do not run.
- The run log warns once per issue, not once per session, naming the file, or the directory when
  none loads. A skill without a description or with malformed YAML frontmatter is skipped, and so
  is one of two skills with the same name; the warning names the one used. An invalid name or a
  longer description only warns: the skill still loads. A skill with
  `disable-model-invocation: true` is warned about too, and a directory with no loadable skill at
  all gets one warning.
- Every `.md` file at the top of the skills directory is itself read as a skill, so keep a
  `README.md` out of it. A `SKILL.md` at the top makes the whole directory one skill, and its
  subfolders and other top-level `.md` files are then ignored.

### Where an accepted rule goes

You do not have to tell the action anything for this to work. The agent chooses the list from what
your repository already holds: the list with the reported site's rules, otherwise the one that keeps
rules like the new one. It names that list by the path the repository search shows, and the action
only checks that the rule can go there — the file is one of your repository's own lists and it is in
the checkout. When it cannot, the agent is told why and chooses again; the action never moves a rule
to a file of its own choosing.

The position inside the file is read from the file itself. When the list keeps its rules sorted — at
least 98% of adjacent lines in ascending order, in a run of at least 20 rules — the rule takes its
sorted place, by the whole rule text or, for hiding rules, by the rule with its leading site list
removed, the way EasyList's `FOP.py` sorts them. Otherwise the rule joins the site's existing rules
when it has any, and goes at the end when it does not. When the chosen list already holds the same
rule for other sites, the site is added to that rule instead of a new line.

A repository that wants to say where its rules go declares it in its instruction, and may use one
line per rule kind:

```
placement: cosmetic easylist/easylist_specific_hide.txt
placement: network easylist/easylist_specific_block.txt
placement: filters/filters-{{year}}.txt comment: ! {{issueUrl}}
```

The optional leading word is the rule kind the line governs — `cosmetic`, `network`, `exception` or
`scriptlet`. A line naming no kind covers every kind without a line of its own. The path is relative
to your checkout and may carry `{{year}}`, the year the run starts on in UTC.

The optional `comment:` part is the line written immediately before the rule and may carry
`{{issueUrl}}`, the URL of the issue being worked. It also decides where in the file the rule goes.
A comment naming the issue makes the file a chronological log, so the rule is appended at the end
behind that comment — the way uAssets keeps its year files. Leave the comment out and no comment is
written and the position is read from the file exactly as above, so a sorted list gets a sorted
insert.

A declaration settles the file for the kind it governs: a rule of that kind placed anywhere else is
returned to the agent. Keep the file in your repository — no edit can be proposed for a declared file
that is not in the checkout. Each kind is declared once: a kind repeated, a second line
naming no kind, an unknown kind, an absolute path, or a placeholder other than those two fails the
run at start, naming the instruction.

The two uBlock Origin examples declare the placement uAssets uses, so a repository that copies one
in gets the current year's filters file and a preceding comment holding the issue URL.

### Lint with your repository's linter

The action bundles no linter. The browser phases prove that a rule works; your repository's own
linter adds your policy on top — excluded rules, platforms, modifiers. Set `lintCommand` to the
command your repository lints its lists with, and install the linter in a step before the action.
For AGLint:

```yaml
- uses: actions/checkout@v6
  with:
      persist-credentials: false

- name: Install the repository's linter
  run: npm ci

- name: Analyze the issue
  uses: AdguardTeam/FiltersAgent@v1
  with:
      lintCommand: npx aglint
      # ...the rest of the inputs as in the example workflow
```

For each candidate the action writes the rule to a temporary file in the directory of the list it
goes into, so a directory-scoped linter configuration applies. It runs the command through `sh` in
the checkout with that file's checkout-relative path as the last argument, then deletes the file.
Exit code 0 means clean. Any other exit code, a command that cannot start, or one still running
after 60 seconds adds a `## Repository lint` section to the report with the command's output (its
first 4 KiB). The lint never stops a rule. The agent runs the same command on its drafts through
its `lint_rule` tool. Without `lintCommand`, nothing is linted and the report says nothing about
it.

The command runs inside the action's container, not on the runner. The container mounts the
workspace and provides Node.js 24 with `npm` and `npx`, plus `git`, `curl`, `jq` and `unzip`. A
linter installed into the workspace, as above, runs there; a tool installed on the runner outside
the workspace does not. The command gets none of the run's secrets: its environment holds only a
minimal set such as `PATH`, `HOME`, the locale and the temporary-directory variables.

### What the report can say

A `## Report template` section in your instruction replaces the built-in comment, and it is filled
from exactly these placeholders — every one of them, every run, empty when the run has nothing to
put there. A section whose placeholders all come out empty is dropped from the comment, so a
template can carry a heading for a case that rarely happens.

| Placeholder | What it carries |
| --- | --- |
| `{{outcome}}` | One line: a rule was proposed, the run ended analysis-only, the filter policy recommends closing the report or leaves it to a maintainer, or the report was answered without a patch. |
| `{{outcomeReason}}` | Why it ended that way, when the reason is not the outcome itself. |
| `{{versionUpdateHint}}` | That the reporter's blocker version is behind and the defect does not reproduce on the current one. |
| `{{symptom}}` | Whether the reported defect reproduced, and what the run saw. A run the filter policy decided carries only what it saw. |
| `{{rule}}` | The verified rule, as a code span. |
| `{{repositoryLint}}` | What the repository's `lintCommand` said about that rule — its exit code and output — when it flagged the rule or could not run. Empty when it passed or no `lintCommand` is set. |
| `{{candidateForReview}}` | A rule the run found and could not verify, with why. |
| `{{stillVisible}}` | What the vision review still saw on the page after that rule — the locations the reporter named that it did not fix. Empty for a verified rule, since one leftover instance is what rejects a candidate. |
| `{{executor}}`, `{{executorVersion}}` | The blocker the run actually drove, and its version. |
| `{{policyRationale}}` | The reasons of the policy decision: which rule of your filter policy (in the instruction or a document it links) allowed a rule or ruled it out. Empty when the run carries no policy decision. |
| `{{listPlace}}` | The file the rule goes into, and where inside it: the line the rule goes before or extends. Both are links to the file at the commit the run analyzed. |
| `{{missingInformation}}` | What the report would need to be actionable, when something is missing. |
| `{{screenshots}}` | The page without and with the verified rule, side by side. Empty when no rule was verified, and when the workflow lacks `contents: write` (see the example workflow). |
| `{{artifactsLink}}` | Link to the workflow run holding the full evidence. |

Every report ends with a footer line outside the template: the filters commit the run analyzed,
and that the comment was posted by a filters agent.

Placeholders render as Markdown text. Put them in the template's text, never inside an HTML
attribute value such as `<a title="{{symptom}}">`: the run's own text is made inert as Markdown,
not as an attribute.

A template that omits a placeholder simply never shows it; nothing fails. That also means a
template written against an older version of this action silently loses whatever was added since,
so it is worth re-reading this table after an upgrade.
