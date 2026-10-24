#!/usr/bin/env bash
# Classify a change set so CI can skip the heavy gates for documentation-only work.
#
# Usage: classify-change-set.sh --ref <git-ref> <base> <head>
#
# Prints exactly one line: `true` (the heavy gates must run) or `false` (documentation only).
#
# FAIL-CLOSED. Every uncertainty — a tag push, a missing/unusable base, an unresolvable object,
# a failing `git diff`, unexpected arguments — prints `true`. Only a *successful* decision that
# *every* changed path is documentation prints `false`.
#
# Documentation means:
#   * anything under `docs/` (including the JS/CSS prototypes kept there — nothing under `docs/`
#     is an input to an app build or to the browser suite), or
#   * a Markdown file at the repository root: `README.md`, `AGENTS.md`, …
#
# Markdown *elsewhere* is deliberately NOT documentation. `app/test/fixtures/*.md` and
# `app/test/fixtures/**/Notes/*.md` are consumed by the markdown/render gates, and `app/README.md`
# sits next to the code it documents, so a change there must run the heavy gates.
#
# The path list is read from a file with `-z` (NUL-delimited) rather than through a pipeline:
# `grep -q` exits at its first match, and with `pipefail` the resulting SIGPIPE used to look like
# "every path matched the docs pattern" on large change sets. `--no-renames` keeps renames honest:
# a move from code into `docs/` must surface as a delete of the old path plus an add of the new one.

set -euo pipefail

ref=""
if [[ "${1:-}" == "--ref" ]]; then
  ref="${2:-}"
  shift 2
fi
base="${1:-}"
head_ref="${2:-}"

if [[ "${ref}" == refs/tags/* ]]; then
  # Tags feed the release gate, which must always see real results.
  echo true
  exit 0
fi

zero_sha="0000000000000000000000000000000000000000"
if [[ -z "${base}" || -z "${head_ref}" || "${base}" == "${zero_sha}" ]]; then
  echo true
  exit 0
fi

if ! git cat-file -e "${base}^{commit}" 2>/dev/null || ! git cat-file -e "${head_ref}^{commit}" 2>/dev/null; then
  echo true
  exit 0
fi

tmp="$(mktemp)"
trap 'rm -f "${tmp}"' EXIT

if ! git diff --name-only --no-renames -z "${base}...${head_ref}" > "${tmp}"; then
  echo true
  exit 0
fi

code=false
while IFS= read -r -d '' changed_path; do
  [[ -z "${changed_path}" ]] && continue
  if [[ "${changed_path}" == docs/* ]]; then continue; fi
  if [[ "${changed_path}" != */* && "${changed_path}" == *.md ]]; then continue; fi
  code=true
  break
done < "${tmp}"

echo "${code}"
