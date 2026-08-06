#!/bin/sh
set -eu

runtime_root="${DANO_RUNTIME_DIR:-/opt/dano/runtime-data}"
agent_dir="${PI_CODING_AGENT_DIR:-$runtime_root/.pi/agent}"
export PI_CODING_AGENT_DIR="$agent_dir"
runtime_defaults_dir="${DANO_RUNTIME_DEFAULTS_DIR:-/app/deploy/runtime-defaults}"
skill_seed_dir="${DANO_SKILL_SEED_DIR:-/app/open-websearch-skill-seed/.agents/skills}"
agent_skills_dir="${DANO_SKILLS_DIR:-$agent_dir/skills}"
entrypoint_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
npm_registry="${NPM_REGISTRY:-${NPM_CONFIG_REGISTRY:-${DANO_DEFAULT_NPM_REGISTRY:-https://mirrors.cloud.tencent.com/npm/}}}"

mkdir -p "$agent_dir"

if command -v npm >/dev/null 2>&1; then
  npm config set registry "$npm_registry" >/dev/null
fi

if command -v pnpm >/dev/null 2>&1; then
  pnpm config set registry "$npm_registry" >/dev/null
fi

copy_default_if_missing() {
  file_name="$1"
  source_path="$runtime_defaults_dir/$file_name"
  target_path="$agent_dir/$file_name"

  if [ ! -f "$source_path" ]; then
    echo "[dano-entrypoint] warning: missing runtime default: $source_path" >&2
    return 0
  fi

  if [ -f "$target_path" ]; then
    return 0
  fi

  cp "$source_path" "$target_path"
}

system_prompt_source="$runtime_defaults_dir/SYSTEM.md"
system_prompt_target="$agent_dir/SYSTEM.md"
if [ ! -f "$system_prompt_source" ]; then
  echo "[dano-entrypoint] warning: missing runtime default: $system_prompt_source" >&2
elif [ ! -f "$system_prompt_target" ]; then
  node "$entrypoint_dir/render-system-prompt.mjs" \
    --if-missing \
    "$system_prompt_source" \
    "$system_prompt_target"
fi

copy_default_if_missing "settings.json"
copy_default_if_missing "heimdall.json"
node "$entrypoint_dir/activate-skill-seed.mjs" \
  "$skill_seed_dir" \
  "$agent_skills_dir"

run_with_open_websearch() {
  open_websearch_host="${OPEN_WEBSEARCH_HOST:-127.0.0.1}"
  open_websearch_port="${OPEN_WEBSEARCH_PORT:-3210}"
  open_websearch_url="http://$open_websearch_host:$open_websearch_port"
  open_websearch_attempts=100

  open-websearch serve \
    --host "$open_websearch_host" \
    --port "$open_websearch_port" &
  daemon_pid=$!
  app_pid=""

  stop_children() {
    trap - TERM INT
    if [ -n "$app_pid" ] && kill -0 "$app_pid" 2>/dev/null; then
      kill -TERM "$app_pid" 2>/dev/null || true
    fi
    if kill -0 "$daemon_pid" 2>/dev/null; then
      kill -TERM "$daemon_pid" 2>/dev/null || true
    fi
    if [ -n "$app_pid" ]; then
      wait "$app_pid" 2>/dev/null || true
    fi
    wait "$daemon_pid" 2>/dev/null || true
  }
  trap 'stop_children; exit 143' TERM
  trap 'stop_children; exit 130' INT

  attempt=0
  until open-websearch status --base-url "$open_websearch_url" >/dev/null 2>&1; do
    if ! kill -0 "$daemon_pid" 2>/dev/null; then
      if wait "$daemon_pid"; then daemon_status=1; else daemon_status=$?; fi
      echo "[dano-entrypoint] open-websearch daemon exited during startup" >&2
      return "$daemon_status"
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -ge "$open_websearch_attempts" ]; then
      echo "[dano-entrypoint] open-websearch daemon did not become ready at $open_websearch_url" >&2
      stop_children
      return 1
    fi
    sleep 0.1
  done

  "$@" &
  app_pid=$!

  while kill -0 "$daemon_pid" 2>/dev/null && kill -0 "$app_pid" 2>/dev/null; do
    sleep 0.2
  done

  if ! kill -0 "$app_pid" 2>/dev/null; then
    if wait "$app_pid"; then app_status=0; else app_status=$?; fi
    app_pid=""
    stop_children
    return "$app_status"
  fi

  if wait "$daemon_pid"; then daemon_status=1; else daemon_status=$?; fi
  echo "[dano-entrypoint] open-websearch daemon exited while Dano was running" >&2
  stop_children
  return "$daemon_status"
}

if [ "$#" -eq 0 ]; then
  set -- node ./dist/server/main.js
fi

if [ "$1" = "node" ] && [ "${2:-}" = "./dist/server/main.js" ]; then
  run_with_open_websearch "$@"
  exit $?
fi

exec "$@"
