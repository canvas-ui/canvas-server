#!/usr/bin/env node
'use strict';

// MCP SDK
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * Weather MCP Server
 *
 * A reference implementation that provides weather information tools.
 * This demonstrates how to create MCP servers that can be used by agents.
 */

// Mock weather data for demonstration
const MOCK_WEATHER_DATA = {
    'london': {
        location: 'London, UK',
        temperature: 12,
        humidity: 78,
        conditions: 'Partly cloudy',
        windSpeed: 15,
        windDirection: 'SW',
        pressure: 1013,
        visibility: 10,
        uvIndex: 3,
        forecast: [
            { day: 'Today', high: 15, low: 8, conditions: 'Partly cloudy' },
            { day: 'Tomorrow', high: 17, low: 10, conditions: 'Sunny' },
            { day: 'Day 3', high: 13, low: 6, conditions: 'Rainy' }
        ]
    },
    'new york': {
        location: 'New York, NY, USA',
        temperature: 18,
        humidity: 65,
        conditions: 'Sunny',
        windSpeed: 8,
        windDirection: 'NW',
        pressure: 1020,
        visibility: 15,
        uvIndex: 6,
        forecast: [
            { day: 'Today', high: 22, low: 14, conditions: 'Sunny' },
            { day: 'Tomorrow', high: 19, low: 12, conditions: 'Partly cloudy' },
            { day: 'Day 3', high: 16, low: 9, conditions: 'Cloudy' }
        ]
    },
    'tokyo': {
        location: 'Tokyo, Japan',
        temperature: 22,
        humidity: 72,
        conditions: 'Clear',
        windSpeed: 12,
        windDirection: 'E',
        pressure: 1018,
        visibility: 12,
        uvIndex: 7,
        forecast: [
            { day: 'Today', high: 25, low: 18, conditions: 'Clear' },
            { day: 'Tomorrow', high: 23, low: 16, conditions: 'Partly cloudy' },
            { day: 'Day 3', high: 20, low: 14, conditions: 'Rainy' }
        ]
    },
    'sydney': {
        location: 'Sydney, Australia',
        temperature: 26,
        humidity: 60,
        conditions: 'Sunny',
        windSpeed: 20,
        windDirection: 'NE',
        pressure: 1015,
        visibility: 20,
        uvIndex: 9,
        forecast: [
            { day: 'Today', high: 28, low: 20, conditions: 'Sunny' },
            { day: 'Tomorrow', high: 30, low: 22, conditions: 'Sunny' },
            { day: 'Day 3', high: 27, low: 19, conditions: 'Partly cloudy' }
        ]
    }
};

// Create the MCP server
const server = new McpServer({
    name: 'weather-mcp-server',
    version: '1.0.0'
});

// Current weather tool
server.registerTool(
    'get_current_weather',
    {
        title: 'Get Current Weather',
        description: 'Get current weather conditions for a specified location',
        inputSchema: {
            location: z.string().describe('The location to get weather for (e.g., "London", "New York", "Tokyo")')
        }
    },
    async ({ location }) => {
        const normalizedLocation = location.toLowerCase().trim();
        const weatherData = MOCK_WEATHER_DATA[normalizedLocation];

        if (!weatherData) {
            return {
                content: [{
                    type: 'text',
                    text: `Weather data not available for "${location}". Available locations: ${Object.keys(MOCK_WEATHER_DATA).join(', ')}`
                }]
            };
        }

        const weatherReport = `
Current Weather for ${weatherData.location}:
Temperature: ${weatherData.temperature}°C
Conditions: ${weatherData.conditions}
Humidity: ${weatherData.humidity}%
Wind: ${weatherData.windSpeed} km/h ${weatherData.windDirection}
Pressure: ${weatherData.pressure} hPa
Visibility: ${weatherData.visibility} km
UV Index: ${weatherData.uvIndex}
        `.trim();

        return {
            content: [{
                type: 'text',
                text: weatherReport
            }]
        };
    }
);

// Weather forecast tool
server.registerTool(
    'get_weather_forecast',
    {
        title: 'Get Weather Forecast',
        description: 'Get weather forecast for a specified location',
        inputSchema: {
            location: z.string().describe('The location to get forecast for'),
            days: z.number().optional().default(3).describe('Number of days to forecast (1-7)')
        }
    },
    async ({ location, days = 3 }) => {
        const normalizedLocation = location.toLowerCase().trim();
        const weatherData = MOCK_WEATHER_DATA[normalizedLocation];

        if (!weatherData) {
            return {
                content: [{
                    type: 'text',
                    text: `Weather data not available for "${location}". Available locations: ${Object.keys(MOCK_WEATHER_DATA).join(', ')}`
                }]
            };
        }

        const forecast = weatherData.forecast.slice(0, Math.min(days, weatherData.forecast.length));

        let forecastReport = `Weather Forecast for ${weatherData.location}:\n\n`;

        for (const day of forecast) {
            forecastReport += `${day.day}: High ${day.high}°C, Low ${day.low}°C - ${day.conditions}\n`;
        }

        return {
            content: [{
                type: 'text',
                text: forecastReport.trim()
            }]
        };
    }
);

