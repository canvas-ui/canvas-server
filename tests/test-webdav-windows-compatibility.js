#!/usr/bin/env node

/**
 * WebDAV Windows Compatibility Test Script
 * Tests WebDAV authentication methods that Windows clients use
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';

const DEBUG = process.env.DEBUG || 'webdav:*';
process.env.DEBUG = DEBUG;

// Test configuration
const CONFIG = {
  host: '127.0.0.1',
  port: 8001,
  workspace: 'universe',
  // You'll need to replace this with a valid token
  token: process.env.WEBDAV_TOKEN || 'your-api-token-here'
};

/**
 * Make HTTP request with detailed logging
 */
function makeRequest(options, data = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(options.url);
    const requestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'WebDAV-Windows-Test/1.0',
        ...options.headers
      }
    };

    console.log(`\n=== Making ${requestOptions.method} Request ===`);
    console.log(`URL: ${options.url}`);
    console.log(`Headers:`, JSON.stringify(requestOptions.headers, null, 2));

    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(requestOptions, (res) => {
      console.log(`\n=== Response ===`);
      console.log(`Status: ${res.statusCode} ${res.statusMessage}`);
      console.log(`Headers:`, JSON.stringify(res.headers, null, 2));

      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });

      res.on('end', () => {
        console.log(`Body:`, body);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: body
        });
      });
    });

    req.on('error', (err) => {
      console.error(`Request error:`, err);
      reject(err);
    });

    if (data) {
      req.write(data);
    }

    req.end();
  });
}

/**
 * Test authentication without credentials (should return 401 with WWW-Authenticate)
 */
async function testUnauthenticatedRequest() {
  console.log('\n🔍 Testing unauthenticated request (should return 401 with WWW-Authenticate)...');

  try {
    const response = await makeRequest({
      url: `http://${CONFIG.host}:${CONFIG.port}/webdav/${CONFIG.workspace}/home/`,
      method: 'OPTIONS'
    });

    console.log(`Response status: ${response.statusCode}`);
    console.log(`WWW-Authenticate header: ${response.headers['www-authenticate'] || 'Not set'}`);

    if (response.statusCode === 401 && response.headers['www-authenticate']) {
      console.log(`✅ Correctly returned 401 with WWW-Authenticate header`);
    } else {
      console.log(`❌ Expected 401 with WWW-Authenticate header`);
    }

    return response;
  } catch (error) {
    console.error(`❌ Unauthenticated request test failed:`, error.message);
    throw error;
  }
}

/**
 * Test Bearer token authentication
 */
async function testBearerTokenAuth() {
  console.log('\n🔍 Testing Bearer token authentication...');

  try {
    const response = await makeRequest({
      url: `http://${CONFIG.host}:${CONFIG.port}/webdav/${CONFIG.workspace}/home/`,
      method: 'OPTIONS',
      headers: {
        'Authorization': `Bearer ${CONFIG.token}`
      }
    });

    console.log(`Response status: ${response.statusCode}`);

    if (response.statusCode === 200) {
      console.log(`✅ Bearer token authentication successful`);
    } else {
      console.log(`❌ Bearer token authentication failed`);
    }

    return response;
  } catch (error) {
    console.error(`❌ Bearer token test failed:`, error.message);
    throw error;
  }
}

/**
 * Test Basic authentication (username:token)
 */
async function testBasicAuth() {
  console.log('\n🔍 Testing Basic authentication (username:token)...');

  try {
    const basicAuth = Buffer.from(`user:${CONFIG.token}`).toString('base64');
    const response = await makeRequest({
      url: `http://${CONFIG.host}:${CONFIG.port}/webdav/${CONFIG.workspace}/home/`,
      method: 'OPTIONS',
      headers: {
        'Authorization': `Basic ${basicAuth}`
      }
    });

    console.log(`Response status: ${response.statusCode}`);

    if (response.statusCode === 200) {
      console.log(`✅ Basic authentication successful`);
    } else {
      console.log(`❌ Basic authentication failed`);
    }

    return response;
  } catch (error) {
    console.error(`❌ Basic auth test failed:`, error.message);
    throw error;
  }
}

/**
 * Test Basic authentication with actual password (not token)
 */
async function testBasicAuthWithPassword() {
  console.log('\n🔍 Testing Basic authentication (username:password)...');

  try {
    // This test assumes you have a user with email admin@canvas.local and password 'password'
    // You may need to adjust these credentials for your setup
    const basicAuth = Buffer.from(`admin@canvas.local:password`).toString('base64');
    const response = await makeRequest({
      url: `http://${CONFIG.host}:${CONFIG.port}/webdav/${CONFIG.workspace}/home/`,
      method: 'OPTIONS',
      headers: {
        'Authorization': `Basic ${basicAuth}`
      }
    });

    console.log(`Response status: ${response.statusCode}`);

    if (response.statusCode === 200) {
      console.log(`✅ Basic authentication with password successful`);
    } else {
      console.log(`❌ Basic authentication with password failed (this is expected if user/password don't exist)`);
    }

    return response;
  } catch (error) {
    console.error(`❌ Basic auth with password test failed:`, error.message);
    throw error;
  }
}

/**
 * Test PROPFIND request (directory listing)
 */
