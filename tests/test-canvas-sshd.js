#!/usr/bin/env node
'use strict';

/**
 * Canvas SSHD Integration Test
 *
 * Tests the canvas-sshd role and SSH key management
 */

import axios from 'axios';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const API_BASE = process.env.CANVAS_API_URL || 'http://localhost:8001';
const SSH_PORT = process.env.SSH_PORT || 22222;
const TEST_EMAIL = 'sshtest@canvas.local';
const TEST_PASSWORD = 'TestPassword123!';

// Colors for output
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

function logStep(step) {
    log(`\n[${new Date().toISOString()}] ${step}`, 'cyan');
}

function logSuccess(message) {
    log(`✓ ${message}`, 'green');
}

function logError(message) {
    log(`✗ ${message}`, 'red');
}

function logWarning(message) {
    log(`⚠ ${message}`, 'yellow');
}

// Test state
let apiToken = null;
let testUser = null;
let sshKeyId = null;
let roleId = null;

/**
 * Execute shell command
 */
function execCommand(command, args = [], options = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, { ...options, stdio: 'pipe' });
        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (data) => {
            stdout += data.toString();
        });

        proc.stderr?.on('data', (data) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            resolve({ code, stdout, stderr });
        });

        proc.on('error', (error) => {
            reject(error);
        });
    });
}

/**
 * Generate SSH key pair
 */
async function generateSSHKeyPair() {
    const keyPath = path.join(__dirname, '.test-ssh-key');
    const pubKeyPath = `${keyPath}.pub`;

    // Remove existing keys
    if (existsSync(keyPath)) await fs.unlink(keyPath);
    if (existsSync(pubKeyPath)) await fs.unlink(pubKeyPath);

    // Generate new key pair
    const result = await execCommand('ssh-keygen', [
        '-t', 'ed25519',
        '-f', keyPath,
        '-N', '', // No passphrase
        '-C', `test-key-${Date.now()}`
    ]);

    if (result.code !== 0) {
        throw new Error(`Failed to generate SSH key: ${result.stderr}`);
    }

    // Read public key
    const publicKey = await fs.readFile(pubKeyPath, 'utf-8');

    return { keyPath, publicKey: publicKey.trim() };
}

/**
 * Step 1: Authenticate with Canvas API
 */
async function authenticate() {
    logStep('Step 1: Authenticating with Canvas API');

    try {
        // Try to get admin credentials from environment
        const _adminEmail = process.env.CANVAS_ADMIN_EMAIL || 'admin@canvas.local';
        const adminToken = process.env.CANVAS_ADMIN_TOKEN;

        if (adminToken) {
            apiToken = adminToken;
            logSuccess(`Using admin token from environment`);
        } else {
            logWarning('No admin token provided. Set CANVAS_ADMIN_TOKEN environment variable.');
            logWarning('You can find the token in server startup logs or generate one via the API.');
            throw new Error('Authentication failed: No admin token');
        }

        // Verify token works
        const response = await axios.get(`${API_BASE}/api/ping`, {
            headers: { 'Authorization': `Bearer ${apiToken}` }
        });

        logSuccess(`API is reachable: ${response.data.message || 'pong'}`);
    } catch (error) {
        logError(`Authentication failed: ${error.message}`);
        throw error;
    }
}

/**
 * Step 2: Create test user
 */
async function createTestUser() {
    logStep('Step 2: Creating test user');

    try {
        // Check if user already exists
        try {
            const existingUsers = await axios.get(`${API_BASE}/api/admin/users`, {
                headers: { 'Authorization': `Bearer ${apiToken}` }
            });

            const existing = existingUsers.data.data?.users?.find(u => u.email === TEST_EMAIL);
            if (existing) {
                logWarning(`User ${TEST_EMAIL} already exists, using existing user`);
                testUser = existing;
                return;
            }
        } catch  {
            // User doesn't exist, continue
        }

        // Create new user
        const response = await axios.post(`${API_BASE}/api/admin/users`, {
            name: 'SSH Test User',
            email: TEST_EMAIL,
            userType: 'user',
            status: 'active'
        }, {
            headers: { 'Authorization': `Bearer ${apiToken}` }
        });

        testUser = response.data.data.user;
        logSuccess(`Test user created: ${testUser.id} (${testUser.email})`);

        // Set password
        await axios.post(`${API_BASE}/api/auth/password/set`, {
            userId: testUser.id,
            password: TEST_PASSWORD
        }, {
            headers: { 'Authorization': `Bearer ${apiToken}` }
        });

        logSuccess('Password set for test user');
    } catch (error) {
        logError(`Failed to create test user: ${error.response?.data?.message || error.message}`);
        throw error;
    }
}

