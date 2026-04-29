# Docker Runner Worker Rollout and Rollback Runbook

Sogyo canary 기준으로 bangtong/dungae/nosuk 확대 배포와 rollback 절차를 정리한 운영 문서.

브로커 PR #167 (feature-flag routing) 및 #168 (default scope narrowing) 의 핸들러
변경사항과 `a2a-docker-runner` MVP 런타임을 전제로 한다.

## 1. Architecture

```text
A2A Broker → Host A2A Worker (systemd) → Handler MJS → a2a-docker-runner CLI → Docker container
                                                                        │
                                                    /var/lib/openclaw-a2a/tasks/<task-id>/
                                                    ├── task.json
                                                    ├── run.sh
                                                    └── artifacts/
                                                        ├── summary.txt
                                                        ├── command-0.log
                                                        └── ...
```

각 A2A task 는 호스트 워커가 broker 로부터 claim 한 후 handler MJS
(`scripts/openclaw-a2a-task-handler.mjs`) 를 거친다. handler 는
`shouldUseDockerRunner()` 로 docker-runner 라우팅 여부를 결정한 뒤,
runner 가 Docker container 를 띄워 격리된 `/work` 아래서 repo clone →
`npm ci` → `npm test` → command 실행을 수행하고 결과를 반환한다.

## 2. Feature Flags

### 2.1 `A2A_DOCKER_RUNNER_ENABLED=1`

worker handler 의 docker-runner 진입 gate. `0` 또는 미설정 시 handler 는
기존 built-in 경로 (OpenClaw session dispatch) 만 사용한다.

```bash
# /etc/default/openclaw-a2a-worker
A2A_DOCKER_RUNNER_ENABLED=1
```

