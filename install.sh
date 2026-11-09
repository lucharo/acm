#!/bin/sh
# Installs ACM from a GitHub release: the standalone `acm` binary and the
# acm-review agent skill. Needs neither Bun nor Node.
#
#   curl -fsSL https://raw.githubusercontent.com/lucharo/acm/main/install.sh | sh
#
# ACM_VERSION      release tag to install (default: the latest release)
# ACM_INSTALL_DIR  where `acm` goes (default: ~/.local/bin)
# ACM_FORCE=1      replace an existing `acm` that ACM did not install
# ACM_RELEASE_URL  download from this base URL instead of GitHub

set -eu

fail() {
  printf 'acm install: %s\n' "$1" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

detect_platform() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin)
      # A shell running under Rosetta reports x86_64 on Apple silicon.
      if [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
        arch=arm64
      fi
      case "$arch" in
        arm64) echo darwin-arm64 ;;
        x86_64) echo darwin-x64 ;;
        *) fail "no ACM build for macOS on $arch" ;;
      esac
      ;;
    Linux)
      [ "$arch" = x86_64 ] || fail "no ACM build for Linux on $arch"
      echo linux-x64
      ;;
    *) fail "no ACM build for $os" ;;
  esac
}

download() {
  curl -fsSL --retry 3 -o "$tmp/$1" "$base/$1" || fail "could not download $base/$1"
}

verify() {
  expected=$(awk -v name="$1" '$2 == name { print $1 }' "$tmp/SHA256SUMS")
  [ -n "$expected" ] || fail "SHA256SUMS does not list $1"
  [ "$(sha256 "$tmp/$1")" = "$expected" ] || fail "checksum mismatch for $1; nothing was installed"
}

is_managed() {
  [ -f "$1.acm-managed" ] && [ "$(cat "$1.acm-managed")" = "$(sha256 "$1")" ]
}

install_binary() {
  mkdir -p "$install_dir"
  cp "$tmp/$asset" "$partial"
  chmod 755 "$partial"
  "$partial" --help >/dev/null || fail "the downloaded acm does not run on this machine"
  # Rename rather than copy over the old binary: macOS kills a binary whose
  # inode kept a stale code signature.
  mv -f "$partial" "$target"
  sha256 "$target" >"$target.acm-managed"
  chmod 600 "$target.acm-managed"
}

# Succeeds when $2 needs writing, after moving a differing copy into backups.
prepare_skill_target() {
  mkdir -p "$(dirname "$2")"
  [ -e "$2" ] || [ -L "$2" ] || return 0
  diff -r -x .acm-managed "$1" "$2" >/dev/null 2>&1 && return 1
  mkdir -p "$HOME/.agents/skill-backups"
  backup="$HOME/.agents/skill-backups/$3-$(date +%s)-$$"
  mv "$2" "$backup" || fail "could not move $2 aside"
  printf 'Moved your previous %s skill to %s\n' "$3" "$backup"
}

install_skill() {
  mkdir -p "$tmp/skill"
  tar -xzf "$tmp/acm-review-skill.tar.gz" -C "$tmp/skill"
  skill="$tmp/skill/acm-review"

  universal="$HOME/.agents/skills/acm-review"
  if prepare_skill_target "$skill" "$universal" acm-review; then
    cp -R "$skill" "$universal"
  fi

  claude="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/acm-review"
  if prepare_skill_target "$skill" "$claude" claude-acm-review; then
    ln -s "$universal" "$claude"
  fi
}

main() {
  [ -n "${HOME:-}" ] || fail "HOME is not set"
  need curl
  need tar
  command -v sha256sum >/dev/null 2>&1 || need shasum

  repo=https://github.com/lucharo/acm
  if [ -n "${ACM_VERSION:-}" ]; then
    default_base="$repo/releases/download/$ACM_VERSION"
  else
    default_base="$repo/releases/latest/download"
  fi
  base=${ACM_RELEASE_URL:-$default_base}

  asset="acm-$(detect_platform)"
  install_dir=${ACM_INSTALL_DIR:-$HOME/.local/bin}
  install_dir=${install_dir%/}
  target="$install_dir/acm"
  partial="$target.tmp-$$"

  if { [ -e "$target" ] || [ -L "$target" ]; } && [ "${ACM_FORCE:-}" != 1 ] && ! is_managed "$target"; then
    fail "$target already exists and is not ACM; set ACM_FORCE=1 to replace it or ACM_INSTALL_DIR to install elsewhere"
  fi

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp" "$partial"' EXIT
  trap 'exit 1' INT TERM

  printf 'Downloading %s\n' "$asset"
  download SHA256SUMS
  download "$asset"
  download acm-review-skill.tar.gz
  verify "$asset"
  verify acm-review-skill.tar.gz

  install_binary
  install_skill

  printf '\nACM installed: %s\n' "$target"
  printf 'The acm-review skill is installed for Codex and Claude Code.\n'

  case ":$PATH:" in
    *":$install_dir:"*)
      found=$(command -v acm || true)
      if [ "$found" != "$target" ]; then
        printf '\nWarning: acm currently runs %s. Put %s earlier on PATH.\n' "$found" "$install_dir"
      fi
      ;;
    *)
      printf '\n%s is not on your PATH. Add this to your shell profile:\n' "$install_dir"
      # shellcheck disable=SC2016 # The profile line must keep $PATH unexpanded.
      printf '  export PATH="%s:$PATH"\n' "$install_dir"
      ;;
  esac

  printf '\nOpen a document:\n  acm edit notes.md\n'
}

# Nothing runs until the whole script has arrived, so a cut-off download is harmless.
main
