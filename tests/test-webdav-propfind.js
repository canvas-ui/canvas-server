#!/usr/bin/env node

/**
 * WebDAV PROPFIND Test Script
 * Tests WebDAV PROPFIND (directory listing) functionality
 */

import http from 'http';
import { URL } from 'url';

const DEBUG = process.env.DEBUG || 'webdav:*';
process.env.DEBUG = DEBUG;

// Test configuration
const CONFIG = {
  host: '127.0.0.1',
  port: 8001,
  workspace: 'universe',
  username: 'admin@canvas.local',
  password: process.env.WEBDAV_PASSWORD || '+CeG14fq66Xg'
};

/**
 * Make HTTP request with detailed logging
 */
function makeRequest(options, data = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(options.url);
    const requestOptions = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'WebDAV-PROPFIND-Test/1.0',
        ...options.headers
      }
    };

    console.log(`\n=== Making ${requestOptions.method} Request ===`);
    console.log(`URL: ${options.url}`);
    console.log(`Headers:`, JSON.stringify(requestOptions.headers, null, 2));

    const req = http.request(requestOptions, (res) => {
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
 * Test WebDAV PROPFIND request (directory listing)
 */
async function testPropfind() {
  console.log('\n🔍 Testing PROPFIND request (directory listing)...');

  try {
    const basicAuth = Buffer.from(`${CONFIG.username}:${CONFIG.password}`).toString('base64');
    const response = await makeRequest({
      url: `http://${CONFIG.host}:${CONFIG.port}/webdav/${CONFIG.workspace}/home/`,
      method: 'PROPFIND',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
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
      console.log(`Response contains ${(response.body.match(/<D:response>/g) || []).length} items`);
    } else {
      console.log(`❌ PROPFIND request failed with status ${response.statusCode}`);
    }

    return response;
  } catch (error) {
    console.error(`❌ PROPFIND test failed:`, error.message);
    throw error;
  }
}

/**
 * Test WebDAV OPTIONS request
 */
async function testOptions() {
  console.log('\n🔍 Testing OPTIONS request...');

  try {
    const basicAuth = Buffer.from(`${CONFIG.username}:${CONFIG.password}`).toString('base64');
    const response = await makeRequest({
      url: `http://${CONFIG.host}:${CONFIG.port}/webdav/${CONFIG.workspace}/home/`,
      method: 'OPTIONS',
      headers: {
        'Authorization': `Basic ${basicAuth}`
      }
    });

    console.log(`Response status: ${response.statusCode}`);
    console.log(`DAV header: ${response.headers.dav || 'Not set'}`);

    if (response.statusCode === 200) {
      console.log(`✅ OPTIONS request successful`);
    } else {
      console.log(`❌ OPTIONS request failed`);
    }

    return response;
  } catch (error) {
    console.error(`❌ OPTIONS test failed:`, error.message);
    throw error;
  }
}

/**
 * Test WebDAV GET request
 */
async function testGet() {
  console.log('\n🔍 Testing GET request...');

  try {
    const basicAuth = Buffer.from(`${CONFIG.username}:${CONFIG.password}`).toString('base64');
    const response = await makeRequest({
      url: `http://${CONFIG.host}:${CONFIG.port}/webdav/${CONFIG.workspace}/home/`,
      method: 'GET',
      headers: {
        'Authorization': `Basic ${basicAuth}`
      }
    });

    console.log(`Response status: ${response.statusCode}`);

    if (response.statusCode === 200) {
      console.log(`✅ GET request successful`);
    } else {
      console.log(`❌ GET request failed`);
    }

    return response;
  } catch (error) {
    console.error(`❌ GET test failed:`, error.message);
    throw error;
  }
}

/**
 * Main test runner
 */
async function runTests() {
  console.log('🚀 Starting WebDAV PROPFIND Tests');
  console.log(`Configuration:`, CONFIG);

  try {
    // Test WebDAV operations
    await testOptions();
    await testPropfind();
    await testGet();

    console.log('\n✅ All PROPFIND tests completed');
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
