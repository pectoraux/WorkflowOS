#!/usr/bin/env bash
# WorkflowOS live cloud deployment verification (DEPLOYMENT HARDENING).
#
# Verifies the REAL deployed topology — Vercel frontend + Railway backend —
# over the public internet. This is the release gate for production
# deployments and the acceptance probe for preview deployments. It never
# substitutes localhost checks for the live path:
#
#   Browser → Vercel (SPA + /api/* rewrite) → Railway API → PostgreSQL/Redis/ObjectStore
#
# Usage:
#   FRONTEND_URL=https://<vercel-deployment-or-production-domain> \
#   API_URL=https://<railway-api-host> \
#   [API_KEY=<key for authenticated read-only probes>] \
#   [MODE=production|preview] \
#   [REQUIRE_READY=1] \
#   ./scripts/verify-cloud-deployment.sh
#
#   MODE=production (default):
#     - the frontend must serve the SPA (index.html + app shell)
#     - static assets must load
#     - a client-side-route deep link must serve the SPA shell (SPA fallback)
#     - /api/health through the Vercel rewrite MUST reach the live backend
#     - the backend's liveness + readiness endpoints must respond; with
#       REQUIRE_READY=1 readiness must be fully ready (exit 1 otherwise)
#     - with API_KEY set: one authenticated, READ-ONLY API call (GET /projects)
#       must succeed through the Vercel origin (the full Browser→Vercel→
#       Railway→PostgreSQL path)
#   MODE=preview:
#     - the frontend must serve the SPA + assets
#     - /api/health through the preview origin must NOT return the production
#       backend payload — previews are isolated from production state by
#       design (their API_TARGET is a non-production canary). A preview that
#       successfully reaches the production backend is a REJECTING failure.
#
# Exits 0 on success, 1 on failure. No credentials are printed or persisted.
set -euo pipefail

FRONTEND_URL="${FRONTEND_URL:?FRONTEND_URL is required (the deployed Vercel URL)}"
API_URL="${API_URL:-}"
API_KEY="${API_KEY:-}"
MODE="${MODE:-production}"
REQUIRE_READY="${REQUIRE_READY:-0}"

PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
section() { echo ""; echo "--- $1 ---"; }

echo "=== WorkflowOS live deployment verification ==="
echo "frontend: $FRONTEND_URL"
echo "api:      ${API_URL:-(not set — backend-direct probes skipped)}"
echo "mode:     $MODE  require_ready: $REQUIRE_READY"
echo ""

# ---------------------------------------------------------------------------
# 1. Frontend serves the SPA shell.
# ---------------------------------------------------------------------------
section "Frontend — SPA shell"
HTTP_CODE=$(curl -sS --max-time 30 -o /tmp/wfos-spa.html -w '%{http_code}' "$FRONTEND_URL/" || echo 000)
if [ "$HTTP_CODE" = "200" ] && grep -q 'id="root"' /tmp/wfos-spa.html; then
  ok "SPA index served (HTTP $HTTP_CODE, app root present)"
else
  fail "SPA index not served correctly (HTTP $HTTP_CODE)"
fi

# ---------------------------------------------------------------------------
# 2. Static assets load.
# ---------------------------------------------------------------------------
section "Frontend — static assets"
ASSET=$(grep -o 'assets/index-[^"]*\.js' /tmp/wfos-spa.html 2>/dev/null | head -1 || true)
if [ -n "$ASSET" ]; then
  ASSET_CODE=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' "$FRONTEND_URL/$ASSET" || echo 000)
  if [ "$ASSET_CODE" = "200" ]; then
    ok "JS bundle loads ($ASSET)"
  else
    fail "JS bundle did not load (HTTP $ASSET_CODE for $ASSET)"
  fi
else
  fail "no hashed JS bundle reference found in the served index.html"
fi

# ---------------------------------------------------------------------------
# 3. SPA fallback — a client-side route deep link must serve the shell.
# ---------------------------------------------------------------------------
section "Frontend — SPA fallback (deep link)"
DEEP_CODE=$(curl -sS --max-time 30 -o /tmp/wfos-deep.html -w '%{http_code}' "$FRONTEND_URL/projects" || echo 000)
if [ "$DEEP_CODE" = "200" ] && grep -q 'id="root"' /tmp/wfos-deep.html; then
  ok "deep link /projects serves the SPA shell (HTTP $DEEP_CODE)"
