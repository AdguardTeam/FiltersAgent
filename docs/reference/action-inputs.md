# Action inputs and outputs

The inputs and outputs of the FiltersAgent GitHub Action, as `action.yml` declares them. How to
connect the action and adapt it to a repository is in the
[GitHub Action guide](../guides/github-action.md).

## Inputs

`anthropic-messages` uses adaptive thinking and targets Claude models that
support it (Claude 5.x).

| Input | Required | Description |
| --- | --- | --- |
| `repository` | No | Repository slug (owner/repo) the run identifies itself with; defaults to the runner's `GITHUB_REPOSITORY`. |
| `issueNumber` | No | Number of the issue to analyze; selecting it runs the single-issue mode. |
| `backlog` | No | `'true'` analyzes the repository's open-issue backlog instead of a single issue. |
| `limit` | No | Maximum number of backlog issues analyzed per run; unset means up to 50 issues in one job, each a paid LLM run; the loop also stops at its wall-clock budget (default 5h 30m, overridable by an input) so one job stays under GitHub's 6-hour cap. |
| `excludedLabels` | No | Comma-separated issue labels the action never processes, for example `NSFW`. An issue carrying one is skipped before its page is opened, in the single-issue and the backlog mode alike, and a report stays unposted when such a label is added during the run. Labels compare case-insensitively; unset excludes none. |
| `inProgressLabels` | No | Comma-separated labels a maintainer applies when they pick an issue up, for example `A: In progress`. An issue carrying one counts as a maintainer already on it: the run is skipped, and a report stays unposted when such a label is added during the run, unless the run is forced. Labels compare case-insensitively; unset names none. |
| `reportBots` | No | Comma-separated GitHub logins of bots that file issues or post reports for a reporting tool, for example `adguard-bot`. Their comments are kept out of the model's input and never count as a maintainer on the issue, even when GitHub stamps them `MEMBER`. Accounts GitHub marks as bots need no listing; unset names none. |
| `trustedRoles` | No | Comma-separated GitHub author associations trusted to change a backlog issue's revision, and whose comment on an issue means a maintainer is already on it; defaults to `OWNER,MEMBER,COLLABORATOR`. |
| `maxRevisionsPerWindow` | No | Maximum revision-marked reports one backlog issue may receive inside the rolling `revisionWindowMs` window; defaults to the queue's revision budget. |
| `revisionWindowMs` | No | Length of the rolling window the revision budget counts against, in milliseconds; defaults to the queue's revision window (24 hours). |
| `backlogWallClockBudgetMs` | No | Wall-clock budget for the whole backlog loop, in milliseconds; defaults to 5h 30m so one job stays under GitHub's 6-hour cap. The loop stops taking new issues once the remaining time can no longer fit one more issue's own investigation budget. |
| `executors` | No | Comma-separated executor names the analysis session may use: `browser_extension`, the executor of a module `blockerModules` plugs in, or several; empty means `browser_extension` alone. |
| `blockerModules` | No | Blocker module manifests to plug in, one per line or comma-separated, relative to the workspace. See [Plug in another blocker](../guides/github-action.md#plug-in-another-blocker). |
| `instructionPath` | No | Path of the run instruction file, relative to the checkout; when unset, the checkout's default instruction at `.github/filters-agent/AGENTS.md` is loaded when present. |
| `artifactsDir` | No | Directory the run writes its artifacts to; defaults to `filters-agent-artifacts/artifacts` under the checkout. |
| `model` | No | Reasoning-model slug overriding the configured model; vision follows it when `llmVisionModel` is unset. |
| `noComment` | No | `'true'` skips posting the report as an issue comment; the report is still written to the artifacts directory. |
| `force` | No | `'true'` for a run a maintainer triggered, by label or by a manual dispatch: a maintainer's comment, an assignee or an in-progress label on the issue no longer skips the run or keeps the report silent. A closed issue, a fix referenced, an excluded label and a report already posted for the issue's current text still do. The backlog mode ignores it. |
| `screenshotsBranch` | No | Branch the before and after screenshots of a verified rule are committed to, so the report comment can show them; defaults to `filters-agent-screenshots`. Needs the `contents: write` permission; without it the report posts without screenshots. |
| `lintCommand` | No | Your repository's own lint command line, for example `npx aglint`. Each candidate rule is linted with it in the checkout; a failure adds a note to the report and never stops the rule. Unset runs no lint. See [Lint with your repository's linter](../guides/github-action.md#lint-with-your-repositorys-linter). |
| `checkoutPath` | No | Path of the analyzed checkout; defaults to the runner's `GITHUB_WORKSPACE`. |
| `githubToken` | No | GitHub API token the run reads issues with; in practice mandatory in every run, since the action only serves GitHub-read modes — a missing token fails the job named, even together with `noComment`. |
| `llmBaseUrl` | Yes | OpenAI chat-completions or Anthropic Messages API base URL; for Anthropic use `https://api.anthropic.com` without `/v1`. |
| `llmApi` | No | LLM API for both model roles: `openai-completions` or `anthropic-messages`; defaults to `openai-completions`. |
| `llmApiKey` | Yes | API key of the LLM provider; pass it from a repository secret. |
| `llmModel` | Yes | Default reasoning-model slug for the run's LLM sessions. |
| `llmVisionModel` | No | Model slug used for screenshot steps; defaults to the effective reasoning model, including the `model` override. When unset, that model must also accept images. |
| `llmContextWindowTokens` | Yes | Context window of the reasoning model, in tokens, as your provider states it. |
| `llmMaxOutputTokens` | Yes | Completion cap sent with the reasoning model's requests, in tokens: the model's own limit at your provider. |
| `llmVisionMaxOutputTokens` | When `llmVisionModel` differs from `llmModel` | Completion cap sent with the vision model's requests, in tokens. When `llmVisionModel` is unset or both inputs name one model, it is `llmMaxOutputTokens`. |
| `llmReasoningEffort` | No | Reasoning effort of the investigation's requests: `off`, `minimal`, `low`, `medium` or `high`; defaults to `high`. On Anthropic, `off` omits thinking; a model that thinks by default keeps thinking. |
| `llmSingleShotReasoningEffort` | No | Reasoning effort of the one-question calls (reading the issue, describing a screenshot), same values; defaults to `low`. On Anthropic with loop effort on, `off` sends disabled thinking on reasoning-enabled entries: Claude Opus 5.5 and Sonnet 5.5 reject it with HTTP 400, while Haiku 5.5 accepts it. |
| `llmRequestMaxAttempts` | No | Total attempts per LLM request when the provider fails transiently (a 5xx, a timeout, a response cut off mid-stream), 1 to 3; defaults to 2. Raise it to 3 for a gateway that drops responses more than once in a row. |

## Outputs

| Output | Description |
| --- | --- |
| `artifacts-dir` | Directory the run wrote its artifacts to, relative to the checkout; feed it to `actions/upload-artifact`. |
| `status` | How the run sealed: `success`, `partial_failure` (backlog runs with per-issue failures), or `failed`. |
