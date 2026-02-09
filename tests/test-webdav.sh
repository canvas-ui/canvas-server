#!/bin/bash
#
# WebDAV Test Suite — tests all RFC 4918 methods against /workspaces/:workspace/dav
#
# Usage:
#   WEBDAV_TOKEN=<your-token> ./tests/test-webdav.sh
#   WEBDAV_TOKEN=<token> WEBDAV_HOST=192.168.1.10 WEBDAV_PORT=8001 ./tests/test-webdav.sh
#
# Supports Basic auth too:
#   WEBDAV_USER=user@example.com WEBDAV_PASS=password ./tests/test-webdav.sh
#

set -euo pipefail

HOST="${WEBDAV_HOST:-127.0.0.1}"
PORT="${WEBDAV_PORT:-8001}"
WS="${WEBDAV_WORKSPACE:-universe}"
BASE="http://$HOST:$PORT/workspaces/$WS/dav"

# Auth header: prefer Bearer token, fall back to Basic
if [ -n "${WEBDAV_TOKEN:-}" ]; then
  AUTH_HEADER="Authorization: Bearer $WEBDAV_TOKEN"
elif [ -n "${WEBDAV_USER:-}" ] && [ -n "${WEBDAV_PASS:-}" ]; then
  AUTH_HEADER="Authorization: Basic $(echo -n "$WEBDAV_USER:$WEBDAV_PASS" | base64)"
else
  echo "ERROR: Set WEBDAV_TOKEN or WEBDAV_USER+WEBDAV_PASS"
  exit 1
fi

PASS=0; FAIL=0; TOTAL=0

# ── Helpers ──────────────────────────────────────────────────────────────────

check() {
  local name="$1" expected="$2" actual="$3"
  ((TOTAL++))
  if [ "$actual" = "$expected" ]; then
    echo "  PASS  $name (HTTP $actual)"
    ((PASS++))
  else
    echo "  FAIL  $name (expected $expected, got $actual)"
    ((FAIL++))
  fi
}

check_contains() {
  local name="$1" needle="$2" haystack="$3"
  ((TOTAL++))
  if echo "$haystack" | grep -q "$needle"; then
    echo "  PASS  $name (contains '$needle')"
    ((PASS++))
  else
    echo "  FAIL  $name (missing '$needle')"
    ((FAIL++))
  fi
}

dav() {
  curl -sf -o /dev/null -w "%{http_code}" -H "$AUTH_HEADER" "$@" 2>/dev/null || echo "000"
}

dav_body() {
  curl -s -H "$AUTH_HEADER" "$@" 2>/dev/null
}

dav_headers() {
  curl -sI -H "$AUTH_HEADER" "$@" 2>/dev/null
}

# ── Setup ────────────────────────────────────────────────────────────────────

echo "WebDAV Test Suite"
echo "Base URL: $BASE"
echo ""

# Clean up test artifacts from previous runs
dav -X DELETE "$BASE/_test_suite" >/dev/null 2>&1 || true

# ── 1. OPTIONS ───────────────────────────────────────────────────────────────

echo "1. OPTIONS"
status=$(dav -X OPTIONS "$BASE/")
check "OPTIONS /" "200" "$status"

headers=$(dav_headers -X OPTIONS "$BASE/")
check_contains "DAV header present" "DAV:" "$headers"
check_contains "Allow header present" "PROPFIND" "$headers"

# ── 2. MKCOL — create directories ───────────────────────────────────────────

echo "2. MKCOL"
status=$(dav -X MKCOL "$BASE/_test_suite")
check "MKCOL /_test_suite" "201" "$status"

status=$(dav -X MKCOL "$BASE/_test_suite/subdir")
check "MKCOL /_test_suite/subdir" "201" "$status"

# Duplicate should fail
status=$(dav -X MKCOL "$BASE/_test_suite")
check "MKCOL duplicate" "405" "$status"

# Missing parent should fail
status=$(dav -X MKCOL "$BASE/_test_suite/no/parent/here")
check "MKCOL missing parent" "409" "$status"

# ── 3. PUT — upload files ───────────────────────────────────────────────────

echo "3. PUT"
status=$(dav -X PUT -H "Content-Type: text/plain" -d "hello world" "$BASE/_test_suite/test.txt")
check "PUT new file" "201" "$status"

status=$(dav -X PUT -H "Content-Type: text/plain" -d "updated content" "$BASE/_test_suite/test.txt")
check "PUT overwrite" "204" "$status"

