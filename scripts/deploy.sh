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

# Guesty issues 5 OAuth tokens per 24h per client, shared with local dev
# servers, resetting at midnight UTC. This guard used to count DEPLOYS, on the
# premise that "every deploy is a fresh container with an empty disk, so it has
# to ask Guesty for a new token". That stopped being true when
# guesty-token-handoff.js landed: Render keeps the old container serving until
# the new one is healthy, so a booting container reads the token the live site
# already holds and spends nothing. Deploys and spent slots are now different
# quantities, and counting the wrong one refused safe deploys while saying
# nothing about the quota that actually matters.
#
# So the cap counts MINTS, recorded per deploy from the new container's own
# /api/guesty/token-status (mintCount), which guesty.js increments at the single
# point a token is actually issued. A deploy that adopts the peer's token logs
# mint=0 and costs nothing against the cap. Old log lines have no mint= field
# and are counted as one mint each, which is what they were.
DEPLOY_LOG=".deploy-log"
MAX_MINTS_PER_UTC_DAY=4   # of Guesty's 5, leaving one for an unplanned restart
TODAY_UTC="$(date -u +%Y-%m-%d)"
mints_today() {
  awk -v d="$TODAY_UTC" '
    $1 == d {
      m = 1                                   # legacy line: assume it minted
      for (i = 1; i <= NF; i++) if ($i ~ /^mint=[0-9]+$/) { split($i, kv, "="); m = kv[2] }
      total += m
    }
    END { print total + 0 }
  ' "$DEPLOY_LOG" 2>/dev/null || echo 0
}
MINTS_TODAY="$(mints_today)"
if [ "$MINTS_TODAY" -ge "$MAX_MINTS_PER_UTC_DAY" ] && [ "${FORCE_DEPLOY:-0}" != "1" ]; then
  echo "ERROR: $MINTS_TODAY Guesty OAuth tokens already minted on $TODAY_UTC (UTC); cap is $MAX_MINTS_PER_UTC_DAY of 5." >&2
  echo "A deploy only mints when the live site cannot hand its token over. Wait for 00:00 UTC, or rerun with FORCE_DEPLOY=1" >&2
  echo "only if you have confirmed the real remaining quota." >&2
  exit 1
fi
echo "==> Guesty OAuth slots minted today (UTC): $MINTS_TODAY of $MAX_MINTS_PER_UTC_DAY allowed"

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
DEPLOY_LOG_LINE="$TODAY_UTC $(date -u +%H:%M:%S) $LOCAL_SHA"

echo "==> Waiting for $SITE_URL to report commit $LOCAL_SHA (up to ${MAX_WAIT_SECONDS}s)..."
ELAPSED=0
while [ "$ELAPSED" -lt "$MAX_WAIT_SECONDS" ]; do
  LIVE_SHA="$(curl -sS --max-time 10 "$SITE_URL/api/version" 2>/dev/null | grep -o '"commit":"[a-f0-9]*"' | cut -d'"' -f4 || true)"
  if [ "$LIVE_SHA" = "$LOCAL_SHA" ]; then
    echo "==> DEPLOYED. Live commit matches: $LIVE_SHA"
    # Ask the container that just booted whether it had to spend a slot. Only
    # booleans and counters cross the wire here — never the token itself.
    MINTED="$(curl -sS --max-time 10 "$SITE_URL/api/guesty/token-status" 2>/dev/null \
      | grep -o '"mintCount":[0-9]*' | cut -d: -f2 || true)"
    MINTED="${MINTED:-1}"   # unreadable status: assume the worst, never undercount
    echo "$DEPLOY_LOG_LINE mint=$MINTED" >> "$DEPLOY_LOG"
    if [ "$MINTED" = "0" ]; then
      echo "==> Guesty: no OAuth slot spent (token adopted from the live site)."
    else
      echo "==> Guesty: this deploy minted $MINTED token(s). Today's total is now $(mints_today) of $MAX_MINTS_PER_UTC_DAY."
    fi
    exit 0
  fi
  echo "    [$ELAPSED s] live=${LIVE_SHA:-<none yet>} target=$LOCAL_SHA — waiting..."
  sleep "$POLL_INTERVAL_SECONDS"
  ELAPSED=$((ELAPSED + POLL_INTERVAL_SECONDS))
done

# A deploy that never reported live may still have booted and minted. Record it
# pessimistically rather than losing the slot from the tally.
echo "$DEPLOY_LOG_LINE mint=1 (unverified: deploy timed out)" >> "$DEPLOY_LOG"
echo "ERROR: timed out after ${MAX_WAIT_SECONDS}s waiting for deploy $LOCAL_SHA to go live." >&2
echo "Check the Render dashboard for build/deploy errors." >&2
exit 1