`A2A_DOCKER_RUNNER_ENABLED=1` 이더라도 **intent 가 `propose_patch` /
`github-propose-patch` 인 task 만** runner routing 대상이다.
`chat`, `analyze`, `backfill`, `validate_change` 등 다른 intent 는 항상
기존 built-in handler 경로로 처리된다 (PR #167, #168).

### 2.2 `A2A_DOCKER_RUNNER_ALL_GITHUB=1`

기본값은 **plugin-only scope** 이다. handler 의 `shouldUseDockerRunner()` 는
다음 조건을 모두 만족할 때만 runner 로 라우팅한다:

- `A2A_DOCKER_RUNNER_ENABLED=1` 이고
- task repo 가 `openclaw-plugin-a2a` 를 포함하거나 preset 이 `openclaw-plugin-a2a-dev` 인 경우

범용 GitHub repo (예: `jinon86/seoyoon-family-wiki`) 에 대한 docker-runner
라우팅은 위 조건에 해당하지 않으므로 **built-in handler 로 폴백**된다.

**명시적 opt-in 이 필요할 때만** `A2A_DOCKER_RUNNER_ALL_GITHUB=1` 을 설정한다.

```bash
# /etc/default/openclaw-a2a-worker — plugin-only scope 유지 (권장)
A2A_DOCKER_RUNNER_ALL_GITHUB=0   # 미설정 시 기본값 0

# 모든 GitHub propose_patch task 를 runner 로 라우팅 (opt-in)
A2A_DOCKER_RUNNER_ALL_GITHUB=1
```

### 2.3 Routing Decision Table

| Env | Task Intent | Task Repo/Preset | Route |
|---|---|---|---|
| `ENABLED=0` or unset | any | any | built-in handler |
| `ENABLED=1`, `ALL_GITHUB=0` | `propose_patch` | `.../openclaw-plugin-a2a` | docker-runner |
| `ENABLED=1`, `ALL_GITHUB=0` | `propose_patch` | `jinon86/a2a-broker` | built-in handler |
| `ENABLED=1`, `ALL_GITHUB=1` | `propose_patch` | any GitHub repo | docker-runner |
| `ENABLED=1` | `chat`, `analyze`, `backfill` | any | built-in handler |

## 3. Runtime Environment Variables

### 3.1 Worker Env (기존 `/etc/default/openclaw-a2a-worker`)

```bash
# feature gate
A2A_DOCKER_RUNNER_ENABLED=1
A2A_DOCKER_RUNNER_ALL_GITHUB=0           # plugin-only scope

# runner CLI 경로 — handler 가 spawn 하는 binary
A2A_DOCKER_RUNNER_BIN=/usr/bin/node
A2A_DOCKER_RUNNER_ARGS_JSON='["/opt/a2a-docker-runner/dist/cli.js"]'

# task root — host 쪽 작업 디렉토리 root
A2A_DOCKER_RUNNER_ROOT=/var/lib/openclaw-a2a/tasks

# GitHub token mount source
A2A_DOCKER_RUNNER_GITHUB_TOKEN_FILE=/root/.config/gh/hosts.yml

# task-level timeout (handler → runner)
A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS=2700000   # 45분

# container-level timeout (runner → docker run)
A2A_DOCKER_RUNNER_TIMEOUT_MS=2700000        # 45분

# resource cap
A2A_DOCKER_RUNNER_MEMORY=2g
A2A_DOCKER_RUNNER_CPUS=2
```

### 3.2 Requester Env (broker discovery)

```bash
A2A_DOCKER_RUNNER_BIN=/usr/bin/node
A2A_DOCKER_RUNNER_ARGS_JSON='["/path/to/cli.js"]'
```

Runner CLI 는 handler spawn 시 요청 노드의 환경변수에서 읽는다.
위 값들이 존재하지 않으면 handler 는 runner routing 을 skip 하고
기존 built-in 경로로 폴백한다.

### 3.3 Token Mount

`A2A_DOCKER_RUNNER_GITHUB_TOKEN_FILE` 이 설정되어 있고 파일이 존재하면,
runner 는 다음 docker args 를 추가한다:

```text
-v <GITHUB_TOKEN_FILE>:/run/secrets/gh-hosts.yml:ro
-e GH_CONFIG_HOSTS=/run/secrets/gh-hosts.yml
```

컨테이너 내 `run.sh` script 는 `gh-hosts.yml` 에서 `oauth_token` 값을
추출하여 `GIT_ASKPASS` helper 로 등록한다. 파일은 **read-only** 로 마운트되며,
`x-access-token` username + token password 조합으로 git 인증을 수행한다.

Token file 은 `gh auth login` 으로 생성된 표준 `hosts.yml` 을 그대로
사용한다. 파일이 없거나 읽을 수 없으면 token mount 는 skip 되고 git
fetch/clone 이 실패할 수 있다.

### 3.4 Task Root (`A2A_DOCKER_RUNNER_ROOT`)

기본값: `/var/lib/openclaw-a2a/tasks`

Runner 는 task 별로 `$ROOT/<safe-task-id>/` 하위에 격리된 work directory 를
생성한다. directory 는 `chmod 700` 으로 생성되며 container 실행 시
`-v $WORK_DIR:/work` 로 마운트된다. container 종료 후 artifact 는
host 쪽 work directory 에 남고, 다음 task 실행 시 runner 가
`rm -rf` 후 재생성한다.

### 3.5 Timeout / Resource Cap

| Setting | Default | Env | 적용 위치 |
|---|---|---|---|
| Task timeout | 15 min | `A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS` | handler → runner spawn |
| Container timeout | 15 min | `A2A_DOCKER_RUNNER_TIMEOUT_MS` | runner → `docker run` |
| Memory limit | 2 GB | `A2A_DOCKER_RUNNER_MEMORY` | `docker run --memory` |
| CPU limit | 2 cores | `A2A_DOCKER_RUNNER_CPUS` | `docker run --cpus` |

Timeout 초과 시 runner 는 SIGTERM → 5초 후 SIGKILL 로 container 를 종료한다.
Runner result 의 `status` 는 `"timeout"`, `ok` 는 `false` 로 반환된다.

## 4. Sogyo Canary Smoke

Sogyo 는 최초 canary node 로서 `A2A_DOCKER_RUNNER_ENABLED=1` (plugin-only scope, `ALL_GITHUB=0`) 상태로
운영 중이다. 신규 worker 를 추가하거나 rollout 확대 전에 다음 smoke check 를 수행한다.

### 4.1 Pre-flight Health

```bash
# worker service 상태
systemctl status openclaw-a2a-worker --no-pager -l | head -20

# broker health
curl -sf https://broker.seoyoon-family.com/health | jq .

# worker 등록 확인
curl -sf https://broker.seoyoon-family.com/workers/sogyo \
  -H "x-a2a-requester-id: sogyo" \
  -H "x-a2a-requester-kind: node" \
  -H "x-a2a-requester-role: operator" | jq .
```

기대값: `GET /health` → `status: "ok"`, worker → `status: "online"`,
`lastSeenAt` 이 30초 이내.

### 4.2 Runner Doctor Check

```bash
cd /opt/a2a-docker-runner && node dist/cli.js doctor
```

기대값:

```json
{
  "ok": true,
  "config": {
    "rootDir": "/var/lib/openclaw-a2a/tasks",
    "engine": "docker",
    "image": "node:22-bookworm-slim",
    "githubTokenFile": "configured",
    "defaultTimeoutMs": 900000,
    "memory": "2g",
    "cpus": "2"
  }
}
```

`engine` 이 `docker` 또는 `podman` 인지 확인하고, `githubTokenFile` 이
`"configured"` 로 표시되는지 확인한다.

### 4.3 Plugin Dev Preset Smoke (standalone)

```bash
cd /opt/a2a-docker-runner
node dist/cli.js run examples/task.openclaw-plugin-a2a.json
```

기대값:

```json
{
  "ok": true,
  "taskId": "example-openclaw-plugin-a2a-dev",
  "status": "completed",
  "workDir": "/var/lib/openclaw-a2a/tasks/example-openclaw-plugin-a2a-dev",
  "exitCode": 0,
  "stdout": "...",
  "artifacts": [
    "/var/lib/openclaw-a2a/tasks/.../artifacts/summary.txt",
    "/var/lib/openclaw-a2a/tasks/.../artifacts/task.json",
    "/var/lib/openclaw-a2a/tasks/.../artifacts/command-0.log",
    "/var/lib/openclaw-a2a/tasks/.../artifacts/command-1.log"
  ]
}
```

- `status: "completed"`, `ok: true`
- `exitCode: 0`
- artifact 에 `summary.txt` 와 `command-*.log` 포함

### 4.4 Live Task Smoke (broker → worker → runner)

```bash
TASK_ID=$(uuidgen | tr 'A-Z' 'a-z')
curl -sf -X POST https://broker.seoyoon-family.com/tasks \
  -H 'content-type: application/json' \
  -H 'x-a2a-requester-id: sogyo' \
  -H 'x-a2a-requester-kind: node' \
  -H 'x-a2a-requester-role: operator' \
  -d "{
    \"id\": \"$TASK_ID\",
    \"intent\": \"propose_patch\",
    \"mode\": \"github-propose-patch\",
    \"repo\": \"jinon86/openclaw-plugin-a2a\",
    \"message\": \"Sogyo docker-runner smoke — verify PR/Block evidence\",
    \"target\": { \"id\": \"sogyo\", \"role\": \"analyst\", \"kind\": \"node\" },
    \"requester\": { \"id\": \"sogyo\", \"role\": \"operator\", \"kind\": \"node\" }
  }" | jq .

# task 완료 대기 후 확인
sleep 30
curl -sf https://broker.seoyoon-family.com/tasks/$TASK_ID \
  -H 'x-a2a-requester-id: sogyo' \
  -H 'x-a2a-requester-kind: node' \
  -H 'x-a2a-requester-role: operator' | jq .
```

기대값: `status: "succeeded"`, `result.output.github` 에 `prUrl` 또는
`doneCommentUrl` 또는 `blockCommentUrl` 포함.

### 4.5 Smoke Pass Criteria

| Check | Method | Pass Condition |
|---|---|---|
| Worker online | `GET /workers/sogyo` | `status: "online"`, `lastSeenAt` < 30s |
| Runner doctor | `cli.js doctor` | `ok: true`, engine detected, token configured |
| Standalone preset | `cli.js run examples/task.openclaw-plugin-a2a.json` | `status: "completed"`, `ok: true`, `exitCode: 0` |
| Broker live task | `POST /tasks` → poll `GET /tasks/:id` | `status: "succeeded"`, GitHub evidence present |

## 5. Rollout — bangtong / dungae / nosuk

### 5.1 Prerequisites (per node)

각 노드에 다음이 준비되어 있어야 한다:

1. **Docker** (`docker --version`) 또는 **Podman** 설치
2. **Node 22+**
3. **`a2a-docker-runner`** 설치: `/opt/a2a-docker-runner/` 에 repo clone
   후 `npm ci && npm run build`
4. **GitHub token** (`gh auth login` → `~/.config/gh/hosts.yml` 존재)
5. **OpenClaw A2A worker** (`openclaw-a2a-worker.service`) 가 설치되어
   있고 `scripts/openclaw-a2a-task-handler.mjs` (version >= 0.2.0) 배포 완료

### 5.2 Enable Docker Runner (plugin-only scope)

각 노드의 `/etc/default/openclaw-a2a-worker` 에 추가:

```bash
A2A_DOCKER_RUNNER_ENABLED=1
A2A_DOCKER_RUNNER_ALL_GITHUB=0
A2A_DOCKER_RUNNER_BIN=/usr/bin/node
A2A_DOCKER_RUNNER_ARGS_JSON='["/opt/a2a-docker-runner/dist/cli.js"]'
A2A_DOCKER_RUNNER_ROOT=/var/lib/openclaw-a2a/tasks
A2A_DOCKER_RUNNER_GITHUB_TOKEN_FILE=/root/.config/gh/hosts.yml
A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS=2700000
A2A_DOCKER_RUNNER_TIMEOUT_MS=2700000
A2A_DOCKER_RUNNER_MEMORY=2g
A2A_DOCKER_RUNNER_CPUS=2
```

적용:

```bash
systemctl daemon-reload
systemctl restart openclaw-a2a-worker
systemctl status openclaw-a2a-worker --no-pager
```

### 5.3 Post-Enable Smoke (per node)

각 노드 활성화 후 broker 를 통해 live task smoke 수행:

```bash
TASK_ID=$(uuidgen | tr 'A-Z' 'a-z')
curl -sf -X POST https://broker.seoyoon-family.com/tasks \
  -H 'content-type: application/json' \
  -H 'x-a2a-requester-id: sogyo' \
  -H 'x-a2a-requester-kind: node' \
  -H 'x-a2a-requester-role: operator' \
  -d "{
    \"id\": \"$TASK_ID\",
    \"intent\": \"propose_patch\",
    \"mode\": \"github-propose-patch\",
    \"repo\": \"jinon86/openclaw-plugin-a2a\",
    \"message\": \"$NODE docker-runner smoke — verify PR/Block evidence\",
    \"target\": { \"id\": \"$NODE\", \"role\": \"analyst\", \"kind\": \"node\" },
    \"requester\": { \"id\": \"sogyo\", \"role\": \"operator\", \"kind\": \"node\" }
  }" | jq .
```

`$NODE` 를 `bangtong`, `dungae`, `nosuk` 으로 각각 치환하여 실행.

### 5.4 Rollout Order

1. **Sogyo** — 이미 canary 통과 (기준선)
2. **Dungae** — VPS0, 리소스 여유 있음, 차선 확대 대상
3. **Nosuk** — VPS2, 신규 노드, 리소스 여유 확인 후 확대
4. **Bangtong** — VPS3, Codex CLI harness 의존 노드, runner 간섭
   확인 후 마지막 확대

### 5.5 Rollout Gate

**전체 rollout 은 runner evidence executor 가 안정화될 때까지 보류한다.**

현재 Sogyo 에서 `A2A_DOCKER_RUNNER_ENABLED=1` (plugin-only scope) 상태로
canary 검증 중이며, runner 가 GitHub-mode task 에서 PR/Block evidence 를
일관되게 생성할 수 있음이 확인된 후에 bangtong/dungae/nosuk 확대를
진행한다.

Gate 조건:

- Sogyo 에서 docker-runner 로 처리된 task 의 성공률 ≥ 90% (최근 5건 기준)
- Runner 결과의 `prUrl` / `doneCommentUrl` / `blockCommentUrl` 중 하나가
  항상 존재
- Docker container OOM kill, timeout, image pull 실패가 연속 2회 이상
  발생하지 않음
- Runner task root (`/var/lib/openclaw-a2a/tasks`) 디스크 사용량이
  노드 용량의 30% 미만

## 6. Failure Rollback

### 6.1 Per-Node Rollback

runner 가 문제를 일으키는 단일 노드의 경우:

```bash
# /etc/default/openclaw-a2a-worker 수정
A2A_DOCKER_RUNNER_ENABLED=0

# worker 재시작
systemctl daemon-reload
systemctl restart openclaw-a2a-worker

# rollback 확인
systemctl status openclaw-a2a-worker --no-pager
```

Worker 는 즉시 기존 built-in handler 경로로 폴백한다.
이미 claim 되어 container 가 실행 중인 task 는 timeout 까지 완료되거나
handler timeout 으로 kill 된다. 새로 claim 하는 task 부터
built-in 경로가 적용된다.

### 6.2 Global Rollback

모든 노드에서 runner 를 비활성화해야 하는 경우:

1. 각 노드 `/etc/default/openclaw-a2a-worker` 에서 `A2A_DOCKER_RUNNER_ENABLED=0`
2. `systemctl restart openclaw-a2a-worker`
3. Broker `GET /workers` 로 모든 worker 가 `online` 인지 확인
4. Broker `GET /tasks?status=queued&status=claimed&status=running` 으로
   stale task 없는지 확인

### 6.3 Cleanup

Rollback 후 docker 잔여 리소스 정리 (선택):

```bash
# 완료된 container 정리
docker container prune -f

# runner task directory 정리
rm -rf /var/lib/openclaw-a2a/tasks/*
```

### 6.4 Rollback Decision Matrix

| Symptom | Scope | Action |
|---|---|---|
| Runner `doctor` 실패 (docker 미설치) | 단일 노드 | 해당 노드 rollback, docker 설치 후 재시도 |
| Container OOM kill 반복 | 단일 노드 | `A2A_DOCKER_RUNNER_MEMORY` 증량 또는 rollback |
| Token mount 실패 (`github_auth=hosts.yml` 누락) | 단일 노드 | `gh auth login` 재실행, token file 경로 확인 |
| Image pull 실패 (network) | 단일 노드 | `docker pull node:22-bookworm-slim` 수동 실행 |
| Runner task timeout 연속 발생 | 단일 노드 | `A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS` 증량 또는 rollback |
| Broker task stuck (`claimed` 상태 지속) | 단일 노드 | `POST /tasks/requeue_stale` + 해당 노드 rollback |
| Multiple 노드 동시 장애 | Global | Global rollback, 근본 원인 조사 후 재배포 |

## 7. Worker Status / Broker Task Verification

### 7.1 Worker Health Routine

```bash
# worker service 상태
systemctl status openclaw-a2a-worker --no-pager -l

# worker journal 최근 로그
journalctl -u openclaw-a2a-worker --since "5 min ago" --no-pager

# broker worker 등록 상태
curl -sf https://broker.seoyoon-family.com/workers/$NODE \
  -H "x-a2a-requester-id: sogyo" \
  -H "x-a2a-requester-kind: node" \
  -H "x-a2a-requester-role: operator" | jq '{ workerId, status, lastSeenAt, activeTaskCount }'
```

### 7.2 Docker Runner Task Verification

```bash
# runner task root 현황
ls -la /var/lib/openclaw-a2a/tasks/
du -sh /var/lib/openclaw-a2a/tasks/

# 최근 runner task 로그 확인
cat /var/lib/openclaw-a2a/tasks/*/task.json 2>/dev/null | jq . | head -30
cat /var/lib/openclaw-a2a/tasks/*/artifacts/summary.txt 2>/dev/null | tail -30
```

### 7.3 Broker Task Audit

```bash
# broker health + stale reaper status
curl -sf https://broker.seoyoon-family.com/health | jq '{ status, stateVersion, staleReaper }'

# 특정 task audit trail
TASK_ID="..."
curl -sf https://broker.seoyoon-family.com/audit?targetId=$TASK_ID \
  -H "x-a2a-requester-id: sogyo" \
  -H "x-a2a-requester-kind: node" \
  -H "x-a2a-requester-role: operator" | jq .

# 노드별 active task
curl -sf https://broker.seoyoon-family.com/tasks?status=running&status=claimed \
  -H "x-a2a-requester-id: sogyo" \
  -H "x-a2a-requester-kind: node" \
  -H "x-a2a-requester-role: operator" | jq '[.[] | { id, status, assignedWorkerId }]'
```

### 7.4 Runner-to-Broker Evidence Verification

```bash
# runner 결과에서 PR URL 추출
cat /var/lib/openclaw-a2a/tasks/<task-id>/artifacts/summary.txt

# broker task result 확인
curl -sf https://broker.seoyoon-family.com/tasks/<task-id> \
  -H "x-a2a-requester-id: sogyo" \
  -H "x-a2a-requester-kind: node" \
  -H "x-a2a-requester-role: operator" | jq '{ status, result: .result.output.github }'
```

기대값: `result.output.github.prUrl` 또는 `doneCommentUrl` 또는
`blockCommentUrl` 중 하나가 존재하고 runner artifact 의 PR URL 과
일치해야 한다.

## 8. Yukson Exclusion Policy

**Yukson (VPS2 legacy) 노드는 docker-runner rollout 대상에서 영구 제외한다.**

### 8.1 근거

- Yukson 은 과거 VPS2 memory-pressure history 가 있는 노드로,
  docker daemon + container 조합의 메모리 부담을 감당할 수 없다.
- Round 9 Wake-on-Task canary 에서도 yukson 은 resource pressure 로
  false-negative 를 냈고, 이후 모든 rollout 에서 제외 정책이 적용되었다.
- 현재 VPS2 에는 `nosuk` 이라는 새로운 논리 노드를 할당하여
  신규 서비스 수용 및 확장 실험을 담당하게 한다.

### 8.2 정책

| 대상 | 상태 |
|---|---|
| `yukson` | **영구 제외** — docker-runner never enable |
| `nosuk` (VPS2) | rollout 대상 포함, 리소스 확인 후 확대 |

### 8.3 Enforcement

Worker `WORKER_ID` 가 `yukson` 인 경우, 환경변수 설정과 무관하게
handler 는 docker-runner routing 을 skip 한다.

```bash
# /etc/default/openclaw-a2a-worker (yukson / nosuk 구분)
WORKER_ID=nosuk       # VPS2 — docker-runner 대상
# WORKER_ID=yukson    # 사용하지 않음 (legacy, 영구 제외)
```

Yukson worker 가 broker 에 등록된 경우 `GET /workers/yukson` 으로
확인하고, 더 이상 사용하지 않으면 broker operator 가 worker record 를
정리한다.

## 9. Reference

- `docs/github-development-loop.md` — GitHub-mode task contract 및
  evidence 요구사항
- `docs/session-isolation.md` — A2A full-handler worker 의 session
  isolation contract
- `docs/wake-on-task-live-canary-runbook.md` — 유사 rollout runbook 패턴
  참고
- `docs/smoke-compose.md` — compose smoke reference
- `scripts/openclaw-a2a-task-handler.mjs` — versioned handler artifact (>= 0.2.0)
- `a2a-docker-runner` README — runner CLI 및 preset 상세

## 10. Quick Reference Card

```text
┌─────────────────────────────────────────────────────────┐
│ DOCKER RUNNER ROLLOUT QUICK REF                         │
├─────────────────────────────────────────────────────────┤
│ Env flags:                                              │
│   A2A_DOCKER_RUNNER_ENABLED=1      gate                 │
│   A2A_DOCKER_RUNNER_ALL_GITHUB=0   plugin-only (default)│
│   A2A_DOCKER_RUNNER_ALL_GITHUB=1   all GitHub (opt-in)  │
│                                                         │
│ Rollout order: Sogyo → Dungae → Nosuk → Bangtong        │
│ Excluded: Yukson (영구 제외)                            │
│ Gate: runner evidence executor 안정화까지 보류          │
│                                                         │
│ Smoke:                                                  │
│   node dist/cli.js doctor                               │
│   node dist/cli.js run examples/task.openclaw...json    │
│   POST /tasks (broker live task)                        │
│                                                         │
│ Rollback (per-node):                                    │
│   A2A_DOCKER_RUNNER_ENABLED=0                           │
│   systemctl restart openclaw-a2a-worker                 │
│                                                         │
│ Verify:                                                 │
│   curl /workers/<node>                                  │
│   curl /audit?targetId=<taskId>                         │
│   journalctl -u openclaw-a2a-worker                     │
└─────────────────────────────────────────────────────────┘
```
