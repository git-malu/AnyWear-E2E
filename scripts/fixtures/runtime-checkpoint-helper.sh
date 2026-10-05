#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" == 1 && "$1" == '--runtime-checkpoint-protocol' ]]; then printf 'v1\n'; exit 0; fi
scope="${RUNTIME_DRILL_RUN_SCOPE:?}"
purpose="${2:?}"
definition="arn:aws:ecs:ap-east-1:650880818323:task-definition/beta-anywear-${purpose}:1"
task='arn:aws:ecs:ap-east-1:650880818323:task/beta-anywear/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
ack() {
  local expected="runtime-checkpoint-v1:${scope}:$1:$2" received=''
  printf 'Runtime checkpoint: %s\n' "$expected"
  IFS= read -r -t 5 received
  [[ "$received" == "$expected" ]]
}
printf 'Task definition: %s\n' "$definition"
ack definition "$definition"
printf 'Task ARN: %s\n' "$task"
ack task "$task"
