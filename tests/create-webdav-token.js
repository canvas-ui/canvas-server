#!/usr/bin/env node

/**
 * WebDAV Token Helper Script
 * Helps users create API tokens for WebDAV access
 */

import { authService } from '../src/api/auth/service.js';
import { jim } from '../src/Server.js';

const DEBUG = process.env.DEBUG || 'webdav:*';
process.env.DEBUG = DEBUG;

/**
 * Create a WebDAV API token for a user
 */
async function createWebDAVToken(userEmail, tokenName = 'WebDAV Access Token') {
  try {
    // Initialize auth service
    await authService.initialize();

    // Find user by email
    const userIndex = jim.createIndex('users');
    const users = userIndex.store ? Object.values(userIndex.store) : [];
    const user = users.find(u => u.email === userEmail);

    if (!user) {
      throw new Error(`User with email ${userEmail} not found`);
    }

    console.log(`Creating WebDAV token for user: ${user.email} (${user.id})`);

    // Create API token
    const token = await authService.createToken(user.id, {
      name: tokenName,
      description: 'API token for WebDAV access',
      type: 'api'
    });

    console.log('\n✅ WebDAV API Token Created Successfully!');
    console.log('='.repeat(50));
    console.log(`Token Name: ${token.name}`);
    console.log(`Token Value: ${token.value}`);
    console.log(`Created: ${token.createdAt}`);
    console.log('='.repeat(50));
    console.log('\n📋 Windows Mounting Instructions:');
    console.log('1. Open File Explorer');
    console.log('2. Right-click "This PC" and select "Map network drive"');
    console.log('3. Enter the WebDAV URL: http://your-server:8001/webdav/workspace-name/home/');
    console.log('4. Check "Connect using different credentials"');
    console.log('5. Enter credentials:');
    console.log(`   - Username: ${userEmail} (or any username)`);
    console.log(`   - Password: ${token.value}`);
    console.log('6. Click "Finish"');
    console.log('\n⚠️  IMPORTANT: Save this token now - it will not be shown again!');
    console.log('   You can list your tokens with: canvas auth tokens list');

    return token;
  } catch (error) {
    console.error('❌ Failed to create WebDAV token:', error.message);
    throw error;
  }
}

/**
 * List existing tokens for a user
 */
async function listUserTokens(userEmail) {
  try {
    // Initialize auth service
    await authService.initialize();

    // Find user by email
    const userIndex = jim.createIndex('users');
    const users = userIndex.store ? Object.values(userIndex.store) : [];
    const user = users.find(u => u.email === userEmail);

    if (!user) {
      throw new Error(`User with email ${userEmail} not found`);
    }

    console.log(`Listing tokens for user: ${user.email} (${user.id})`);

    // Get user tokens
    const tokens = await authService.listTokens(user.id);

    if (tokens.length === 0) {
      console.log('No tokens found for this user.');
      return [];
    }

    console.log('\n📋 Existing API Tokens:');
    console.log('='.repeat(80));
    tokens.forEach((token, index) => {
      console.log(`${index + 1}. ${token.name}`);
      console.log(`   ID: ${token.id}`);
      console.log(`   Type: ${token.type}`);
      console.log(`   Created: ${token.createdAt}`);
      console.log(`   Last Used: ${token.lastUsedAt || 'Never'}`);
      console.log(`   Expires: ${token.expiresAt || 'Never'}`);
      console.log(`   Description: ${token.description || 'No description'}`);
      console.log('');
    });

    return tokens;
  } catch (error) {
    console.error('❌ Failed to list tokens:', error.message);
    throw error;
  }
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const userEmail = args[1];
  const tokenName = args[2];

  if (!command || !userEmail) {
    console.log('Usage:');
    console.log('  node create-webdav-token.js create <user-email> [token-name]');
    console.log('  node create-webdav-token.js list <user-email>');
    console.log('');
    console.log('Examples:');
    console.log('  node create-webdav-token.js create admin@canvas.local "My WebDAV Token"');
    console.log('  node create-webdav-token.js list admin@canvas.local');
    process.exit(1);
  }

  try {
    if (command === 'create') {
      await createWebDAVToken(userEmail, tokenName);
    } else if (command === 'list') {
      await listUserTokens(userEmail);
    } else {
      console.error('Unknown command:', command);
      console.log('Available commands: create, list');
      process.exit(1);
    }
  } catch (error) {
    console.error('Script failed:', error.message);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { createWebDAVToken, listUserTokens };
