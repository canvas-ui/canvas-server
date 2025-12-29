#!/bin/bash

# WebDAV Debug Test Script using curl
# This script tests WebDAV functionality using curl commands

HOST="127.0.0.1"
PORT="8001"
WORKSPACE="universe"
TOKEN="${WEBDAV_TOKEN:-your-api-token-here}"

echo "🚀 Starting WebDAV Debug Tests with curl"
echo "Host: $HOST:$PORT"
echo "Workspace: $WORKSPACE"
echo "Token: ${TOKEN:0:10}..."

if [ "$TOKEN" = "your-api-token-here" ]; then
    echo "⚠️  WARNING: Please set WEBDAV_TOKEN environment variable"
    echo "   Example: WEBDAV_TOKEN=your-token-here ./test-webdav-curl.sh"
fi

echo ""
echo "=== Testing Health Endpoint ==="
curl -v "http://$HOST:$PORT/webdav/health" 2>&1

echo ""
echo "=== Testing OPTIONS Request (Bearer Token) ==="
curl -v \
  -H "Authorization: Bearer $TOKEN" \
  -H "User-Agent: WebDAV-Debug-Test/1.0" \
  -X OPTIONS \
  "http://$HOST:$PORT/webdav/$WORKSPACE/home/" 2>&1

echo ""
echo "=== Testing OPTIONS Request (Basic Auth) ==="
curl -v \
  -H "Authorization: Basic $(echo -n "user:$TOKEN" | base64)" \
  -H "User-Agent: WebDAV-Debug-Test/1.0" \
  -X OPTIONS \
  "http://$HOST:$PORT/webdav/$WORKSPACE/home/" 2>&1

echo ""
echo "=== Testing PROPFIND Request ==="
curl -v \
  -H "Authorization: Bearer $TOKEN" \
  -H "User-Agent: WebDAV-Debug-Test/1.0" \
  -H "Depth: 1" \
  -H "Content-Type: application/xml" \
  -X PROPFIND \
  -d '<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
    <D:getlastmodified/>
    <D:getcontentlength/>
  </D:prop>
</D:propfind>' \
  "http://$HOST:$PORT/webdav/$WORKSPACE/home/" 2>&1

echo ""
echo "=== Testing GET Request ==="
curl -v \
  -H "Authorization: Bearer $TOKEN" \
  -H "User-Agent: WebDAV-Debug-Test/1.0" \
  -X GET \
  "http://$HOST:$PORT/webdav/$WORKSPACE/home/" 2>&1

echo ""
echo "=== Testing Invalid Workspace ==="
curl -v \
  -H "Authorization: Bearer $TOKEN" \
  -H "User-Agent: WebDAV-Debug-Test/1.0" \
  -X OPTIONS \
  "http://$HOST:$PORT/webdav/nonexistent/home/" 2>&1

echo ""
echo "✅ All curl tests completed"
