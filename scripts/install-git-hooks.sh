#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -d .git ]; then echo 'NG: Gitリポジトリではありません' >&2; exit 1; fi
if [ ! -f "$HOME/.config/payroll/private-terms.txt" ] && [ -z "${PAYROLL_PRIVATE_TERMS_B64:-}" ]; then
  echo 'NG: $HOME/.config/payroll/private-terms.txt を作成し、個人固有の禁止語句を1行1件で記入してください。' >&2
  echo '禁止語句の内容はGitへコミットしないでください。' >&2
  exit 1
fi
if ! command -v gitleaks >/dev/null 2>&1; then echo 'NG: brew install gitleaks が必要です' >&2; exit 1; fi
git config --local core.hooksPath .githooks
test "$(git config --local --get core.hooksPath)" = '.githooks'
echo '[Payroll] Git pre-commit / pre-push hooks enabled.'
