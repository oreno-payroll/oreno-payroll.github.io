#!/usr/bin/env bash
# stdout = normal, deletion-only (exit 10), or reject. No tests are skipped for a real push.
set -euo pipefail
head="${1:?expected checked-out commit}"
[[ "$head" =~ ^[0-9a-f]{40}$ ]] || exit 1
saw_update=0
saw_delete=0
saw_any=0
while read -r local_ref local_sha remote_ref remote_sha; do
 [[ -n "${local_ref:-}" ]] || continue
 saw_any=1
 if [[ "$local_ref" == '(delete)' && "$local_sha" =~ ^0{40}$ &&
       "$remote_ref" == refs/heads/feature/payroll-* && "$remote_sha" =~ ^[0-9a-f]{40}$ ]]; then
   saw_delete=1
   continue
 fi
 if [[ ! "$local_ref" =~ ^refs/heads/[a-zA-Z0-9_./-]+$ ||
       "$local_ref" == *..* || "$local_ref" == */.*/\* ||
       "$local_sha" != "$head" || "$remote_ref" != refs/heads/* ||
       ! "$remote_sha" =~ ^[0-9a-f]{40}$ ]]; then
   echo "NG: push対象が検証中のHEADと違うか、安全なrefではありません: $local_ref" >&2
   exit 1
 fi
 saw_update=1
done
[[ "$saw_any" -eq 1 ]] || { echo 'NG: empty pre-push ref list' >&2;exit 1; }
# Git sends zero SHA for a deletion: no source is sent, so running a source
# audit would be meaningless. Every real update still requires full audit.
if [[ "$saw_update" -eq 0 && "$saw_delete" -eq 1 ]]; then exit 10; fi
exit 0