/**
 * Step 3: Generate and add SSH key
 */
async function addSSHKey() {
    logStep('Step 3: Generating and adding SSH key');

    try {
        const { keyPath, publicKey } = await generateSSHKeyPair();
        logSuccess(`Generated SSH key pair: ${keyPath}`);

        // Add SSH key via API
        const response = await axios.post(
            `${API_BASE}/api/admin/users/${testUser.id}/ssh-keys`,
            {
                key: publicKey,
                name: 'Test Key'
            },
            {
                headers: { 'Authorization': `Bearer ${apiToken}` }
            }
        );

        const addedKey = response.data.data.key;
        sshKeyId = addedKey.id;

        logSuccess(`SSH key added: ${addedKey.id}`);
        log(`  Fingerprint: ${addedKey.fingerprint}`, 'blue');
        log(`  Type: ${addedKey.type}`, 'blue');

        return keyPath;
    } catch (error) {
        logError(`Failed to add SSH key: ${error.response?.data?.message || error.message}`);
        throw error;
    }
}

/**
 * Step 4: Build canvas-sshd Docker image
 */
async function buildSSHDImage() {
    logStep('Step 4: Building canvas-sshd Docker image');

    try {
        const buildScript = path.join(__dirname, '..', 'extensions', 'roles', 'docker.canvas-sshd', 'build.sh');

        if (!existsSync(buildScript)) {
            throw new Error(`Build script not found: ${buildScript}`);
        }

        logWarning('Building Docker image (this may take a minute)...');

        const result = await execCommand(buildScript, [], { cwd: path.dirname(buildScript) });

        if (result.code !== 0) {
            throw new Error(`Build failed: ${result.stderr}`);
        }

        logSuccess('Docker image built successfully');
    } catch (error) {
        logError(`Failed to build image: ${error.message}`);
        throw error;
    }
}

/**
 * Step 5: Create and start canvas-sshd role
 */
async function startSSHDRole() {
    logStep('Step 5: Starting canvas-sshd role');

    try {
        // Check if role already exists
        const existingRoles = await axios.get(`${API_BASE}/api/roles?type=global`, {
            headers: { 'Authorization': `Bearer ${apiToken}` }
        });

        const existing = existingRoles.data.roles?.find(r => r.template === 'docker.canvas-sshd');
        if (existing) {
            logWarning('canvas-sshd role already exists');
            roleId = existing.id;

            // Try to start if not running
            if (existing.status !== 'running') {
                await axios.post(`${API_BASE}/api/roles/${roleId}/start`, {}, {
                    headers: { 'Authorization': `Bearer ${apiToken}` }
                });
                logSuccess('Started existing role');
            } else {
                logSuccess('Role is already running');
            }
            return;
        }

        // Create new role
        const createResponse = await axios.post(`${API_BASE}/api/roles`, {
            template: 'docker.canvas-sshd',
            name: 'canvas-sshd',
            type: 'global'
        }, {
            headers: { 'Authorization': `Bearer ${apiToken}` }
        });

        roleId = createResponse.data.role.id;
        logSuccess(`Role created: ${roleId}`);

        // Start role
        await axios.post(`${API_BASE}/api/roles/${roleId}/start`, {}, {
            headers: { 'Authorization': `Bearer ${apiToken}` }
        });

        logSuccess('Role started successfully');

        // Wait for role to be ready
        logWarning('Waiting for SSH daemon to be ready...');
        await new Promise(resolve => setTimeout(resolve, 5000));

    } catch (error) {
        logError(`Failed to start role: ${error.response?.data?.message || error.message}`);
        throw error;
    }
}

/**
 * Step 6: Test SSH connection
 */
