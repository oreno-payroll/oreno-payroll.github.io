#!/usr/bin/env bash
# Git history scan. Runs locally; no secret value is recorded in the repository.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v gitleaks >/dev/null 2>&1; then
  echo 'Gitleaksが見つかりません。Macでは brew install gitleaks で導入してください。' >&2
  exit 2
fi
if [[ "$(git -C "$ROOT" rev-parse --is-shallow-repository)" == "true" ]]; then
  echo 'Shallow cloneのため全履歴を検査できません。完全な履歴を取得してから再実行してください。' >&2
  exit 2
fi
printf '%s\n' 'Git全履歴をGitleaksで検査します（検出値はマスク、リポジトリにレポート出力なし）。'
exec gitleaks git --redact --log-opts="--all" "$ROOT"
