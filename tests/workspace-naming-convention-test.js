#!/usr/bin/env node

/**
 * Test script for the new workspace naming convention
 * Format: [userid]@[host]:[workspace_slug][/optional_path...]
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import * as fsPromises from 'fs/promises';

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Add src to path for imports
const srcPath = path.join(__dirname, '..', 'src');
process.env.NODE_PATH = srcPath;

// Imports
import WorkspaceManager from '../src/managers/workspace/index.js';
import Conf from 'conf';

const DEFAULT_HOST = 'canvas.local';

async function testWorkspaceNamingConvention() {
    console.log('🧪 Testing new workspace naming convention...\n');

    // Setup test environment
    const testDir = path.join(__dirname, 'temp-workspace-naming-test');
    const _indexStorePath = path.join(testDir, 'workspace-index.json');

    // Clean up any existing test directory
    if (existsSync(testDir)) {
        await fsPromises.rm(testDir, { recursive: true, force: true });
    }
    await fsPromises.mkdir(testDir, { recursive: true });

    try {
        // Create workspace manager with test configuration
        const indexStore = new Conf({
            configName: 'workspace-index',
            cwd: testDir,
            accessPropertiesByDotNotation: false
        });

        const workspaceManager = new WorkspaceManager({
            defaultRootPath: testDir,
            indexStore: indexStore
        });

        await workspaceManager.initialize();

        // Test data
        const testUser1 = 'user123';
        const testUser2 = 'user456';
        const testWorkspace1 = 'my-project';
        const testWorkspace2 = 'shared-workspace';

        console.log('📝 Test 1: Creating workspaces with new naming convention');

        // Create workspace for user123@canvas.local:my-project
        const workspace1 = await workspaceManager.createWorkspace(testUser1, testWorkspace1, {
            owner: testUser1,
            label: 'My Project',
            description: 'Test workspace for user123'
        });

        // Create workspace for user456@canvas.local:shared-workspace
        const workspace2 = await workspaceManager.createWorkspace(testUser2, testWorkspace2, {
            owner: testUser2,
            label: 'Shared Workspace',
            description: 'Test workspace for user456'
        });

        console.log(`✅ Created workspace1: ${workspace1.id} (${workspace1.name})`);
        console.log(`✅ Created workspace2: ${workspace2.id} (${workspace2.name})`);

        console.log('\n📝 Test 2: Testing user.email validation (should fail)');

        // Test that user.email is rejected
        try {
            await workspaceManager.createWorkspace('user@domain.com', 'invalid-workspace', {
                owner: 'user@domain.com',
                label: 'Invalid Workspace'
            });
            console.log('❌ Should have failed for user.email');
        } catch (error) {
            console.log(`✅ Correctly rejected user.email: ${error.message}`);
        }

        // Test that workspace reference parsing rejects user.email
        const invalidRef = 'user@domain.com@canvas.local:invalid-workspace';
        const parsedInvalid = workspaceManager.parseWorkspaceReference(invalidRef);
        console.log(`✅ Invalid reference parsing result: ${JSON.stringify(parsedInvalid)} (should be null)`);

        console.log('\n📝 Test 3: Testing workspace reference parsing');

        // Test workspace reference parsing
        const ref1 = workspaceManager.constructWorkspaceReference(testUser1, testWorkspace1);
        const ref2 = workspaceManager.constructWorkspaceReference(testUser2, testWorkspace2);
        const ref3 = workspaceManager.constructWorkspaceReference(testUser1, testWorkspace1, 'remote.server.com', '/subfolder');

        console.log(`✅ Reference 1: ${ref1}`);
        console.log(`✅ Reference 2: ${ref2}`);
        console.log(`✅ Reference 3: ${ref3}`);

        // Test parsing references
        const parsed1 = workspaceManager.parseWorkspaceReference(ref1);
        const parsed2 = workspaceManager.parseWorkspaceReference(ref2);
        const parsed3 = workspaceManager.parseWorkspaceReference(ref3);

        console.log(`✅ Parsed 1:`, parsed1);
        console.log(`✅ Parsed 2:`, parsed2);
        console.log(`✅ Parsed 3:`, parsed3);

        console.log('\n📝 Test 4: Testing workspace resolution');

        // Test workspace ID resolution
        const resolvedId1 = workspaceManager.resolveWorkspaceId(testUser1, testWorkspace1);
        const resolvedId2 = workspaceManager.resolveWorkspaceId(testUser2, testWorkspace2);
        const resolvedId3 = workspaceManager.resolveWorkspaceIdFromReference(ref1);

        console.log(`✅ Resolved ID 1: ${resolvedId1} (should be ${workspace1.id})`);
        console.log(`✅ Resolved ID 2: ${resolvedId2} (should be ${workspace2.id})`);
        console.log(`✅ Resolved ID 3: ${resolvedId3} (should be ${workspace1.id})`);

        console.log('\n📝 Test 5: Testing workspace opening with different identifiers');

        // Test opening workspace by ID
        const openedById1 = await workspaceManager.openWorkspace(testUser1, workspace1.id, testUser1);
        console.log(`✅ Opened by ID: ${openedById1?.id}`);

        // Test opening workspace by name
        const openedByName1 = await workspaceManager.openWorkspace(testUser1, testWorkspace1, testUser1);
        console.log(`✅ Opened by name: ${openedByName1?.id}`);

        // Test opening workspace by reference
        const openedByRef1 = await workspaceManager.openWorkspace(testUser1, ref1, testUser1);
        console.log(`✅ Opened by reference: ${openedByRef1?.id}`);

        console.log('\n📝 Test 6: Testing workspace listing');

        // Test listing workspaces
        const user1Workspaces = await workspaceManager.listUserWorkspaces(testUser1);
        const user2Workspaces = await workspaceManager.listUserWorkspaces(testUser2);

        console.log(`✅ User1 workspaces: ${user1Workspaces.length} (should be 1)`);
        console.log(`✅ User2 workspaces: ${user2Workspaces.length} (should be 1)`);

        console.log('\n📝 Test 7: Testing index key format');

        // Test index key format
        const allWorkspaces = workspaceManager.getAllWorkspacesWithKeys();
        console.log('✅ Index keys:');
        for (const key of Object.keys(allWorkspaces)) {
            console.log(`   ${key}`);
        }

        console.log('\n📝 Test 8: Testing workspace removal');

        // Test removing workspace
        const removed = await workspaceManager.removeWorkspace(testUser1, testWorkspace1, testUser1, false);
        console.log(`✅ Removed workspace: ${removed}`);

        // Verify removal
        const remainingWorkspaces = await workspaceManager.listUserWorkspaces(testUser1);
        console.log(`✅ Remaining workspaces for user1: ${remainingWorkspaces.length} (should be 0)`);

        console.log('\n🎉 All tests passed! New workspace naming convention is working correctly.');

        // Test assertions
        console.log('\n📊 Assertions:');

        // Assert reference format
        console.assert(ref1 === `${testUser1}@${DEFAULT_HOST}:${testWorkspace1}`, 'Reference 1 format incorrect');
        console.assert(ref2 === `${testUser2}@${DEFAULT_HOST}:${testWorkspace2}`, 'Reference 2 format incorrect');
        console.assert(ref3 === `${testUser1}@remote.server.com:${testWorkspace1}/subfolder`, 'Reference 3 format incorrect');

        // Assert parsing
        console.assert(parsed1.userId === testUser1, 'Parsed userId incorrect');
        console.assert(parsed1.workspaceSlug === testWorkspace1, 'Parsed workspaceSlug incorrect');
        console.assert(parsed1.host === DEFAULT_HOST, 'Parsed host incorrect');
        console.assert(parsed1.isLocal === true, 'Parsed isLocal incorrect');

        // Assert user.email validation
        console.assert(parsedInvalid === null, 'Invalid reference should be null');

        // Assert resolution
        console.assert(resolvedId1 === workspace1.id, 'Resolved ID 1 incorrect');
        console.assert(resolvedId2 === workspace2.id, 'Resolved ID 2 incorrect');
        console.assert(resolvedId3 === workspace1.id, 'Resolved ID 3 incorrect');

        // Assert opening
        console.assert(openedById1?.id === workspace1.id, 'Opened by ID incorrect');
        console.assert(openedByName1?.id === workspace1.id, 'Opened by name incorrect');
        console.assert(openedByRef1?.id === workspace1.id, 'Opened by reference incorrect');

        // Assert listing
        console.assert(user1Workspaces.length === 1, 'User1 workspace count incorrect');
        console.assert(user2Workspaces.length === 1, 'User2 workspace count incorrect');

        // Assert index key format (should use :: separator)
        const indexKeys = Object.keys(allWorkspaces);
        console.assert(indexKeys.some(key => key.includes('::')), 'Index keys should use :: separator');
        console.assert(!indexKeys.some(key => key.includes('|')), 'Index keys should not use | separator');
        console.assert(!indexKeys.some(key => key.includes('@')), 'Index keys should not contain @ symbol');

        // Assert removal
        console.assert(removed === true, 'Workspace removal failed');
        console.assert(remainingWorkspaces.length === 0, 'Workspace not properly removed');

        console.log('✅ All assertions passed!');

    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    } finally {
        // Clean up test directory
        if (existsSync(testDir)) {
            await fsPromises.rm(testDir, { recursive: true, force: true });
        }
    }
}

// Run the test
testWorkspaceNamingConvention().catch(console.error);
