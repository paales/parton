#!/usr/bin/env bash
# Boot both preview servers (e2e-testing on :5173, e2e-magento on :5181)
# concurrently. SIGINT / SIGTERM in this script tears down both
# children AND their grandchildren (yarn spawns node, node spawns vite).
#
# Usage: yarn preview:all (after `yarn build:all`).
#
# Both servers preview the most recent `vite build` output for their
# respective workspaces. The host's <RemoteFrame> hard-codes the
# magento origin to http://localhost:5181, which matches the magento
# preview port pinned in `e2e-magento/vite.config.ts`.

set -e

# Run children in a NEW process group so a single kill can reach
# every descendant (yarn → node → vite). Without this, SIGINT to
# the script kills the yarn shim but the vite preview grandchild
# detaches and keeps holding the port.
start_in_pgroup() {
  # macOS / Linux: `set -m` enables job control so each `&`-spawned
  # job becomes its own process group leader.
  set -m
}
start_in_pgroup

cleanup() {
  trap '' INT TERM
  # Kill direct children first (the yarn wrappers).
  for pid in "${PIDS[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  # Then kill anything still bound to our ports — yarn's grandchildren
  # (vite preview) can detach from the process group, so the PID-based
  # kill doesn't always reach them.
  sleep 0.5
  for port in 5173 5181; do
    leftover=$(lsof -ti :"$port" 2>/dev/null || true)
    if [ -n "$leftover" ]; then
      kill -TERM $leftover 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM EXIT

PIDS=()

echo "→ booting e2e-magento preview on :5181"
yarn workspace @parton/e2e-magento preview &
PIDS+=($!)

echo "→ booting e2e-testing preview on :5173"
yarn workspace @parton/e2e-testing preview &
PIDS+=($!)

echo ""
echo "Both preview servers running."
echo "  host:    http://localhost:5173/"
echo "  magento: http://localhost:5181/__remote/magento-greeting"
echo ""
echo "Hit Ctrl-C to stop both."
echo ""

# Wait on either; if either exits, the trap kills the survivor.
wait -n "${PIDS[@]}"
