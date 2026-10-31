#!/usr/bin/env bash
# Watches a PR for Devin review activity; one stdout line per event (for Claude Code's Monitor tool).
# Usage: scripts/watch-pr.sh <pr-number>
# Emits: "NEW <inline|issue|review> id=… reply_to=… path=… :: <body excerpt>" for each new Devin item,
#        "EDITED <inline|issue> id=… reply_to=… path=… :: <body excerpt>" when a known inline/issue comment is
#        edited in place later (its updated_at changed; reviews have no updated_at, so they are id-only),
#        "UNRESOLVED <inline|issue> id=… reply_to=… path=… :: <body excerpt>" instead of NEW/EDITED when the item
#        is Devin's "The fix didn't resolve this Devin Review issue" reply (new or edited; the issue-comment
#        variant continues ": <issue title> (<path>:<lines>)"),
#        "RESOLVED: …" once Devin posts "All Devin Review issues are resolved.",
#        "PR closed/merged" and exits when the PR is closed.
set -u
PR="${1:?usage: watch-pr.sh <pr-number>}"
R="repos/$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
PHRASE="All Devin Review issues are resolved"
# Devin's reply when a fix did not resolve its issue; the apostrophe may be straight or curly.
UNRESOLVED_GLOB="The fix didn?t resolve this Devin Review issue*"

# seen: one "<kind>:<id><TAB><updated_at>" record per line (updated_at is "-" for reviews). Records are only
# ever appended and the last one for a key wins, so a failed poll can never wipe or corrupt the state.
seen=$( {
  gh api "$R/pulls/$PR/comments?per_page=100" --jq '.[] | "inline:\(.id)\t\(.updated_at // "-")"'
  gh api "$R/issues/$PR/comments?per_page=100" --jq '.[] | "issue:\(.id)\t\(.updated_at // "-")"'
  gh api "$R/pulls/$PR/reviews?per_page=100" --jq '.[] | "review:\(.id)\t-"'
} 2>/dev/null || true)
resolved_sent=0

while true; do
  # Fields: kind, id, updated_at, reply_to, path, body ("-" placeholders keep tab-splitting from collapsing).
  all=$( {
    gh api "$R/pulls/$PR/comments?per_page=100" --jq '.[] | select(.user.login | test("devin")) | "inline\t\(.id)\t\(.updated_at // "-")\t\(.in_reply_to_id // "new")\t\(.path)\t\(.body | gsub("<!--[^>]*-->"; "") | gsub("\\s+"; " ") | .[0:200])"'
    gh api "$R/issues/$PR/comments?per_page=100" --jq '.[] | select(.user.login | test("devin")) | "issue\t\(.id)\t\(.updated_at // "-")\t-\t-\t\(.body | gsub("<!--[^>]*-->"; "") | gsub("<[^>]*>"; "") | gsub("\\s+"; " ") | .[0:200])"'
    gh api "$R/pulls/$PR/reviews?per_page=100" --jq '.[] | select(.user.login | test("devin")) | "review\t\(.id)\t-\t-\t-\t\(.body | gsub("<!--[^>]*-->"; "") | gsub("<[^>]*>"; "") | gsub("\\s+"; " ") | .[0:200])"'
  } 2>/dev/null || true)
  while IFS=$'\t' read -r kind id upd rep path body; do
    [ -z "$id" ] && continue
    key="$kind:$id"
    prev=$(awk -F'\t' -v k="$key" '$1==k{v=$2; f=1} END{if(f)print v}' <<<"$seen")
    label=""
    if [ -z "$prev" ]; then
      label="NEW"
    elif [ "$prev" != "$upd" ] && [ "$upd" != "-" ]; then
      label="EDITED"
    fi
    if [ -n "$label" ]; then
      trimmed="${body#"${body%%[![:space:]]*}"}"
      # shellcheck disable=SC2254
      case "$trimmed" in $UNRESOLVED_GLOB) label="UNRESOLVED" ;; esac
      echo "$label $kind id=$id reply_to=$rep path=$path :: $body"
      seen=$(printf '%s\n%s\t%s' "$seen" "$key" "$upd")
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
