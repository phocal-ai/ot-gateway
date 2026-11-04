#!/usr/bin/env bash
# The GitHub CLI as the scheduled Health agent sees it (.github/workflows/health.yml,
# prompt in .github/prompts/health.md). The agent may run this script and not `gh`.
#
#   issue list    [--state open|closed|all] [--limit N] [--json FIELDS]
#   issue view    N
#   issue create  --title TITLE --body BODY
#   issue comment N --body BODY
#   issue close   N [--comment BODY]
#   label create  health [--color RRGGBB] [--description TEXT]
#
# Scope, so the job's reach follows from code rather than from the prompt:
# - Every issue it lists, views, comments on or closes carries the `health` label.
# - It shows only text written by github-actions[bot], the account the workflow
#   files issues as: issue titles and bodies by anyone else are replaced by a note,
#   and other comments are left out.
# - New issues always get the label, their body starts with a `<!-- health:<key> -->`
#   marker, and a run creates at most 5 (counted under $RUNNER_TEMP).
# - Text it writes must not contain the value of a credential or of the Grafana URL
#   from the job's environment. Values are compared, never printed.
#
# Anything else exits 2 with a short message. scripts/test-health-gh.sh tests it.
set -euo pipefail

readonly label="health"
readonly max_creates=5
# How `gh --json` names the Actions bot (GITHUB_TOKEN writes): an issue author is
# `app/github-actions` with `is_bot: true`, a comment author is `github-actions`.
readonly jq_bot='
  def issue_by_bot: .author.login == "app/github-actions" and (.author.is_bot | . == null or . == true);
  def comment_by_bot: .author.login == "github-actions";'
readonly private_vars="CLAUDE_CODE_OAUTH_TOKEN GRAFANA_MCP_READ_TOKEN GRAFANA_MCP_URL GH_TOKEN"
readonly list_fields=" number title body state url createdAt updatedAt closedAt labels "
readonly hidden="(not shown: not written by github-actions[bot])"

refuse() {
  echo "health-gh: $*" >&2
  exit 2
}

usage() {
  refuse "allowed: issue list [--state S] [--limit N] [--json FIELDS] | issue view N |" \
    "issue create --title T --body B | issue comment N --body B | issue close N [--comment B] |" \
    "label create health [--color RRGGBB] [--description D]"
}

require_number() {
  local pattern='^[1-9][0-9]{0,9}$'
  [[ ${1:-} =~ $pattern ]] || refuse "expected an issue number, got '${1:-}'"
}

# Reads the value of the flag in $1 (`--name value` or `--name=value`) into
# $flag_value and the number of arguments it took into $flag_used.
read_flag() {
  case $1 in
    --*=*)
      flag_value=${1#*=}
      flag_used=1
      ;;
    *)
      [ $# -ge 2 ] || refuse "$1 needs a value"
      flag_value=$2
      flag_used=2
      ;;
  esac
}

