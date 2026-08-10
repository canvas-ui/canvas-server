#!/usr/bin/env node
'use strict';

import { spawn } from 'child_process';
import { setTimeout } from 'timers/promises';
import http from 'http';
import _https from 'https';
import { URL } from 'url';

/**
 * Test REST API authentication connection closure
 * Verifies that TCP connections are properly closed when invalid API tokens are provided
 */

const SERVER_URL = 'http://localhost:8001';
const INVALID_TOKEN = 'canvas-a0ca1d5ce7da0235808d6b2d3e0a3530103c433e02b3d0f3';

async function testInvalidTokenWithNodeFetch() {
  console.log('\n=== Test 1: Invalid token with Node.js HTTP request ===');

  return new Promise((resolve, _reject) => {
    const url = new URL('/rest/v2/auth/me', SERVER_URL);
    const startTime = Date.now();

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${INVALID_TOKEN}`,
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      const duration = Date.now() - startTime;
      console.log(`Response received after ${duration}ms`);
      console.log(`Status: ${res.statusCode}`);
      console.log(`Headers:`, res.headers);

      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });

      res.on('end', () => {
        console.log(`Response body: ${body}`);

        if (res.statusCode === 401) {
          console.log('✅ Expected: 401 Unauthorized received');

          // Check if Connection: close header is present
          if (res.headers.connection && res.headers.connection.toLowerCase() === 'close') {
            console.log('✅ Connection: close header is present');
            resolve({ success: true, message: `Connection properly closed after ${duration}ms` });
          } else {
            console.log('❌ Connection: close header is missing');
            resolve({ success: false, message: 'Connection: close header not set' });
          }
        } else {
          console.log(`❌ Unexpected status code: ${res.statusCode}`);
          resolve({ success: false, message: `Expected 401, got ${res.statusCode}` });
        }
      });
    });

    req.on('error', (error) => {
      console.log(`Request error: ${error.message}`);
      resolve({ success: false, message: `Request error: ${error.message}` });
    });

    req.on('close', () => {
      console.log('✅ Request connection closed');
    });

    req.setTimeout(10000, () => {
      console.log('❌ Request timeout');
      req.destroy();
      resolve({ success: false, message: 'Request timeout' });
    });

    req.end();
  });
}

async function testInvalidTokenWithCurl() {
  console.log('\n=== Test 2: Invalid token with curl (simulating CLI behavior) ===');

  return new Promise((resolve, _reject) => {
    const startTime = Date.now();

    // Use curl to test REST API endpoint with invalid token
    const curlProcess = spawn('curl', [
      '-v',
      '-X', 'GET',
      '-H', 'Content-Type: application/json',
      '-H', `Authorization: Bearer ${INVALID_TOKEN}`,
      '--max-time', '10',
      '--connect-timeout', '5',
      `${SERVER_URL}/rest/v2/auth/me`
    ]);

    let output = '';
    let error = '';

    curlProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    curlProcess.stderr.on('data', (data) => {
      error += data.toString();
    });

    curlProcess.on('close', (code) => {
      const duration = Date.now() - startTime;
      console.log(`curl process exited with code ${code} after ${duration}ms`);

      // Check if we got a 401 response
      if (error.includes('401') || output.includes('401')) {
        console.log('✅ Expected: 401 Unauthorized received');

        // Check if Connection: close header is present in response
        if (error.includes('Connection: close') || error.includes('connection: close')) {
          console.log('✅ Connection: close header detected');
          resolve({ success: true, message: `Connection properly closed in ${duration}ms` });
        } else {
          console.log('❌ Connection: close header not found');
          resolve({ success: false, message: 'Connection: close header not found in response' });
        }
      } else {
        console.log('❌ Expected 401 response not received');
        console.log('STDERR:', error);
        console.log('STDOUT:', output);
        resolve({ success: false, message: 'Expected 401 response not received' });
      }
    });

    curlProcess.on('error', (err) => {
      console.log('curl error:', err.message);
      resolve({ success: false, message: `curl error: ${err.message}` });
    });
  });
}

async function testConnectionReuse() {
  console.log('\n=== Test 3: Connection reuse behavior with invalid token ===');

  return new Promise((resolve, _reject) => {
    const startTime = Date.now();

    // Make multiple requests to see if connections are reused
    const curlProcess = spawn('curl', [
      '-v',
      '--http1.1',
      '--keepalive-time', '2',
      '-X', 'GET',
      '-H', 'Content-Type: application/json',
      '-H', `Authorization: Bearer ${INVALID_TOKEN}`,
      '--max-time', '10',
      `${SERVER_URL}/rest/v2/auth/me`,
      `${SERVER_URL}/rest/v2/auth/me`
    ]);

    let output;
    void output;
    let error = '';

    curlProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    curlProcess.stderr.on('data', (data) => {
      error += data.toString();
    });

    curlProcess.on('close', (code) => {
      const duration = Date.now() - startTime;
      console.log(`curl process exited with code ${code} after ${duration}ms`);

      // Check if connection was reused (should NOT be reused if properly closed)
      if (error.includes('Re-using existing connection') || error.includes('Connection #0 to host')) {
        console.log('❌ Connection was reused - this suggests connection was not properly closed');
        resolve({ success: false, message: 'Connection was reused after auth failure' });
      } else {
        console.log('✅ Connection was not reused - connections properly closed');
        resolve({ success: true, message: `Connections properly closed in ${duration}ms` });
      }
    });

    curlProcess.on('error', (err) => {
      console.log('curl error:', err.message);
      resolve({ success: false, message: `curl error: ${err.message}` });
    });
  });
}

async function runTests() {
  console.log('Testing REST API authentication connection closure...');
  console.log('Make sure the Canvas server is running on localhost:3000');

  try {
    // Test 1: Node.js HTTP request behavior
    const test1Result = await testInvalidTokenWithNodeFetch();
    console.log(`Test 1 result: ${test1Result.success ? 'PASS' : 'FAIL'} - ${test1Result.message}`);

    // Wait a bit between tests
    await setTimeout(1000);

    // Test 2: curl behavior (simulating CLI)
    const test2Result = await testInvalidTokenWithCurl();
    console.log(`Test 2 result: ${test2Result.success ? 'PASS' : 'FAIL'} - ${test2Result.message}`);

    // Wait a bit between tests
    await setTimeout(1000);

    // Test 3: Connection reuse behavior
    const test3Result = await testConnectionReuse();
    console.log(`Test 3 result: ${test3Result.success ? 'PASS' : 'FAIL'} - ${test3Result.message}`);

    // Overall result
    console.log('\n=== Test Summary ===');
    console.log(`Test 1 (Node.js HTTP): ${test1Result.success ? 'PASS' : 'FAIL'}`);
    console.log(`Test 2 (curl): ${test2Result.success ? 'PASS' : 'FAIL'}`);
    console.log(`Test 3 (connection reuse): ${test3Result.success ? 'PASS' : 'FAIL'}`);

    if (test1Result.success && test2Result.success && test3Result.success) {
      console.log('✅ All tests passed - REST API auth properly closes connections');
      process.exit(0);
    } else {
      console.log('❌ Some tests failed - REST API auth may not be closing connections properly');
      process.exit(1);
    }

  } catch (error) {
    console.error('Test error:', error);
    process.exit(1);
  }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests();
}
