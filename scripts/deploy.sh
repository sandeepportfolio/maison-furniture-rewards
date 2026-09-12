#!/usr/bin/env bash
# Push the current branch, trigger a Render deploy, and verify it actually
# landed — no browser, no dashboard, no manual polling.
#
# Requires RENDER_DEPLOY_HOOK_URL in .env (Render dashboard -> maison-rewards
# service -> Settings -> Deploy Hook). Verification works because Render sets
# RENDER_GIT_COMMIT on every deploy automatically; server.js exposes it at
# GET /api/version, so this script just waits for that to match the commit
# it pushed.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SITE_URL="https://www.bookwithregent.com"
MAX_WAIT_SECONDS=600
POLL_INTERVAL_SECONDS=15

# Parse .env without sourcing it — some values (e.g. DATABASE-style URLs
# elsewhere in this repo's sibling projects) contain characters the shell
# would otherwise interpret. Simple KEY=VALUE lines only.
RENDER_DEPLOY_HOOK_URL="$(grep -E '^RENDER_DEPLOY_HOOK_URL=' .env 2>/dev/null | head -1 | cut -d= -f2-)"

if [ -z "$RENDER_DEPLOY_HOOK_URL" ]; then
  echo "ERROR: RENDER_DEPLOY_HOOK_URL is not set in .env." >&2
  echo "Get it from the Render dashboard: maison-rewards service -> Settings -> Deploy Hook." >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is not clean. Commit or stash before deploying:" >&2
  git status --short >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  echo "ERROR: on branch '$BRANCH', not 'main'. Render deploys from main." >&2
  exit 1
fi

echo "==> Fetching origin/main..."
git fetch origin main

LOCAL_SHA="$(git rev-parse main)"
REMOTE_SHA="$(git rev-parse origin/main)"

if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  # Only safe to push if we're strictly ahead (fast-forward). If origin moved
  # in a way that isn't an ancestor of our local main, refuse rather than
  # force anything.
  if ! git merge-base --is-ancestor origin/main main; then
    echo "ERROR: origin/main has diverged from local main. Pull/rebase first." >&2
    exit 1
  fi
  echo "==> Pushing main to origin..."
  git push origin main
  LOCAL_SHA="$(git rev-parse main)"
else
  echo "==> origin/main already matches local main ($LOCAL_SHA)."
fi

echo "==> Triggering Render deploy hook..."
DEPLOY_RESPONSE="$(curl -sS -X POST "$RENDER_DEPLOY_HOOK_URL")"
echo "    $DEPLOY_RESPONSE"

echo "==> Waiting for $SITE_URL to report commit $LOCAL_SHA (up to ${MAX_WAIT_SECONDS}s)..."
ELAPSED=0
while [ "$ELAPSED" -lt "$MAX_WAIT_SECONDS" ]; do
  LIVE_SHA="$(curl -sS --max-time 10 "$SITE_URL/api/version" 2>/dev/null | grep -o '"commit":"[a-f0-9]*"' | cut -d'"' -f4 || true)"
  if [ "$LIVE_SHA" = "$LOCAL_SHA" ]; then
    echo "==> DEPLOYED. Live commit matches: $LIVE_SHA"
    exit 0
  fi
  echo "    [$ELAPSED s] live=${LIVE_SHA:-<none yet>} target=$LOCAL_SHA — waiting..."
  sleep "$POLL_INTERVAL_SECONDS"
  ELAPSED=$((ELAPSED + POLL_INTERVAL_SECONDS))
done

echo "ERROR: timed out after ${MAX_WAIT_SECONDS}s waiting for deploy $LOCAL_SHA to go live." >&2
echo "Check the Render dashboard for build/deploy errors." >&2
exit 1