status=$(dav -X PUT -H "Content-Type: application/octet-stream" -d "binary data" "$BASE/_test_suite/subdir/nested.bin")
check "PUT nested file" "201" "$status"

# ── 4. GET — download files ─────────────────────────────────────────────────

echo "4. GET"
body=$(dav_body -X GET "$BASE/_test_suite/test.txt")
status=$(dav -X GET "$BASE/_test_suite/test.txt")
check "GET file" "200" "$status"
check_contains "GET content" "updated content" "$body"

# GET directory should return HTML listing
body=$(dav_body -X GET "$BASE/_test_suite/")
check_contains "GET dir listing" "test.txt" "$body"

# GET nonexistent
status=$(dav -X GET "$BASE/_test_suite/nope.txt")
check "GET 404" "404" "$status"

# ── 5. HEAD — metadata without body ─────────────────────────────────────────

echo "5. HEAD"
headers=$(dav_headers "$BASE/_test_suite/test.txt")
status=$(echo "$headers" | head -1 | grep -o '[0-9]\{3\}')
check "HEAD file" "200" "$status"
check_contains "HEAD has ETag" "ETag" "$headers"
check_contains "HEAD has Content-Length" "Content-Length" "$headers"
check_contains "HEAD has Last-Modified" "Last-Modified" "$headers"

# ── 6. PROPFIND — directory listing ─────────────────────────────────────────

echo "6. PROPFIND"

# Depth 0 — just the resource
body=$(dav_body -X PROPFIND -H "Depth: 0" "$BASE/_test_suite/")
status=$(dav -X PROPFIND -H "Depth: 0" "$BASE/_test_suite/")
check "PROPFIND depth 0" "207" "$status"
check_contains "PROPFIND multistatus" "multistatus" "$body"
check_contains "PROPFIND has href" "D:href" "$body"

# Depth 1 — resource + children
body=$(dav_body -X PROPFIND -H "Depth: 1" "$BASE/_test_suite/")
check "PROPFIND depth 1" "207" "$(dav -X PROPFIND -H "Depth: 1" "$BASE/_test_suite/")"
check_contains "PROPFIND lists test.txt" "test.txt" "$body"
check_contains "PROPFIND lists subdir" "subdir" "$body"
check_contains "PROPFIND has resourcetype" "resourcetype" "$body"
check_contains "PROPFIND has getlastmodified" "getlastmodified" "$body"
check_contains "PROPFIND has getetag" "getetag" "$body"

# PROPFIND with XML body (specific props)
body=$(dav_body -X PROPFIND -H "Depth: 1" -H "Content-Type: application/xml" \
  -d '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/><D:getcontentlength/></D:prop></D:propfind>' \
  "$BASE/_test_suite/")
check_contains "PROPFIND with body" "displayname" "$body"

# PROPFIND on single file
body=$(dav_body -X PROPFIND -H "Depth: 0" "$BASE/_test_suite/test.txt")
check_contains "PROPFIND file has contentlength" "getcontentlength" "$body"
check_contains "PROPFIND file has contenttype" "getcontenttype" "$body"

# PROPFIND 404
status=$(dav -X PROPFIND -H "Depth: 0" "$BASE/_test_suite/nonexistent")
check "PROPFIND 404" "404" "$status"

# ── 7. PROPPATCH ─────────────────────────────────────────────────────────────

echo "7. PROPPATCH"
body=$(dav_body -X PROPPATCH -H "Content-Type: application/xml" \
  -d '<?xml version="1.0" encoding="utf-8"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:displayname>renamed</D:displayname></D:prop></D:set></D:propertyupdate>' \
  "$BASE/_test_suite/test.txt")
status=$(dav -X PROPPATCH -H "Content-Type: application/xml" \
  -d '<?xml version="1.0" encoding="utf-8"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:displayname>renamed</D:displayname></D:prop></D:set></D:propertyupdate>' \
  "$BASE/_test_suite/test.txt")
check "PROPPATCH" "207" "$status"
check_contains "PROPPATCH response" "multistatus" "$body"

# ── 8. COPY ──────────────────────────────────────────────────────────────────

echo "8. COPY"
status=$(dav -X COPY -H "Destination: $BASE/_test_suite/test_copy.txt" "$BASE/_test_suite/test.txt")
check "COPY file" "201" "$status"

# Verify copy exists
status=$(dav -X GET "$BASE/_test_suite/test_copy.txt")
check "COPY target exists" "200" "$status"