async function testPropfindRequest() {
  console.log('\n🔍 Testing PROPFIND request (directory listing)...');

  try {
    const response = await makeRequest({
      url: `http://${CONFIG.host}:${CONFIG.port}/webdav/${CONFIG.workspace}/home/`,
      method: 'PROPFIND',
      headers: {
        'Authorization': `Bearer ${CONFIG.token}`,
        'Depth': '1',
        'Content-Type': 'application/xml'
      }
    }, `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
    <D:getlastmodified/>
    <D:getcontentlength/>
  </D:prop>
</D:propfind>`);

    console.log(`Response status: ${response.statusCode}`);

    if (response.statusCode === 207) { // Multi-Status is expected for PROPFIND
      console.log(`✅ PROPFIND request successful`);
    } else {
      console.log(`❌ PROPFIND request failed`);
    }

    return response;
  } catch (error) {
    console.error(`❌ PROPFIND test failed:`, error.message);
    throw error;
  }
}

/**
 * Test Windows-specific WebDAV headers
 */
async function testWindowsHeaders() {
  console.log('\n🔍 Testing Windows-specific WebDAV headers...');

  try {
    const response = await makeRequest({
      url: `http://${CONFIG.host}:${CONFIG.port}/webdav/${CONFIG.workspace}/home/`,
      method: 'OPTIONS',
      headers: {
        'Authorization': `Bearer ${CONFIG.token}`,
        'User-Agent': 'Microsoft-WebDAV-MiniRedir/10.0.19041'
      }
    });

    console.log(`Response status: ${response.statusCode}`);
    console.log(`DAV header: ${response.headers.dav || 'Not set'}`);
    console.log(`MS-Author-Via header: ${response.headers['ms-author-via'] || 'Not set'}`);

    if (response.headers.dav && response.headers['ms-author-via']) {
      console.log(`✅ Windows WebDAV headers present`);
    } else {
      console.log(`❌ Missing Windows WebDAV headers`);
    }

    return response;
  } catch (error) {
    console.error(`❌ Windows headers test failed:`, error.message);
    throw error;
  }
}

/**
 * Test invalid token
 */
async function testInvalidToken() {
  console.log('\n🔍 Testing invalid token...');

  try {
    const response = await makeRequest({
      url: `http://${CONFIG.host}:${CONFIG.port}/webdav/${CONFIG.workspace}/home/`,
      method: 'OPTIONS',
      headers: {
        'Authorization': 'Bearer invalid-token-here'
      }
    });

    console.log(`Response status: ${response.statusCode}`);

    if (response.statusCode === 401) {
      console.log(`✅ Correctly rejected invalid token`);
    } else {
      console.log(`❌ Should have rejected invalid token`);
    }

    return response;
  } catch (error) {
    console.error(`❌ Invalid token test failed:`, error.message);
    throw error;
  }
}

/**
 * Test invalid workspace
 */
async function testInvalidWorkspace() {
  console.log('\n🔍 Testing invalid workspace...');

  try {
    const response = await makeRequest({
      url: `http://${CONFIG.host}:${CONFIG.port}/webdav/nonexistent/home/`,
      method: 'OPTIONS',
      headers: {
        'Authorization': `Bearer ${CONFIG.token}`
      }
    });

    console.log(`Response status: ${response.statusCode}`);

    if (response.statusCode === 404) {
      console.log(`✅ Correctly returned 404 for invalid workspace`);
    } else {
      console.log(`❌ Expected 404 for invalid workspace`);
    }

    return response;
  } catch (error) {
    console.error(`❌ Invalid workspace test failed:`, error.message);
    throw error;
  }
}

/**
 * Main test runner
 */
async function runTests() {
  console.log('🚀 Starting WebDAV Windows Compatibility Tests');
  console.log(`Configuration:`, CONFIG);

  if (CONFIG.token === 'your-api-token-here') {
    console.log('\n⚠️  WARNING: Please set WEBDAV_TOKEN environment variable with a valid API token');
    console.log('   Example: WEBDAV_TOKEN=your-token-here node test-webdav-windows-compatibility.js');
    console.log('   You can create a token via: canvas auth tokens create "WebDAV Test Token"');
  }

  try {
    // Test authentication methods
    await testUnauthenticatedRequest();
    await testBearerTokenAuth();
    await testBasicAuth();
    await testBasicAuthWithPassword();
    await testInvalidToken();

    // Test WebDAV functionality
    await testPropfindRequest();
    await testWindowsHeaders();

    // Test error cases
    await testInvalidWorkspace();

    console.log('\n✅ All Windows compatibility tests completed');
    console.log('\n📋 Windows Mounting Instructions:');
    console.log('1. Open File Explorer');
    console.log('2. Right-click "This PC" and select "Map network drive"');
    console.log('3. Enter the WebDAV URL: http://your-server:8001/webdav/workspace-name/home/');
    console.log('4. Check "Connect using different credentials"');
    console.log('5. Enter credentials:');
    console.log('   - Username: your-email@domain.com (or any username)');
    console.log('   - Password: your-canvas-api-token');
    console.log('6. Click "Finish"');
  } catch (error) {
    console.error('\n❌ Test suite failed:', error.message);
    process.exit(1);
  }
}

// Run tests if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().catch(console.error);
}

export { runTests, makeRequest };