// Weather alerts tool (mock implementation)
server.registerTool(
    'get_weather_alerts',
    {
        title: 'Get Weather Alerts',
        description: 'Get weather alerts and warnings for a specified location',
        inputSchema: {
            location: z.string().describe('The location to get alerts for')
        }
    },
    async ({ location }) => {
        const normalizedLocation = location.toLowerCase().trim();

        // Mock alerts - in a real implementation, this would query a weather service
        const mockAlerts = {
            'london': [],
            'new york': ['Heat Advisory in effect until 8 PM'],
            'tokyo': ['Thunderstorm Watch until midnight'],
            'sydney': ['UV Warning - Very High']
        };

        const alerts = mockAlerts[normalizedLocation] || [];

        if (alerts.length === 0) {
            return {
                content: [{
                    type: 'text',
                    text: `No weather alerts for ${location}`
                }]
            };
        }

        const alertsReport = `Weather Alerts for ${location}:\n\n${alerts.map(alert => `⚠️ ${alert}`).join('\n')}`;

        return {
            content: [{
                type: 'text',
                text: alertsReport
            }]
        };
    }
);

// Air quality tool
server.registerTool(
    'get_air_quality',
    {
        title: 'Get Air Quality',
        description: 'Get air quality information for a specified location',
        inputSchema: {
            location: z.string().describe('The location to get air quality for')
        }
    },
    async ({ location }) => {
        const normalizedLocation = location.toLowerCase().trim();

        // Mock air quality data
        const mockAirQuality = {
            'london': { aqi: 45, level: 'Good', pm25: 12, pm10: 20, o3: 65, no2: 25 },
            'new york': { aqi: 62, level: 'Moderate', pm25: 18, pm10: 28, o3: 80, no2: 35 },
            'tokyo': { aqi: 38, level: 'Good', pm25: 10, pm10: 15, o3: 55, no2: 20 },
            'sydney': { aqi: 25, level: 'Good', pm25: 6, pm10: 12, o3: 45, no2: 15 }
        };

        const airQuality = mockAirQuality[normalizedLocation];

        if (!airQuality) {
            return {
                content: [{
                    type: 'text',
                    text: `Air quality data not available for "${location}". Available locations: ${Object.keys(mockAirQuality).join(', ')}`
                }]
            };
        }

        const aqiReport = `
Air Quality for ${location}:
AQI: ${airQuality.aqi} (${airQuality.level})
PM2.5: ${airQuality.pm25} μg/m³
PM10: ${airQuality.pm10} μg/m³
Ozone: ${airQuality.o3} μg/m³
NO2: ${airQuality.no2} μg/m³
        `.trim();

        return {
            content: [{
                type: 'text',
                text: aqiReport
            }]
        };
    }
);

// List available locations tool
server.registerTool(
    'list_available_locations',
    {
        title: 'List Available Locations',
        description: 'List all locations for which weather data is available',
        inputSchema: {}
    },
    async () => {
        const locations = Object.values(MOCK_WEATHER_DATA).map(data => data.location);

        return {
            content: [{
                type: 'text',
                text: `Available weather locations:\n${locations.map(loc => `• ${loc}`).join('\n')}`
            }]
        };
    }
);

// Weather resources
server.registerResource(
    'weather_info',
    'weather://info',
    {
        title: 'Weather Service Info',
        description: 'Information about the weather service capabilities',
        mimeType: 'text/plain'
    },
    async () => ({
        contents: [{
            uri: 'weather://info',
            text: `
Weather MCP Server

This server provides weather information tools including:
- Current weather conditions
- Weather forecasts
- Weather alerts and warnings
- Air quality information

Available locations: ${Object.keys(MOCK_WEATHER_DATA).join(', ')}

Note: This is a demonstration server using mock data.
In a production environment, this would connect to real weather APIs.
            `.trim()
        }]
    })
);

// Start the server
async function main() {
    try {
        const transport = new StdioServerTransport();
        await server.connect(transport);

        // Log to stderr so it doesn't interfere with the MCP protocol
        console.error('Weather MCP Server started successfully');
    } catch (error) {
        console.error('Failed to start Weather MCP Server:', error);
        process.exit(1);
    }
}

// Handle process termination
process.on('SIGINT', async () => {
    console.error('Weather MCP Server shutting down...');
    await server.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.error('Weather MCP Server shutting down...');
    await server.close();
    process.exit(0);
});

// Start the server if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(error => {
        console.error('Weather MCP Server error:', error);
        process.exit(1);
    });
}