# Copy with overwrite
status=$(dav -X COPY -H "Destination: $BASE/_test_suite/test_copy.txt" -H "Overwrite: T" "$BASE/_test_suite/test.txt")
check "COPY overwrite T" "204" "$status"

# Copy without overwrite should fail
status=$(dav -X COPY -H "Destination: $BASE/_test_suite/test_copy.txt" -H "Overwrite: F" "$BASE/_test_suite/test.txt")
check "COPY overwrite F" "412" "$status"

# Copy directory
status=$(dav -X COPY -H "Destination: $BASE/_test_suite/subdir_copy" "$BASE/_test_suite/subdir")
check "COPY directory" "201" "$status"

# ── 9. MOVE ──────────────────────────────────────────────────────────────────

echo "9. MOVE"
status=$(dav -X MOVE -H "Destination: $BASE/_test_suite/test_moved.txt" "$BASE/_test_suite/test_copy.txt")
check "MOVE file" "201" "$status"

# Source should be gone
status=$(dav -X GET "$BASE/_test_suite/test_copy.txt")
check "MOVE source gone" "404" "$status"

# Target should exist
status=$(dav -X GET "$BASE/_test_suite/test_moved.txt")
check "MOVE target exists" "200" "$status"

# ── 10. LOCK ─────────────────────────────────────────────────────────────────

echo "10. LOCK"
lock_response=$(dav_body -X LOCK -H "Content-Type: application/xml" -H "Timeout: Second-3600" \
  -d '<?xml version="1.0" encoding="utf-8"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>test-suite</D:href></D:owner></D:lockinfo>' \
  "$BASE/_test_suite/test.txt")
status=$(dav -X LOCK -H "Content-Type: application/xml" -H "Timeout: Second-3600" \
  -d '<?xml version="1.0" encoding="utf-8"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>test-suite</D:href></D:owner></D:lockinfo>' \
  "$BASE/_test_suite/test.txt")
check "LOCK file" "200" "$status"
check_contains "LOCK has locktoken" "locktoken" "$lock_response"
check_contains "LOCK has lockscope" "exclusive" "$lock_response"

# Extract lock token for UNLOCK test
LOCK_TOKEN=$(echo "$lock_response" | grep -oP 'urn:uuid:[a-f0-9-]+' | head -1)

# ── 11. UNLOCK ───────────────────────────────────────────────────────────────

echo "11. UNLOCK"
if [ -n "${LOCK_TOKEN:-}" ]; then
  status=$(dav -X UNLOCK -H "Lock-Token: <$LOCK_TOKEN>" "$BASE/_test_suite/test.txt")
  check "UNLOCK file" "204" "$status"
else
  echo "  SKIP  UNLOCK (no lock token extracted)"
  ((TOTAL++)); ((FAIL++))
fi

# UNLOCK with bad token
status=$(dav -X UNLOCK -H "Lock-Token: <urn:uuid:00000000-0000-0000-0000-000000000000>" "$BASE/_test_suite/test.txt")
check "UNLOCK bad token" "409" "$status"

# ── 12. DELETE ───────────────────────────────────────────────────────────────

echo "12. DELETE"
status=$(dav -X DELETE "$BASE/_test_suite/test_moved.txt")
check "DELETE file" "204" "$status"

status=$(dav -X DELETE "$BASE/_test_suite/test_moved.txt")
check "DELETE 404" "404" "$status"

# Delete directory recursively
status=$(dav -X DELETE "$BASE/_test_suite")
check "DELETE directory" "204" "$status"

# Verify it's gone
status=$(dav -X PROPFIND -H "Depth: 0" "$BASE/_test_suite/")
check "DELETE verified" "404" "$status"

# ── 13. Auth errors ──────────────────────────────────────────────────────────

echo "13. Auth errors"
status=$(curl -sf -o /dev/null -w "%{http_code}" -X PROPFIND -H "Depth: 0" "$BASE/" 2>/dev/null || echo "000")
check "No auth → 401" "401" "$status"

status=$(curl -sf -o /dev/null -w "%{http_code}" -X PROPFIND -H "Depth: 0" -H "Authorization: Bearer invalid-token" "$BASE/" 2>/dev/null || echo "000")
check "Bad token → 401" "401" "$status"

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

[ "$FAIL" -eq 0 ] && echo "All tests passed." || echo "Some tests failed!"
exit $FAIL
