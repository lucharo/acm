#!/usr/bin/env bash
# Regenerate the docs site's real captures: CLI output (docs/snippets/*.txt) and
# screenshots (docs/assets/*.webp) of seed/docs-demo.md served by a throwaway ACM.
#
#   bash scripts/docs-capture.sh            # build the SPA, then capture
#   SKIP_BUILD=1 bash scripts/docs-capture.sh
#
# Everything runs against a copy in a temp dir with its own XDG_CONFIG_HOME, on a
# random free port in 12001-12499, so it never touches a real document, the
# instance registry or port 12000. macOS only (sips, BSD sed); needs bun,
# agent-browser and cwebp on PATH.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
snippets="$repo/docs/snippets"
assets="$repo/docs/assets"
mkdir -p "$snippets" "$assets"

work="$(mktemp -d)"
export XDG_CONFIG_HOME="$work/config"
mkdir -p "$XDG_CONFIG_HOME" "$work/bin" "$work/docs"
unset ACM_DOC ACM_AUTHOR ACM_PORT
# No Tailscale discovery: the captures must not carry this machine's host name.
export ACM_ALLOWED_HOSTS=""
printf '#!/usr/bin/env bash\nexec bun "%s/cli.ts" "$@"\n' "$repo" > "$work/bin/acm"
chmod +x "$work/bin/acm"
export PATH="$work/bin:$PATH"

