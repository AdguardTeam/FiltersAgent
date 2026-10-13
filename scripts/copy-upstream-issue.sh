#!/usr/bin/env bash
# Copy one AdguardFilters issue, with its human comments, into a fork and label it so the fork's
# filters-agent workflow analyzes it. The fork is a sandbox for watching the action run on real
# reports without touching the upstream issue.
#
# Nothing in the copy may reach back to the upstream repository: an @mention notifies the person,
# and a cross-repository issue reference or issue URL adds a "mentioned this issue" event to the
# upstream issue's timeline. Every such token is wrapped in a code span, which GitHub renders as
# plain text and never links. Bare #N references are wrapped too: in the fork they would point at
# the fork's own, unrelated issues.
#
# Usage: scripts/copy-upstream-issue.sh <issue-number> <fork-owner/repo> [--no-label]
#
# Environment:
#   UPSTREAM_REPOSITORY  Source repository (default AdguardTeam/AdguardFilters).
#   AGENT_LABEL          Label that starts the fork's workflow (default filters-agent).
#
# Requires `gh` authenticated with write access to the fork's issues, `jq` and `perl`.
set -euo pipefail

usage() {
    echo "Usage: $(basename "$0") <issue-number> <fork-owner/repo> [--no-label]" >&2
    exit 1
}

[[ $# -ge 2 && $# -le 3 ]] || usage
issue_number="$1"
fork="$2"
add_label=true
if [[ $# -eq 3 ]]; then
    [[ "$3" == '--no-label' ]] || usage
    add_label=false
fi
[[ "${issue_number}" =~ ^[0-9]+$ ]] || usage

upstream="${UPSTREAM_REPOSITORY:-AdguardTeam/AdguardFilters}"
label="${AGENT_LABEL:-filters-agent}"

# Wrap every token that would notify someone or link back to another issue in a code span.
# The lookbehinds skip tokens already inside a code span and e-mail addresses.
neutralize() {
    perl -0pe '
        s{(?<![`\w])(https?://github\.com/[\w.-]+/[\w.-]+/(?:issues|pull|discussions)/\d+[^\s)]*)}{`$1`}g;
        s{(?<![`\w/])([\w.-]+/[\w.-]+#\d+)}{`$1`}g;
        s{(?<![`\w/&])(#\d+)\b}{`$1`}g;
        s{(?<![`\w])(@[A-Za-z0-9][A-Za-z0-9-]*)}{`$1`}g;
    '
}

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT

gh api "repos/${upstream}/issues/${issue_number}" > "${workdir}/issue.json"
if jq -e '.pull_request != null' "${workdir}/issue.json" > /dev/null; then
    echo "${upstream}#${issue_number} is a pull request, not an issue." >&2
    exit 1
fi

title="$(jq -r '.title' "${workdir}/issue.json")"
{
    jq -r '.body // ""' "${workdir}/issue.json" | neutralize
    printf '\n\n---\n\nCopied from `%s#%s` for a filters-agent test run.\n' \
        "${upstream}" "${issue_number}"
} > "${workdir}/body.md"

issue_url="$(gh issue create --repo "${fork}" --title "${title}" --body-file "${workdir}/body.md")"
fork_number="${issue_url##*/}"
echo "Created ${issue_url}"

# Bot comments are left behind: the run ignores them anyway, and they would only add noise.
gh api --paginate "repos/${upstream}/issues/${issue_number}/comments" \
    | jq -c '.[] | select(.user.type != "Bot") | {login: .user.login, body: (.body // "")}' \
    > "${workdir}/comments.jsonl"

comment_count=0
while IFS= read -r comment; do
    {
        printf 'Upstream comment by `@%s`:\n\n' "$(jq -r '.login' <<< "${comment}")"
        jq -r '.body' <<< "${comment}" | neutralize
    } > "${workdir}/comment.md"
    gh issue comment "${fork_number}" --repo "${fork}" --body-file "${workdir}/comment.md" > /dev/null
    comment_count=$((comment_count + 1))
done < "${workdir}/comments.jsonl"
echo "Copied ${comment_count} comment(s)"

if [[ "${add_label}" == true ]]; then
    # --force makes the call idempotent: it creates the label once and leaves it alone after.
    gh label create "${label}" --repo "${fork}" --force \
        --description 'Analyze this issue with filters-agent' > /dev/null
    gh issue edit "${fork_number}" --repo "${fork}" --add-label "${label}" > /dev/null
    echo "Labeled ${label}; the fork's workflow starts the run"
fi
