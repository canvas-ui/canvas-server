#!/usr/bin/env node
'use strict';

/**
 * Test script for the Weather MCP Server
 *
 * This script tests the basic functionality of the weather MCP server
 * to ensure it's working correctly before integrating with agents.
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const weatherServerPath = path.join(__dirname, '..', 'src', 'managers', 'agent', 'mcp-servers', 'weather.js');

// Test cases to run
const testCases = [
    {
        name: 'List available locations',
        method: 'list_available_locations',
        params: {}
    },
    {
        name: 'Get current weather for London',
        method: 'get_current_weather',
        params: { location: 'London' }
    },
    {
        name: 'Get weather forecast for Tokyo',
        method: 'get_weather_forecast',
        params: { location: 'Tokyo', days: 3 }
    },
    {
        name: 'Get weather alerts for New York',
        method: 'get_weather_alerts',
        params: { location: 'New York' }
    },
    {
        name: 'Get air quality for Sydney',
        method: 'get_air_quality',
        params: { location: 'Sydney' }
    }
];

async function runTest(testCase) {
    return new Promise((resolve, reject) => {
        console.log(`\n🧪 Testing: ${testCase.name}`);

        const weatherServer = spawn('node', [weatherServerPath], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let output = '';
        let errorOutput = '';

        weatherServer.stdout.on('data', (data) => {
            output += data.toString();
        });

        weatherServer.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        weatherServer.on('error', (error) => {
            reject(new Error(`Failed to start weather server: ${error.message}`));
        });

        // Wait a moment for the server to start
        setTimeout(() => {
            // Send MCP initialization
            const initRequest = {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: {
                        name: 'test-client',
                        version: '1.0.0'
                    }
                }
            };

            weatherServer.stdin.write(JSON.stringify(initRequest) + '\n');

            // Send tool call after initialization
            setTimeout(() => {
                const toolRequest = {
                    jsonrpc: '2.0',
                    id: 2,
                    method: 'tools/call',
                    params: {
                        name: testCase.method,
                        arguments: testCase.params
                    }
                };

                weatherServer.stdin.write(JSON.stringify(toolRequest) + '\n');

                // Give time for response
                setTimeout(() => {
                    weatherServer.kill('SIGTERM');

                    try {
                        // Parse the output to find our response
                        const lines = output.split('\n').filter(line => line.trim());
                        let foundResponse = false;

                        for (const line of lines) {
                            try {
                                const response = JSON.parse(line);
                                if (response.id === 2 && response.result) {
                                    console.log(`✅ Success: ${testCase.name}`);
                                    console.log(`📝 Response: ${response.result.content[0]?.text?.substring(0, 100)}...`);
                                    foundResponse = true;
                                    break;
                                }
                            } catch  {
                                // Not JSON, skip
                            }
                        }

                        if (!foundResponse) {
                            console.log(`❌ Failed: ${testCase.name} - No valid response found`);
                            console.log('Raw output:', output);
                            console.log('Error output:', errorOutput);
                        }

                        resolve(foundResponse);
                    } catch (error) {
                        console.log(`❌ Error parsing response for ${testCase.name}:`, error.message);
                        console.log('Raw output:', output);
                        resolve(false);
                    }
                }, 2000);
            }, 1000);
        }, 500);
    });
}

async function runAllTests() {
    console.log('🚀 Starting Weather MCP Server Tests\n');

    let passed = 0;
    let failed = 0;

    for (const testCase of testCases) {
        try {
            const success = await runTest(testCase);
            if (success) {
                passed++;
            } else {
                failed++;
            }
        } catch (error) {
            console.log(`❌ Error running test "${testCase.name}": ${error.message}`);
            failed++;
        }
    }

    console.log('\n📊 Test Results:');
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`📈 Total: ${passed + failed}`);

    if (failed === 0) {
        console.log('\n🎉 All tests passed! Weather MCP server is working correctly.');
        process.exit(0);
    } else {
        console.log('\n⚠️  Some tests failed. Please check the weather MCP server implementation.');
        process.exit(1);
    }
}

// Run the tests
if (import.meta.url === `file://${process.argv[1]}`) {
    runAllTests().catch(error => {
        console.error('💥 Test runner error:', error);
        process.exit(1);
    });
}