# Record "$ <command>" plus its real output (stdout and stderr) in a snippet file.
# capture expects the command to succeed; capture_fail expects it to fail (an error
# example). Either way the snippet is replaced only when the exit matches, so a
# regression stops the script instead of committing an error message as an example.
run_capture() {
  local expect="$1" name="$2"; shift 2
  local out="$snippets/$name.txt" tmp="$work/$name.txt" status=0
  local shown="" arg
  for arg in "$@"; do
    case "$arg" in *[[:space:]\'\"\?\*\$]*) arg="\"$arg\"" ;; esac
    shown="$shown${shown:+ }$arg"
  done
  printf '$ %s\n' "$shown" > "$tmp"
  (cd "$work/docs" && "$@" >> "$tmp" 2>&1) || status=$?
  if { [ "$expect" = ok ] && [ "$status" -ne 0 ]; } || { [ "$expect" = fail ] && [ "$status" -eq 0 ]; }; then
    echo "capture $name: unexpected exit $status (wanted $expect):" >&2
    cat "$tmp" >&2
    exit 1
  fi
  # Snapshot paths carry a temp dir and a timestamp; keep only the doc-relative part.
  sed -e "s#/private$work/docs/##g" -e "s#$work/docs/##g" "$tmp" > "$out"
  echo "captured $name"
}
capture() { run_capture ok "$@"; }
capture_fail() { run_capture fail "$@"; }

cd "$work/docs"
cp "$repo/seed/docs-demo.md" morning-walk.md

capture help acm --help
capture overview acm
capture threads acm threads --doc morning-walk.md
capture comment acm comment "the iron bridge" "Which bridge? There are two." --doc morning-walk.md --author Sam
capture reply acm reply "Which bridge" "The one by the lock." --doc morning-walk.md
capture suggest acm suggest "the only part of the day" "the one part of the day" --doc morning-walk.md
capture accept acm accept "I walk without headphones" --doc morning-walk.md
capture accept-group acm accept --group time --doc morning-walk.md
capture resolve acm resolve "worth saying how often" --doc morning-walk.md
capture spell acm spell --doc morning-walk.md
capture spell-suggest acm spell suggest --doc morning-walk.md
capture spell-help acm spell --help
capture_fail no-doc acm threads
capture_fail ambiguous acm suggest "ten minutes" "a quarter of an hour" --doc morning-walk.md

# Screenshots of a fresh copy, served by a throwaway instance.
mkdir -p "$work/shots" && cp "$repo/seed/docs-demo.md" "$work/shots/morning-walk.md"
if [ -z "${SKIP_BUILD:-}" ]; then (cd "$repo" && bun run build >/dev/null); fi
port=""
for _ in $(seq 1 50); do
  candidate=$((12001 + RANDOM % 499))
  if ! lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; then port="$candidate"; break; fi
done
[ -n "$port" ] || { echo "no free port in 12001-12499" >&2; exit 1; }

(cd "$repo" && ACM_PORT="$port" ACM_DOC="$work/shots/morning-walk.md" exec bun run server.ts) > "$work/server.log" 2>&1 &
server=$!
editor=""
cleanup() {
  for pid in $server $editor; do kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
  agent-browser --session acm-docs-capture close >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM
served=""
for _ in $(seq 1 120); do
  kill -0 "$server" 2>/dev/null || break
  # Our server, not another ACM that took the port: /api/doc names our temp copy.
  if curl -sf --max-time 2 "http://127.0.0.1:$port/api/doc" 2>/dev/null | grep -q "$work/shots/morning-walk.md"; then served=1; break; fi
  sleep 0.5
done
[ -n "$served" ] || { echo "screenshot server never answered on :$port:" >&2; cat "$work/server.log" >&2; exit 1; }

# `acm edit` startup output: a real editor on its own port, stopped once it is ready.
edit_port=""
for _ in $(seq 1 50); do
  candidate=$((12001 + RANDOM % 499))
  if [ "$candidate" != "$port" ] && ! lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; then edit_port="$candidate"; break; fi
done
[ -n "$edit_port" ] || { echo "no free editor port in 12001-12499" >&2; exit 1; }
(cd "$work/docs" && exec acm edit notes.md --no-open --port "$edit_port") > "$work/edit.log" 2>&1 &
editor=$!
ready=""
for _ in $(seq 1 120); do
  if grep -q "ACM ready" "$work/edit.log"; then ready=1; break; fi
  kill -0 "$editor" 2>/dev/null || break
  sleep 0.5
done
kill "$editor" 2>/dev/null || true
wait "$editor" 2>/dev/null || true
editor=""
if [ -z "$ready" ]; then
  echo "capture edit: acm edit never printed 'ACM ready':" >&2
  cat "$work/edit.log" >&2
  exit 1
fi
{ printf '$ acm edit notes.md\n'; cat "$work/edit.log"; } \
  | sed -e "s#/private$work/docs/#/Users/you/writing/#g" -e "s#$work/docs/#/Users/you/writing/#g" \
        -e "s#:$edit_port#:12000#g" > "$snippets/edit.txt"
echo "captured edit"

ab() { agent-browser --session acm-docs-capture "$@" >/dev/null; }
ab set viewport 1440 900 2
ab open "http://127.0.0.1:$port/"
sleep 2
ab screenshot "$assets/editor-desktop.png"

# A suggestion group's card with its "Apply all" popover open, cropped from a tall view.
ab set viewport 1440 1500 2
ab reload
sleep 2
ab eval "[...document.querySelectorAll('button')].find(b => /· \\d+ edits/.test(b.textContent)).click()"
sleep 1
rect="$(agent-browser --session acm-docs-capture eval "(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Apply all')); const r = b.parentElement.parentElement.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round).join(' '); })()" | tr -d '"')"
read -r rx ry rw rh <<< "$rect"
ab screenshot "$work/tall.png"
# Crop (device pixels = 2x CSS): the popover plus the group card underneath it.
sips -c $(( (rh + 190) * 2 )) $(( (rw + 50) * 2 )) --cropOffset $(( (ry - 8) * 2 )) $(( (rx - 25) * 2 )) \
  "$work/tall.png" --out "$assets/suggestion-group.png" >/dev/null
ab set viewport 390 844 3
ab reload
sleep 2
ab screenshot "$assets/editor-mobile.png"
# Ship WebP: the three captures fit in a few hundred KB instead of ~1 MB of PNG.
for png in editor-desktop editor-mobile suggestion-group; do
  cwebp -quiet -q 85 "$assets/$png.png" -o "$assets/$png.webp" || { echo "cwebp failed on $png.png" >&2; exit 1; }
  rm "$assets/$png.png"
done
echo "screenshots → $assets (port $port)"
