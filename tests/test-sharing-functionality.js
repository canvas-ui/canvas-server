#!/usr/bin/env node

/**
 * Test script for the new sharing functionality
 * Tests token-based and email-based sharing for workspaces and contexts
 */

import fetch from 'node-fetch';
import assert from 'assert';

// Configuration
const BASE_URL = 'http://127.0.0.1:8001/rest/v2';
const TOKEN = process.env.TOKEN || 'canvas-59e7b70b39d452005c42764d9bb608d899a047246627615e';

// Test data
let testWorkspaceId = null;
let testContextId = null;
let workspaceToken = null;
let contextToken = null;
let testUserEmail = 'test-user@canvas.local';

// Helper function to make API requests
async function apiRequest(method, endpoint, body = null, useToken = true) {
  const headers = {
    'Content-Type': 'application/json'
  };

  if (useToken) {
    headers['Authorization'] = `Bearer ${TOKEN}`;
  }

  const options = {
    method,
    headers
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${BASE_URL}${endpoint}`, options);
  const data = await response.json();

  return {
    status: response.status,
    data,
    response
  };
}

// Helper function to make public API requests with token
async function pubRequest(method, endpoint, body = null, token = null) {
  const headers = {
    'Content-Type': 'application/json'
  };

  if (token) headers['Authorization'] = `Bearer ${token}`;

  const options = {
    method,
    headers
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const url = `${BASE_URL}/pub${endpoint}`;

  const response = await fetch(url, options);
  const data = await response.json();

  return {
    status: response.status,
    data,
    response
  };
}

// Test functions
async function test1_createTestWorkspace() {
  console.log('\n🧪 Test 1: Creating test workspace...');

  const result = await apiRequest('POST', '/workspaces', {
    name: 'test-sharing-workspace',
    label: 'Test Sharing Workspace',
    description: 'Workspace for testing sharing functionality'
  });

  assert.strictEqual(result.status, 201, `Expected 201, got ${result.status}: ${JSON.stringify(result.data)}`);
  assert(result.data.payload.id, 'Workspace should have an ID');

  testWorkspaceId = result.data.payload.id;
  console.log(`✅ Created workspace: ${testWorkspaceId}`);
}

async function test2_createTestContext() {
  console.log('\n🧪 Test 2: Creating test context...');

  // Use timestamp to ensure unique context ID
  const contextId = `testshare${Date.now().toString().slice(-6)}`;

  const result = await apiRequest('POST', '/contexts', {
    id: contextId,
    url: '/',
    description: 'Context for testing sharing functionality'
  });

  assert.strictEqual(result.status, 201, `Expected 201, got ${result.status}: ${JSON.stringify(result.data)}`);

  // Context response structure: { payload: { context: {...} } }
  const contextData = result.data.payload?.context || result.data.payload;
  assert(contextData, 'Context data should be returned');
  assert(contextData.id, 'Context should have an ID');

  testContextId = contextData.id;
  console.log(`✅ Created context: ${testContextId}`);
}

async function test3_createWorkspaceToken() {
  console.log('\n🧪 Test 3: Creating workspace sharing token...');

  if (!testWorkspaceId) {
    throw new Error('testWorkspaceId is null - workspace creation must have failed');
  }

  const result = await apiRequest('POST', `/workspaces/${testWorkspaceId}/tokens`, {
    permissions: ['read', 'write'],
    description: 'Test workspace sharing token',
    expiresAt: null
  });

  assert.strictEqual(result.status, 201, `Expected 201, got ${result.status}: ${JSON.stringify(result.data)}`);
  assert(result.data.payload.token, 'Token should be returned');
  assert(result.data.payload.token.startsWith('canvas-'), 'Token should have canvas- prefix');

  workspaceToken = result.data.payload.token;
  console.log(`✅ Created workspace token: ${workspaceToken.substring(0, 20)}...`);
}

async function test4_createContextToken() {
  console.log('\n🧪 Test 4: Creating context sharing token...');

  if (!testContextId) {
    throw new Error('testContextId is null - context creation must have failed');
  }

  const result = await apiRequest('POST', `/contexts/${testContextId}/tokens`, {
    permissions: ['documentRead', 'documentWrite'],
    description: 'Test context sharing token',
    type: 'standard'
  });

  assert.strictEqual(result.status, 201, `Expected 201, got ${result.status}: ${JSON.stringify(result.data)}`);
  assert(result.data.payload.token, 'Token should be returned');
  assert(result.data.payload.token.startsWith('canvas-'), 'Token should have canvas- prefix');

  contextToken = result.data.payload.token;
  console.log(`✅ Created context token: ${contextToken.substring(0, 20)}...`);
}

async function test5_createSecretLinkToken() {
  console.log('\n🧪 Test 5: Creating secret link token...');

  if (!testContextId) {
    throw new Error('testContextId is null - context creation must have failed');
  }

  // Create a secret link token with usage limits
  const expirationDate = new Date();
  expirationDate.setHours(expirationDate.getHours() + 24); // 24 hours from now

  const result = await apiRequest('POST', `/contexts/${testContextId}/tokens`, {
    permissions: ['documentRead'],
    description: 'Secret link for sharing',
    type: 'secret-link',
    maxUses: 5,
    expiresAt: expirationDate.toISOString()
  });

  assert.strictEqual(result.status, 201, `Expected 201, got ${result.status}: ${JSON.stringify(result.data)}`);
  assert.strictEqual(result.data.payload.type, 'secret-link', 'Token should be secret-link type');
  assert.strictEqual(result.data.payload.maxUses, 5, 'Token should have max uses');
  assert(result.data.payload.expiresAt, 'Token should have expiration');

  console.log(`✅ Created secret link token with 5 max uses, expires: ${result.data.payload.expiresAt}`);
}

async function test6_accessWorkspaceViaToken() {
  console.log('\n🧪 Test 6: Accessing workspace via token...');

  // Test accessing workspace info via token
  const result = await pubRequest('GET', `/workspaces/${testWorkspaceId}`, null, workspaceToken);

  assert.strictEqual(result.status, 200, `Expected 200, got ${result.status}: ${JSON.stringify(result.data)}`);
  assert.strictEqual(result.data.payload.id, testWorkspaceId, 'Should return correct workspace');

  console.log(`✅ Successfully accessed workspace via token`);
}

async function test7_accessContextViaToken() {
  console.log('\n🧪 Test 7: Accessing context via token...');

  // Test accessing context info via token
  const result = await pubRequest('GET', `/contexts/${testContextId}`, null, contextToken);

  assert.strictEqual(result.status, 200, `Expected 200, got ${result.status}: ${JSON.stringify(result.data)}`);
  assert.strictEqual(result.data.payload.id, testContextId, 'Should return correct context');

  console.log(`✅ Successfully accessed context via token`);
}

async function test8_insertDocumentsViaToken() {
  console.log('\n🧪 Test 8: Inserting documents via workspace token...');

  const testDocuments = [
    {
      content: 'This is a test document inserted via workspace token',
      metadata: { source: 'workspace-token-test' }
    },
    {
      content: 'Another test document for workspace sharing',
      metadata: { source: 'workspace-token-test', type: 'secondary' }
    }
  ];

  const result = await pubRequest('POST', `/workspaces/${testWorkspaceId}/documents`, {
    documents: testDocuments
  }, workspaceToken);

  assert.strictEqual(result.status, 201, `Expected 201, got ${result.status}: ${JSON.stringify(result.data)}`);
  assert(Array.isArray(result.data.payload), 'Should return array of inserted documents');

  console.log(`✅ Successfully inserted ${result.data.payload.length} documents via workspace token`);
}

async function test9_insertDocumentsViaContextToken() {
  console.log('\n🧪 Test 9: Inserting documents via context token...');

  const testDocuments = [
    {
      content: 'This is a test document inserted via context token',
      metadata: { source: 'context-token-test' }
    }
  ];

  const result = await pubRequest('POST', `/contexts/${testContextId}/documents`, {
    documents: testDocuments
  }, contextToken);

  assert.strictEqual(result.status, 201, `Expected 201, got ${result.status}: ${JSON.stringify(result.data)}`);
  assert(Array.isArray(result.data.payload), 'Should return array of inserted documents');

  console.log(`✅ Successfully inserted ${result.data.payload.length} documents via context token`);
}

async function test10_validateToken() {
  console.log('\n🧪 Test 10: Validating token via token API...');

  const result = await pubRequest('POST', '/tokens/validate', {
    resourceType: 'workspace',
    resourceId: testWorkspaceId,
    requiredPermission: 'read'
  }, workspaceToken);

  assert.strictEqual(result.status, 200, `Expected 200, got ${result.status}: ${JSON.stringify(result.data)}`);
  assert.strictEqual(result.data.payload.valid, true, 'Token should be valid');
  assert.strictEqual(result.data.payload.resourceType, 'workspace', 'Should return correct resource type');

  console.log(`✅ Token validation successful`);
}

async function test11_getTokenInfo() {
  console.log('\n🧪 Test 11: Getting token info...');

  const result = await pubRequest('GET', `/tokens/info`, null, contextToken);

  assert.strictEqual(result.status, 200, `Expected 200, got ${result.status}: ${JSON.stringify(result.data)}`);
  assert.strictEqual(result.data.payload.resourceType, 'context', 'Should return correct resource type');
  assert.strictEqual(result.data.payload.resourceId, testContextId, 'Should return correct resource ID');
  assert(result.data.payload.tokenData, 'Should return token data');

  console.log(`✅ Token info retrieved successfully`);
}

async function test12_listWorkspaceTokens() {
  console.log('\n🧪 Test 12: Listing workspace tokens...');

  const result = await apiRequest('GET', `/workspaces/${testWorkspaceId}/tokens`);

  assert.strictEqual(result.status, 200, `Expected 200, got ${result.status}: ${JSON.stringify(result.data)}`);
  assert(Array.isArray(result.data.payload), 'Should return array of tokens');
  assert(result.data.payload.length > 0, 'Should have at least one token');

  console.log(`✅ Listed ${result.data.payload.length} workspace tokens`);
}

async function test13_listContextTokens() {
  console.log('\n🧪 Test 13: Listing context tokens...');

  const result = await apiRequest('GET', `/contexts/${testContextId}/tokens`);

  assert.strictEqual(result.status, 200, `Expected 200, got ${result.status}: ${JSON.stringify(result.data)}`);
  assert(Array.isArray(result.data.payload), 'Should return array of tokens');
  assert(result.data.payload.length >= 2, 'Should have at least 2 tokens (standard + secret-link)');

  console.log(`✅ Listed ${result.data.payload.length} context tokens`);
}

async function test14_accessDeniedWithoutToken() {
  console.log('\n🧪 Test 14: Testing access denied without token...');

  const result = await pubRequest('GET', `/workspaces/${testWorkspaceId}`, null, null);

  assert.strictEqual(result.status, 403, `Expected 403, got ${result.status}: ${JSON.stringify(result.data)}`);

  console.log(`✅ Access properly denied without token`);
}

async function test15_accessDeniedWithInvalidToken() {
  console.log('\n🧪 Test 15: Testing access denied with invalid token...');

  const invalidToken = 'canvas-invalid-token-123456789';
  const result = await pubRequest('GET', `/workspaces/${testWorkspaceId}`, null, invalidToken);

  assert.strictEqual(result.status, 403, `Expected 403, got ${result.status}: ${JSON.stringify(result.data)}`);

  console.log(`✅ Access properly denied with invalid token`);
}

async function test16_healthCheck() {
  console.log('\n🧪 Test 16: Testing pub routes health check...');

  const result = await pubRequest('GET', '/health', null, null);

  assert.strictEqual(result.status, 200, `Expected 200, got ${result.status}: ${JSON.stringify(result.data)}`);
  assert.strictEqual(result.data.status, 'ok', 'Health check should return ok');
  assert(Array.isArray(result.data.routes), 'Should return routes array');

  console.log(`✅ Health check passed - Available routes: ${result.data.routes.join(', ')}`);
}

// Cleanup function
async function cleanup() {
  console.log('\n🧹 Cleaning up test resources...');

  try {
    // Delete test context
    if (testContextId) {
      await apiRequest('DELETE', `/contexts/${testContextId}`);
      console.log(`✅ Deleted test context: ${testContextId}`);
    }

    // Delete test workspace
    if (testWorkspaceId) {
      await apiRequest('DELETE', `/workspaces/${testWorkspaceId}`);
      console.log(`✅ Deleted test workspace: ${testWorkspaceId}`);
    }
  } catch (error) {
    console.warn(`⚠️  Cleanup warning: ${error.message}`);
  }
}

// Main test runner
async function runTests() {
  console.log('🚀 Starting Canvas Sharing Functionality Tests');
  console.log(`📡 Testing against: ${BASE_URL}`);
  console.log(`🔑 Using token: ${TOKEN.substring(0, 20)}...`);

  const tests = [
    test1_createTestWorkspace,
    test2_createTestContext,
    test3_createWorkspaceToken,
    test4_createContextToken,
    test5_createSecretLinkToken,
    test6_accessWorkspaceViaToken,
    test7_accessContextViaToken,
    test8_insertDocumentsViaToken,
    test9_insertDocumentsViaContextToken,
    test10_validateToken,
    test11_getTokenInfo,
    test12_listWorkspaceTokens,
    test13_listContextTokens,
    test14_accessDeniedWithoutToken,
    test15_accessDeniedWithInvalidToken,
    test16_healthCheck
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (error) {
      console.error(`❌ ${test.name} failed:`, error.message);
      failed++;
    }
  }

  console.log('\n📊 Test Results:');
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Success Rate: ${Math.round((passed / (passed + failed)) * 100)}%`);

  if (failed === 0) {
    console.log('\n🎉 All tests passed! Sharing functionality is working correctly.');
  } else {
    console.log('\n⚠️  Some tests failed. Please check the implementation.');
  }

  // Always run cleanup
  await cleanup();

  process.exit(failed > 0 ? 1 : 0);
}

// Handle uncaught errors
process.on('unhandledRejection', async (error) => {
  console.error('❌ Unhandled error:', error);
  await cleanup();
  process.exit(1);
});

// Run tests
runTests().catch(async (error) => {
  console.error('❌ Test runner error:', error);
  await cleanup();
  process.exit(1);
});
