#!/usr/bin/env node

/**
 * Debug script to investigate document count discrepancy
 * Usage: node tests/debug-document-count.js [workspace-path]
 */

import path from 'path';
import SynapsD from 'canvas-synapsd';

async function debugDocumentCount(dbPath) {
    console.log(`🔍 Debugging document count for database: ${dbPath}`);

    const db = new SynapsD({
        path: dbPath,
        backend: 'lmdb'
    });

    try {
        await db.start();
        console.log('✅ Database started successfully');

        // Get the raw database count
        const rawCount = await db.documents.getCount();
        console.log(`📊 Raw database count: ${rawCount}`);

        // Count documents by iteration
        let iterableCount = 0;
        const documentIds = [];

        console.log('🔄 Iterating through all documents...');
        for await (const { key, value } of db.documents.getRange()) {
            iterableCount++;
            documentIds.push(key);

            // Log first few and last few IDs to see the pattern
            if (iterableCount <= 5 || iterableCount > iterableCount - 5) {
                console.log(`   Document ${iterableCount}: ID=${key}, Schema=${value?.schema || 'unknown'}`);
            } else if (iterableCount === 6) {
                console.log('   ... (skipping middle documents) ...');
            }
        }

        console.log(`📊 Iterable document count: ${iterableCount}`);
        console.log(`📊 Document ID range: ${Math.min(...documentIds)} - ${Math.max(...documentIds)}`);

        // Test the findDocuments method
        console.log('\n🔍 Testing findDocuments method...');
        const findResult = await db.findDocuments();
        console.log(`📊 findDocuments returned: ${findResult.length} documents`);
        console.log(`📊 findDocuments count property: ${findResult.count}`);
        console.log(`📊 findDocuments totalCount property: ${findResult.totalCount}`);

        // Check for gaps in document IDs
        const sortedIds = documentIds.sort((a, b) => a - b);
        const gaps = [];
        for (let i = 1; i < sortedIds.length; i++) {
            if (sortedIds[i] - sortedIds[i-1] > 1) {
                gaps.push(`${sortedIds[i-1] + 1}-${sortedIds[i] - 1}`);
            }
        }

        if (gaps.length > 0) {
            console.log(`🕳️  Found ID gaps: ${gaps.join(', ')}`);
        } else {
            console.log('✅ No gaps found in document IDs');
        }

        // Check if the discrepancy is due to pagination limit
        if (rawCount !== iterableCount) {
            console.log(`❌ DISCREPANCY FOUND: Raw count (${rawCount}) != Iterable count (${iterableCount})`);
            console.log(`   Difference: ${rawCount - iterableCount} documents`);
        } else {
            console.log('✅ Raw count matches iterable count');
        }

        // Test with no limit to see all documents
        console.log('\n🔍 Testing findDocuments with no limit...');
        const unlimitedResult = await db.findDocuments(null, [], [], { limit: 0 });
        console.log(`📊 findDocuments (no limit) returned: ${unlimitedResult.length} documents`);
        console.log(`📊 findDocuments (no limit) count: ${unlimitedResult.count}`);
        console.log(`📊 findDocuments (no limit) totalCount: ${unlimitedResult.totalCount}`);

        // Test pagination scenarios
        console.log('\n🔍 Testing pagination scenarios...');

                // Test with limit=10
        const page1Result = await db.findDocuments(null, [], [], { limit: 10, offset: 0 });
        console.log(`📊 Page 1 (limit=10, offset=0): returned ${page1Result.length} documents, count: ${page1Result.count}, totalCount: ${page1Result.totalCount}`);

        // Test with limit=10, offset=10 (page 2)
        const page2Result = await db.findDocuments(null, [], [], { limit: 10, offset: 10 });
        console.log(`📊 Page 2 (limit=10, offset=10): returned ${page2Result.length} documents, count: ${page2Result.count}, totalCount: ${page2Result.totalCount}`);

        // Test with limit=5
        const smallPageResult = await db.findDocuments(null, [], [], { limit: 5 });
        console.log(`📊 Small page (limit=5): returned ${smallPageResult.length} documents, count: ${smallPageResult.count}, totalCount: ${smallPageResult.totalCount}`);

        // Test with limit=200 (more than available)
        const largeLimitResult = await db.findDocuments(null, [], [], { limit: 200 });
        console.log(`📊 Large limit (limit=200): returned ${largeLimitResult.length} documents, count: ${largeLimitResult.count}, totalCount: ${largeLimitResult.totalCount}`);

        // Expected behavior analysis
        console.log('\n📈 Expected vs Actual Analysis:');
        console.log(`   Total documents in DB: ${iterableCount}`);
        console.log(`   When limit=10: Should return 10 docs, count should be 10, totalCount should be ${iterableCount}`);
        console.log(`   When limit=5: Should return 5 docs, count should be 5, totalCount should be ${iterableCount}`);
        console.log(`   When limit=200: Should return ${iterableCount} docs, count should be ${iterableCount}, totalCount should be ${iterableCount}`);

        // Validate expectations
        const expectations = [
            { test: 'limit=10', expected: { docs: 10, count: 10, totalCount: iterableCount }, actual: { docs: page1Result.length, count: page1Result.count, totalCount: page1Result.totalCount } },
            { test: 'limit=5', expected: { docs: 5, count: 5, totalCount: iterableCount }, actual: { docs: smallPageResult.length, count: smallPageResult.count, totalCount: smallPageResult.totalCount } },
            { test: 'limit=200', expected: { docs: iterableCount, count: iterableCount, totalCount: iterableCount }, actual: { docs: largeLimitResult.length, count: largeLimitResult.count, totalCount: largeLimitResult.totalCount } }
        ];

                let allPassed = true;
        expectations.forEach(({ test, expected, actual }) => {
            const docsMatch = actual.docs === expected.docs;
            const countMatch = actual.count === expected.count;
            const totalCountMatch = actual.totalCount === expected.totalCount;
            const status = docsMatch && countMatch && totalCountMatch ? '✅' : '❌';

            if (!docsMatch || !countMatch || !totalCountMatch) allPassed = false;

            console.log(`   ${status} ${test}: docs ${actual.docs}/${expected.docs}, count ${actual.count}/${expected.count}, totalCount ${actual.totalCount}/${expected.totalCount}`);
        });

        console.log(`\n🎯 Overall pagination test: ${allPassed ? '✅ PASSED' : '❌ FAILED'}`);

        if (!allPassed) {
            console.log('\n🔍 Current behavior analysis:');
            console.log(`   - count: ${page1Result.count} (should be ${10})`);
            console.log(`   - totalCount: ${page1Result.totalCount} (should be ${iterableCount})`);
            console.log('   - New API design: count = returned docs, totalCount = total available');
        }

    } catch (error) {
        console.error('❌ Error during debugging:', error.message);
    } finally {
        await db.shutdown();
        console.log('✅ Database shutdown complete');
    }
}

// Get database path from command line or use default
const workspacePath = process.argv[2] || './server/users/me@idnc.sk/db';
const dbPath = path.resolve(workspacePath);

debugDocumentCount(dbPath).catch(console.error);