else
  fail "deep link /projects did not serve the SPA shell (HTTP $DEEP_CODE)"
fi

# ---------------------------------------------------------------------------
# 4. /api/* through the Vercel rewrite.
# ---------------------------------------------------------------------------
section "Frontend → API rewrite (/api/health)"
API_VIA_FRONTEND=$(curl -sS --max-time 30 -o /tmp/wfos-api.json -w '%{http_code}' "$FRONTEND_URL/api/health" || echo 000)
if [ "$MODE" = "preview" ]; then
  # ISOLATION CHECK — a preview deployment must NOT reach the production backend.
  if [ "$API_VIA_FRONTEND" = "200" ] && grep -q '"status":"ok"' /tmp/wfos-api.json 2>/dev/null; then
    fail "preview /api/health reached a live backend — preview deployments must NOT reach production state (isolation violated)"
  else
    ok "preview /api/health does NOT reach a live backend (isolated, HTTP $API_VIA_FRONTEND)"
  fi
else
  if [ "$API_VIA_FRONTEND" = "200" ] && grep -q '"status":"ok"' /tmp/wfos-api.json 2>/dev/null; then
    ok "/api/health reaches the backend through the Vercel rewrite (HTTP $API_VIA_FRONTEND)"
  else
    fail "/api/health did not reach a healthy backend through the Vercel rewrite (HTTP $API_VIA_FRONTEND)"
  fi
fi

if [ "$MODE" != "preview" ]; then
  # -------------------------------------------------------------------------
  # 5. Backend-direct probes (when API_URL is provided).
  # -------------------------------------------------------------------------
  if [ -n "$API_URL" ]; then
    section "Backend — liveness / readiness (direct)"
    HEALTH=$(curl -sS --max-time 30 "$API_URL/health" || echo '{}')
    if echo "$HEALTH" | grep -q '"status":"ok"'; then
      ok "backend liveness: $(echo "$HEALTH" | head -c 240)"
    else
      fail "backend liveness failed: $HEALTH"
    fi

    READY_CODE=$(curl -sS --max-time 30 -o /tmp/wfos-ready.json -w '%{http_code}' "$API_URL/health/ready" || echo 000)
    if [ "$READY_CODE" = "200" ]; then
      ok "backend readiness: all authoritative dependency checks pass"
    elif [ "$READY_CODE" = "503" ]; then
      echo "  readiness (503): $(cat /tmp/wfos-ready.json | head -c 400)"
      if [ "$REQUIRE_READY" = "1" ]; then
        fail "backend readiness is 503 and REQUIRE_READY=1 — a dependency check failed"
      else
        ok "backend readiness endpoint reports dependency state (503 recorded, not gating)"
      fi
    else
      fail "backend readiness endpoint returned HTTP $READY_CODE"
    fi
  fi

  # -------------------------------------------------------------------------
  # 6. Authenticated read-only API call through the full path
  #    (Browser → Vercel → Railway → PostgreSQL).
  # -------------------------------------------------------------------------
  if [ -n "$API_KEY" ]; then
    section "Authenticated read-only call (Vercel → Railway → PostgreSQL)"
    AUTH_CODE=$(curl -sS --max-time 30 -o /tmp/wfos-auth.json -w '%{http_code}' \
      -H "x-api-key: $API_KEY" "$FRONTEND_URL/api/projects" || echo 000)
    if [ "$AUTH_CODE" = "200" ] && grep -q '"projects"' /tmp/wfos-auth.json 2>/dev/null; then
      ok "authenticated GET /api/projects through the Vercel origin succeeded (HTTP $AUTH_CODE)"
    else
      fail "authenticated GET /api/projects through the Vercel origin failed (HTTP $AUTH_CODE: $(head -c 200 /tmp/wfos-auth.json 2>/dev/null))"
    fi
  else
    echo ""
    echo "  (API_KEY not set — authenticated probe skipped)"
  fi
fi

# ---------------------------------------------------------------------------
# Summary.
# ---------------------------------------------------------------------------
echo ""
echo "=== verification summary: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
