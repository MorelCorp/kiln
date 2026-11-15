#!/usr/bin/env bash
# Privacy and secret check for a PUBLIC repo.
#
#   check-private.sh --staged   files staged for commit (used by .githooks/pre-commit)
#   check-private.sh --all      every tracked file (run before pushing)
#
# Three checks:
#   1. Forbidden file names (env files, keys, local config).
#   2. Secret patterns (built in here) plus gitleaks when it is installed.
#   3. Private terms from $KILN_HOME/private-terms.txt (kept outside the repo; one
#      case-insensitive extended regex per line, '#' comments allowed).
set -euo pipefail

mode="${1:---staged}"
root="$(git rev-parse --show-toplevel)"
cd "$root"
kiln_home="${KILN_HOME:-$HOME/.config/kiln}"
terms_file="$kiln_home/private-terms.txt"
fail=0
red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }

case "$mode" in
  --staged) mapfile -t files < <(git diff --cached --name-only --diff-filter=ACMR) ;;
  --all)    mapfile -t files < <(git ls-files) ;;
  *) echo "usage: $0 [--staged|--all]" >&2; exit 2 ;;
esac
[ "${#files[@]}" -eq 0 ] && exit 0

# Content of a file as it will be committed (staged blob), or as tracked.
content() {
  if [ "$mode" = "--staged" ]; then git show ":$1" 2>/dev/null; else cat -- "$1"; fi
}

# 1. Forbidden file names
for f in "${files[@]}"; do
  base="$(basename "$f")"
  case "$base" in
    .env.example) ;;
    .env|.env.*|*.pem|*.key|*.p12|*.pfx|id_rsa*|id_ed25519*|*.kubeconfig|kiln.config.json|private-terms.txt)
      red "BLOCKED file name: $f"; fail=1 ;;
  esac
done

# 2. Secret patterns
secret_re='(sk-ant-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
for f in "${files[@]}"; do
  if content "$f" | grep -I -n -E -q -- "$secret_re"; then
    red "BLOCKED secret-like value in $f (line(s): $(content "$f" | grep -I -n -E -o -- "$secret_re" | cut -d: -f1 | tr '\n' ' '))"
    fail=1
  fi
done
if command -v gitleaks >/dev/null 2>&1; then
  if [ "$mode" = "--staged" ]; then
    gitleaks protect --staged --redact --no-banner -l warn || { red "BLOCKED by gitleaks"; fail=1; }
  else
    gitleaks detect --source . --redact --no-banner -l warn || { red "BLOCKED by gitleaks (history)"; fail=1; }
  fi
else
  echo "note: gitleaks not installed; only the built-in secret patterns ran." >&2
fi

# 3. Private terms
if [ ! -f "$terms_file" ]; then
  red "Missing $terms_file: create it (one private term per line) before committing."
  exit 1
fi
terms_re="$(grep -v -E '^\s*(#|$)' "$terms_file" | paste -sd '|' -)"
if [ -n "$terms_re" ]; then
  for f in "${files[@]}"; do
    # Check the path itself and the content.
    if printf '%s\n' "$f" | grep -i -E -q -- "$terms_re"; then
      red "BLOCKED private term in file path: $f"; fail=1
    fi
    hits="$(content "$f" | grep -I -i -n -E -o -- "$terms_re" | head -5 | tr '\n' ' ' || true)"
    if [ -n "$hits" ]; then
      red "BLOCKED private term(s) in $f -> $hits"; fail=1
    fi
  done
fi

if [ "$fail" -ne 0 ]; then
  red "Commit refused: this repo is public. Move private content to \$KILN_HOME (see CLAUDE.md)."
  exit 1
fi
echo "check-private: ${#files[@]} file(s) clean." >&2
