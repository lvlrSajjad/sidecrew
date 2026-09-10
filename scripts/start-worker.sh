#!/usr/bin/env bash
# Reference for `sidecrew serve` (Phase 1 ports this into src/serve.ts).
set -euo pipefail
KEY="${1:-qwen2.5-coder-7b-4bit}"; PORT="${2:-8000}"
REPO=$(node -p "require(\"$(dirname "$0")/../src/models.json\").models[\"$KEY\"].repo")
mkdir -p .sidecrew
echo "starting $REPO on :$PORT (log: .sidecrew/worker-$PORT.log)"
exec python3 -m mlx_lm.server --model "$REPO" --port "$PORT" >> ".sidecrew/worker-$PORT.log" 2>&1