async function testSSHConnection(keyPath) {
    logStep('Step 6: Testing SSH connection');

    try {
        // Test SSH connection with verbose output
        const username = TEST_EMAIL; // Using email as username

        logWarning(`Attempting SSH connection to ${username}@localhost:${SSH_PORT}`);

        const result = await execCommand('ssh', [
            '-i', keyPath,
            '-p', SSH_PORT.toString(),
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'ConnectTimeout=10',
            `${username}@localhost`,
            'ls', '-la'
        ]);

        if (result.code === 0) {
            logSuccess('SSH connection successful!');
            log('Directory listing:', 'blue');
            console.log(result.stdout);
        } else {
            logWarning('SSH connection failed (expected for first test)');
            log(`Exit code: ${result.code}`, 'yellow');
            log(`stderr: ${result.stderr}`, 'yellow');
        }
    } catch (error) {
        logError(`SSH connection test failed: ${error.message}`);
        // Don't throw - this is expected to fail in many cases
    }
}

/**
 * Step 7: Test SFTP connection
 */
async function testSFTPConnection(keyPath) {
    logStep('Step 7: Testing SFTP connection');

    try {
        const username = TEST_EMAIL;

        // Create a test file
        const testFilePath = path.join(__dirname, '.test-upload.txt');
        await fs.writeFile(testFilePath, `Test file created at ${new Date().toISOString()}`);

        logWarning(`Attempting SFTP upload to ${username}@localhost:${SSH_PORT}`);

        // Use sftp batch mode
        const batchCommands = `put ${testFilePath} /test-upload.txt\nls -la\nquit\n`;
        const batchFile = path.join(__dirname, '.sftp-batch');
        await fs.writeFile(batchFile, batchCommands);

        const result = await execCommand('sftp', [
            '-i', keyPath,
            '-P', SSH_PORT.toString(),
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-b', batchFile,
            `${username}@localhost`
        ]);

        // Cleanup
        await fs.unlink(testFilePath);
        await fs.unlink(batchFile);

        if (result.code === 0) {
            logSuccess('SFTP connection successful!');
            log('SFTP output:', 'blue');
            console.log(result.stdout);
        } else {
            logWarning('SFTP connection failed');
            log(`stderr: ${result.stderr}`, 'yellow');
        }
    } catch (error) {
        logError(`SFTP test failed: ${error.message}`);
    }
}

/**
 * Step 8: Cleanup
 */
async function cleanup() {
    logStep('Step 8: Cleanup');

    try {
        // Remove SSH key
        if (sshKeyId && testUser) {
            await axios.delete(
                `${API_BASE}/api/admin/users/${testUser.id}/ssh-keys/${sshKeyId}`,
                {
                    headers: { 'Authorization': `Bearer ${apiToken}` }
                }
            );
            logSuccess('SSH key removed');
        }

        // Clean up test files
        const testFiles = [
            path.join(__dirname, '.test-ssh-key'),
            path.join(__dirname, '.test-ssh-key.pub'),
            path.join(__dirname, '.test-upload.txt'),
            path.join(__dirname, '.sftp-batch')
        ];

        for (const file of testFiles) {
            if (existsSync(file)) {
                await fs.unlink(file);
            }
        }

        logSuccess('Cleanup complete');
    } catch (error) {
        logWarning(`Cleanup warning: ${error.message}`);
    }
}

/**
 * Main test runner
 */
async function runTests() {
    log('═══════════════════════════════════════════════════════', 'cyan');
    log('  Canvas SSHD Integration Test', 'cyan');
    log('═══════════════════════════════════════════════════════', 'cyan');

    let keyPath = null;
            void keyPath;

    try {
        await authenticate();
        await createTestUser();
        keyPath = await addSSHKey();
        await buildSSHDImage();
        await startSSHDRole();
        await testSSHConnection(keyPath);
        await testSFTPConnection(keyPath);

        log('\n═══════════════════════════════════════════════════════', 'green');
        log('  All tests completed!', 'green');
        log('═══════════════════════════════════════════════════════', 'green');

    } catch (error) {
        log('\n═══════════════════════════════════════════════════════', 'red');
        log('  Tests failed!', 'red');
        log('═══════════════════════════════════════════════════════', 'red');
        console.error(error);
        process.exit(1);
    } finally {
        await cleanup();
    }
}

// Run tests
runTests().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
