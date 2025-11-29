#!/usr/bin/env node

/**
 * Test script for dotfile manager functionality
 */

import { env } from '../src/env.js';
import UserManager from '../src/core/user/index.js';
import WorkspaceManager from '../src/core/workspace/index.js';
import ContextManager from '../src/core/context/index.js';
import DotfileManager from '../src/core/workspace/services/dotfile/index.js';
import Jim from '../src/utils/jim/index.js';
import path from 'path';

async function testDotfiles() {
    console.log('🔄 Starting Dotfile Manager Test...\n');

    // Initialize Jim for data storage
    const jim = new Jim({
        rootPath: path.join('/tmp', 'canvas-test-dotfiles', 'db'),
        driver: 'conf',
        driverOptions: {
            accessPropertiesByDotNotation: false,
        }
    });

    // Initialize managers
    const userManager = new UserManager({
        rootPath: path.join('/tmp', 'canvas-test-dotfiles', 'users'),
        indexStore: jim.createIndex('users'),
    });

    const workspaceManager = new WorkspaceManager({
        defaultRootPath: path.join('/tmp', 'canvas-test-dotfiles', 'workspaces'),
        indexStore: jim.createIndex('workspaces'),
        userManager: userManager,
    });

    const contextManager = new ContextManager({
        indexStore: jim.createIndex('contexts'),
        workspaceManager: workspaceManager
    });

    const dotfileManager = new DotfileManager({
        workspaceManager: workspaceManager
    });

    // Set cross-references
    userManager.setWorkspaceManager(workspaceManager);
    userManager.setContextManager(contextManager);

    // Initialize all managers
    await userManager.initialize();
    await workspaceManager.initialize();
    await contextManager.initialize();
    await dotfileManager.initialize();

    try {
        // Create a test user with unique name
        const timestamp = Date.now();
        const testUser = await userManager.createUser({
            email: `test.dotfiles.${timestamp}@example.com`,
            name: `dotfile-test-user-${timestamp}`,
            password: 'test123'
        });
        console.log(`✅ Created test user: ${testUser.email} (ID: ${testUser.id})`);

        // Create a test workspace
        const workspace = await workspaceManager.createWorkspace(
            testUser.id,
            `dotfile-test-workspace-${timestamp}`,
            {
                owner: testUser.id,
                label: 'Dotfile Test Workspace',
                description: 'Workspace for testing dotfile functionality',
                color: '#4f8a8b'
            }
        );
        console.log(`✅ Created test workspace: ${workspace.name} (ID: ${workspace.id})`);

        // Test 1: Check repository status (should be uninitialized)
        console.log('\n📋 Test 1: Check repository status (uninitialized)');
        const statusBefore = await dotfileManager.getRepositoryStatus(
            testUser.id,
            workspace.id,
            testUser.id
        );
        console.log(`   Repository initialized: ${statusBefore.initialized}`);
        console.log(`   Repository path: ${statusBefore.path}`);

        // Test 2: Initialize repository
        console.log('\n🚀 Test 2: Initialize dotfile repository');
        const initResult = await dotfileManager.initializeRepository(
            testUser.id,
            workspace.id,
            testUser.id
        );
        console.log(`   Success: ${initResult.success}`);
        console.log(`   Message: ${initResult.message}`);
        console.log(`   Path: ${initResult.path}`);

        // Test 3: Check repository status (should be initialized)
        console.log('\n📋 Test 3: Check repository status (initialized)');
        const statusAfter = await dotfileManager.getRepositoryStatus(
            testUser.id,
            workspace.id,
            testUser.id
        );
        console.log(`   Repository initialized: ${statusAfter.initialized}`);
        console.log(`   Repository path: ${statusAfter.path}`);
        console.log(`   Is bare: ${statusAfter.bare}`);
        console.log(`   Branches: ${JSON.stringify(statusAfter.branches)}`);
        console.log(`   Current branch: ${statusAfter.currentBranch}`);

        // Test 4: Check if repository exists
        console.log('\n🔍 Test 4: Check if repository exists');
        const hasRepo = await dotfileManager.hasRepository(
            testUser.id,
            workspace.id,
            testUser.id
        );
        console.log(`   Repository exists: ${hasRepo}`);

        // Test 5: Try to initialize again (should report already initialized)
        console.log('\n♻️  Test 5: Try to initialize again');
        const initAgainResult = await dotfileManager.initializeRepository(
            testUser.id,
            workspace.id,
            testUser.id
        );
        console.log(`   Success: ${initAgainResult.success}`);
        console.log(`   Message: ${initAgainResult.message}`);

        console.log('\n✅ All dotfile manager tests passed!\n');

        // Cleanup
        console.log('🧹 Cleaning up test data...');
        await workspaceManager.removeWorkspace(
            testUser.id,
            workspace.id,
            testUser.id,
            true // destroyData
        );
        console.log('   ✅ Removed test workspace');
        console.log('   ℹ️  Test user will be cleaned up automatically');

        console.log('\n🎉 Dotfile Manager Test completed successfully!');

    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// Run the test
testDotfiles().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});
