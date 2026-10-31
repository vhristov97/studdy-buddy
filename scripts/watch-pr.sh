#!/usr/bin/env bash
# Watches a PR for Devin review activity; one stdout line per event (for Claude Code's Monitor tool).
# Usage: scripts/watch-pr.sh <pr-number>
# Emits: "NEW <inline|issue|review> id=… reply_to=… path=… :: <body excerpt>" for each new Devin item,
#        "RESOLVED: …" once Devin posts "All Devin Review issues are resolved.",
#        "PR closed/merged" and exits when the PR is closed.
set -u
PR="${1:?usage: watch-pr.sh <pr-number>}"
R="repos/$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
PHRASE="All Devin Review issues are resolved"

seen=$( {
  gh api "$R/pulls/$PR/comments?per_page=100" --jq '.[].id'
  gh api "$R/issues/$PR/comments?per_page=100" --jq '.[].id'
  gh api "$R/pulls/$PR/reviews?per_page=100" --jq '.[].id'
} 2>/dev/null | sort)
resolved_sent=0

while true; do
  all=$( {
    gh api "$R/pulls/$PR/comments?per_page=100" --jq '.[] | select(.user.login | test("devin")) | "inline\t\(.id)\t\(.in_reply_to_id // "new")\t\(.path)\t\(.body | gsub("<!--[^>]*-->"; "") | gsub("\\s+"; " ") | .[0:200])"'
    gh api "$R/issues/$PR/comments?per_page=100" --jq '.[] | select(.user.login | test("devin")) | "issue\t\(.id)\t-\t-\t\(.body | gsub("<!--[^>]*-->"; "") | gsub("<[^>]*>"; "") | gsub("\\s+"; " ") | .[0:200])"'
    gh api "$R/pulls/$PR/reviews?per_page=100" --jq '.[] | select(.user.login | test("devin")) | "review\t\(.id)\t-\t-\t\(.body | gsub("<!--[^>]*-->"; "") | gsub("<[^>]*>"; "") | gsub("\\s+"; " ") | .[0:200])"'
  } 2>/dev/null || true)
  while IFS=$'\t' read -r kind id rep path body; do
    [ -z "$id" ] && continue
    if ! grep -qx "$id" <<<"$seen"; then
      echo "NEW $kind id=$id reply_to=$rep path=$path :: $body"
      seen=$(printf '%s\n%s' "$seen" "$id")
    fi
  done <<<"$all"
  if [ "$resolved_sent" -eq 0 ] && grep -qF "$PHRASE" <<<"$all"; then
    echo "RESOLVED: Devin says all issues are resolved"
    resolved_sent=1
  fi
  st=$(gh api "$R/pulls/$PR" --jq '.state' 2>/dev/null || echo "?")
  [ "$st" = "closed" ] && { echo "PR closed/merged"; exit 0; }
  sleep 60
done
