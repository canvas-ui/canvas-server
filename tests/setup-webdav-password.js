#!/usr/bin/env node

/**
 * WebDAV Password Setup Script
 * Helps users set up passwords for WebDAV testing
 */

import { authService } from '../src/api/auth/service.js';
import { jim } from '../src/Server.js';
import UserManager from '../src/managers/user/index.js';
import { env } from '../src/env.js';
import path from 'path';

const DEBUG = process.env.DEBUG || 'webdav:*';
process.env.DEBUG = DEBUG;

/**
 * Set password for a user
 */
async function setUserPassword(userEmail, password) {
  try {
    // Initialize auth service
    await authService.initialize();

    // Create userManager instance
    const userManager = new UserManager({
      rootPath: env.user.home,
      indexStore: jim.createIndex('users'),
    });
    await userManager.initialize();

    // Find user by email using userManager
    const user = await userManager.getUserByEmail(userEmail);

    console.log(`Setting password for user: ${user.email} (${user.id})`);

    // Set password
    await authService.setPassword(user.id, password);

    console.log('\n✅ Password Set Successfully!');
    console.log('='.repeat(50));
    console.log(`User: ${user.email}`);
    console.log(`Password: ${password}`);
    console.log('='.repeat(50));
    console.log('\n📋 WebDAV Authentication Options:');
    console.log('1. Username/Password:');
    console.log(`   - Username: ${user.email}`);
    console.log(`   - Password: ${password}`);
    console.log('');
    console.log('2. API Token (create with canvas auth tokens create "WebDAV Token")');
    console.log('   - Username: any username');
    console.log('   - Password: canvas-your-token-here');

    return true;
  } catch (error) {
    console.error('❌ Failed to set password:', error.message);
    throw error;
  }
}

/**
 * List all users
 */
async function listUsers() {
  try {
    // Initialize auth service
    await authService.initialize();

    // Create userManager instance
    const userManager = new UserManager({
      rootPath: env.user.home,
      indexStore: jim.createIndex('users'),
    });
    await userManager.initialize();

    // Get all users from the index store
    const userIndex = jim.createIndex('users');
    const users = userIndex.store ? Object.values(userIndex.store) : [];

    if (users.length === 0) {
      console.log('No users found.');
      return [];
    }

    console.log('\n📋 Available Users:');
    console.log('='.repeat(80));
    users.forEach((user, index) => {
      console.log(`${index + 1}. ${user.email}`);
      console.log(`   ID: ${user.id}`);
      console.log(`   Name: ${user.name || 'Not set'}`);
      console.log(`   Type: ${user.userType || 'user'}`);
      console.log(`   Status: ${user.status || 'active'}`);
      console.log('');
    });

    return users;
  } catch (error) {
    console.error('❌ Failed to list users:', error.message);
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
  const password = args[2];

  if (!command) {
    console.log('Usage:');
    console.log('  node setup-webdav-password.js set <user-email> <password>');
    console.log('  node setup-webdav-password.js list');
    console.log('');
    console.log('Examples:');
    console.log('  node setup-webdav-password.js set admin@canvas.local password123');
    console.log('  node setup-webdav-password.js list');
    process.exit(1);
  }

  try {
    if (command === 'set') {
      if (!userEmail || !password) {
        console.error('Error: Both user email and password are required');
        console.log('Usage: node setup-webdav-password.js set <user-email> <password>');
        process.exit(1);
      }
      await setUserPassword(userEmail, password);
    } else if (command === 'list') {
      await listUsers();
    } else {
      console.error('Unknown command:', command);
      console.log('Available commands: set, list');
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

export { setUserPassword, listUsers };
