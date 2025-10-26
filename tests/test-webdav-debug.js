#!/usr/bin/env node

/**
 * WebDAV Debug Test Script
 * Tests WebDAV functionality and provides detailed debugging information
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
        'Authorization': `Bearer ${CONFIG.token}`,
        'User-Agent': 'WebDAV-Debug-Test/1.0',
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
 * Test WebDAV OPTIONS request (capability discovery)
 */
async function testOptions() {
  console.log('\n🔍 Testing OPTIONS request (capability discovery)...');

  try {
    const response = await makeRequest({
      url: `http://${CONFIG.host}:${CONFIG.port}/webdav/${CONFIG.workspace}/home/`,
      method: 'OPTIONS'
    });

    console.log(`✅ OPTIONS request completed`);
    console.log(`DAV header: ${response.headers.dav || 'Not set'}`);
    console.log(`MS-Author-Via header: ${response.headers['ms-author-via'] || 'Not set'}`);

    return response;
  } catch (error) {
    console.error(`❌ OPTIONS request failed:`, error.message);
    throw error;
  }
}

/**
 * Test WebDAV PROPFIND request (directory listing)
 */
async function testPropfind() {
  console.log('\n🔍 Testing PROPFIND request (directory listing)...');

  try {
    const response = await makeRequest({
      url: `http://${CONFIG.host}:${CONFIG.port}/webdav/${CONFIG.workspace}/home/`,
      method: 'PROPFIND',
      headers: {
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

    console.log(`✅ PROPFIND request completed`);
    return response;
  } catch (error) {
    console.error(`❌ PROPFIND request failed:`, error.message);
    throw error;
  }
}

/**
 * Test WebDAV GET request
 */
async function testGet() {
  console.log('\n🔍 Testing GET request...');

  try {
    const response = await makeRequest({
      url: `http://${CONFIG.host}:${CONFIG.port}/webdav/${CONFIG.workspace}/home/`,
      method: 'GET'
    });

    console.log(`✅ GET request completed`);
    return response;
  } catch (error) {
    console.error(`❌ GET request failed:`, error.message);
    throw error;
  }
}

/**
 * Test authentication with different methods
 */
async function testAuthentication() {
  console.log('\n🔍 Testing authentication methods...');

  // Test Bearer token
  console.log('\n--- Testing Bearer Token ---');
  try {
    const response = await makeRequest({
      url: `http://${CONFIG.host}:${CONFIG.port}/webdav/${CONFIG.workspace}/home/`,
      method: 'OPTIONS',
      headers: {
        'Authorization': `Bearer ${CONFIG.token}`
      }
    });
    console.log(`✅ Bearer token authentication successful`);
  } catch (error) {
    console.error(`❌ Bearer token authentication failed:`, error.message);
  }

  // Test Basic Auth (password = token)
  console.log('\n--- Testing Basic Auth ---');
  try {
    const basicAuth = Buffer.from(`user:${CONFIG.token}`).toString('base64');
    const response = await makeRequest({
      url: `http://${CONFIG.host}:${CONFIG.port}/webdav/${CONFIG.workspace}/home/`,
      method: 'OPTIONS',
      headers: {
        'Authorization': `Basic ${basicAuth}`
      }
    });
    console.log(`✅ Basic auth authentication successful`);
  } catch (error) {
    console.error(`❌ Basic auth authentication failed:`, error.message);
  }
}

/**
 * Test health endpoint
 */
async function testHealth() {
  console.log('\n🔍 Testing health endpoint...');

  try {
    const response = await makeRequest({
      url: `http://${CONFIG.host}:${CONFIG.port}/webdav/health`,
      method: 'GET'
    });

    console.log(`✅ Health check completed`);
    return response;
  } catch (error) {
    console.error(`❌ Health check failed:`, error.message);
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
      method: 'OPTIONS'
    });

    console.log(`Response for invalid workspace:`, response.statusCode);
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
  console.log('🚀 Starting WebDAV Debug Tests');
  console.log(`Configuration:`, CONFIG);

  if (CONFIG.token === 'your-api-token-here') {
    console.log('\n⚠️  WARNING: Please set WEBDAV_TOKEN environment variable with a valid API token');
    console.log('   Example: WEBDAV_TOKEN=your-token-here node test-webdav-debug.js');
  }

  try {
    // Test health endpoint first
    await testHealth();

    // Test authentication
    await testAuthentication();

    // Test WebDAV operations
    await testOptions();
    await testPropfind();
    await testGet();

    // Test error cases
    await testInvalidWorkspace();

    console.log('\n✅ All tests completed');
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