# Text that is about to become public must not contain a credential or the Grafana
# URL (nor its host name).
require_public() {
  local text=$1 name value host
  for name in $private_vars; do
    value=${!name:-}
    [ -n "$value" ] || continue
    [[ $text != *"$value"* ]] || refuse "the text contains the value of \$$name; leave it out"
    if [ "$name" = GRAFANA_MCP_URL ]; then
      host=${value#*://}
      host=${host%%/*}
      host=${host##*@}
      host=${host%%:*}
      [ -z "$host" ] || [[ $text != *"$host"* ]] || refuse "the text contains the Grafana host name; leave it out"
    fi
  done
}

has_label() {
  jq -e --arg label "$label" 'any(.labels[]?; .name == $label)' >/dev/null
}

require_health_issue() {
  local labels
  labels=$(gh issue view "$1" --json labels)
  has_label <<<"$labels" || refuse "issue #$1 does not carry the '$label' label"
}

# Takes the next of the $max_creates slots for this run. A slot is a file created
# with noclobber, so two calls at once cannot take the same one.
reserve_create() {
  local dir="${RUNNER_TEMP:?RUNNER_TEMP is not set}/health-gh-creates" slot
  mkdir -p "$dir"
  for slot in $(seq 1 "$max_creates"); do
    if (set -o noclobber && : >"$dir/$slot") 2>/dev/null; then
      return 0
    fi
  done
  refuse "this run already created $max_creates issues; list the rest in the report instead"
}

issue_list() {
  local state=open limit=30 fields="number,title" field
  local -a requested
  while [ $# -gt 0 ]; do
    case $1 in
      --label | --label=*)
        read_flag "$@"
        [ "$flag_value" = "$label" ] || refuse "issue list only lists '$label' issues"
        shift "$flag_used"
        ;;
      --state | --state=*)
        read_flag "$@"
        case $flag_value in
          open | closed | all) state=$flag_value ;;
          *) refuse "--state is open, closed or all" ;;
        esac
        shift "$flag_used"
        ;;
      --limit | --limit=*)
        read_flag "$@"
        [[ $flag_value =~ ^[1-9][0-9]{0,2}$ ]] || refuse "--limit is a number from 1 to 999"
        limit=$flag_value
        shift "$flag_used"
        ;;
      --json | --json=*)
        read_flag "$@"
        fields=$flag_value
        shift "$flag_used"
        ;;
      *) refuse "issue list does not take '$1'" ;;
    esac
  done
  local fields_pattern='^[a-zA-Z]+(,[a-zA-Z]+)*$'
  [[ $fields =~ $fields_pattern ]] || refuse "--json takes comma-separated field names:$list_fields"
  IFS=, read -r -a requested <<<"$fields"
  for field in "${requested[@]}"; do
    [[ $list_fields == *" $field "* ]] || refuse "--json fields are:$list_fields"
  done
  gh issue list --label "$label" --state "$state" --limit "$limit" --json "$fields,author" |
    jq "$jq_bot"' map(select(issue_by_bot) | del(.author))'
}

issue_view() {
  [ $# -eq 1 ] || refuse "usage: issue view N (comments are always included)"
  require_number "$1"
  local issue
  issue=$(gh issue view "$1" --json number,title,state,author,body,labels,comments)
  has_label <<<"$issue" || refuse "issue #$1 does not carry the '$label' label"
  jq --arg hidden "$hidden" "$jq_bot"'
    {
      number,
      state,
      title: (if issue_by_bot then .title else $hidden end),
      body: (if issue_by_bot then .body else $hidden end),
      comments: [.comments[]? | select(comment_by_bot) | { createdAt, body }]
    }' <<<"$issue"
}

issue_create() {
  local title="" body=""
  while [ $# -gt 0 ]; do
    case $1 in
      --title | --title=*)
        read_flag "$@"
        title=$flag_value
        shift "$flag_used"
        ;;
      --body | --body=*)
        read_flag "$@"
        body=$flag_value
        shift "$flag_used"
        ;;
      --label | --label=*)
        read_flag "$@"
        [ "$flag_value" = "$label" ] || refuse "issue create only adds the '$label' label"
        shift "$flag_used"
        ;;
      *) refuse "issue create takes only --title and --body, not '$1'" ;;
    esac
  done
  [ -n "$title" ] || refuse "issue create needs --title"
  [ -n "$body" ] || refuse "issue create needs --body"
  case ${body%%$'\n'*} in
    "<!-- health:"*) ;;
    *) refuse "the body's first line must be the <!-- health:<key> --> marker" ;;
  esac
  require_public "$title"
  require_public "$body"
  reserve_create
  gh issue create --title "$title" --body "$body" --label "$label"
}

issue_comment() {
  require_number "${1:-}"
  local number=$1 body=""
  shift
  while [ $# -gt 0 ]; do
    case $1 in
      --body | --body=*)
        read_flag "$@"
        body=$flag_value
        shift "$flag_used"
        ;;
      *) refuse "issue comment takes only --body, not '$1'" ;;
    esac
  done
  [ -n "$body" ] || refuse "issue comment needs --body"
  require_public "$body"
  require_health_issue "$number"
  gh issue comment "$number" --body "$body"
}

issue_close() {
  require_number "${1:-}"
  local number=$1 comment="" has_comment=0
  shift
  while [ $# -gt 0 ]; do
    case $1 in
      --comment | --comment=*)
        read_flag "$@"
        comment=$flag_value
        has_comment=1
        shift "$flag_used"
        ;;
      *) refuse "issue close takes only --comment, not '$1'" ;;
    esac
  done
  [ "$has_comment" = 0 ] || [ -n "$comment" ] || refuse "--comment needs text"
  [ "$has_comment" = 0 ] || require_public "$comment"
  require_health_issue "$number"
  if [ "$has_comment" = 1 ]; then
    gh issue close "$number" --comment "$comment"
  else
    gh issue close "$number"
  fi
}

label_create() {
  [ "${1:-}" = "$label" ] || refuse "label create only creates the '$label' label"
  shift
  local -a args=()
  while [ $# -gt 0 ]; do
    case $1 in
      --color | --color=*)
        read_flag "$@"
        [[ $flag_value =~ ^[0-9A-Fa-f]{6}$ ]] || refuse "--color is six hex digits, such as D93F0B"
        args+=(--color "$flag_value")
        shift "$flag_used"
        ;;
      --description | --description=*)
        read_flag "$@"
        require_public "$flag_value"
        args+=(--description "$flag_value")
        shift "$flag_used"
        ;;
      --force | -f) refuse "label create never overwrites a label (no --force)" ;;
      *) refuse "label create takes only --color and --description, not '$1'" ;;
    esac
  done
  gh label create "$label" ${args[@]+"${args[@]}"}
}

[ $# -ge 2 ] || usage
command="$1 $2"
shift 2
case $command in
  "issue list") issue_list "$@" ;;
  "issue view") issue_view "$@" ;;
  "issue create") issue_create "$@" ;;
  "issue comment") issue_comment "$@" ;;
  "issue close") issue_close "$@" ;;
  "label create") label_create "$@" ;;
  *) usage ;;
esac
