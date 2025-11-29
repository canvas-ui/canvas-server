# Canvas Agent Runtime

A simple LLM agent runtime for canvas-server that supports multiple LLM providers and integrates with the Model Context Protocol (MCP) for enhanced capabilities.

## Features

- **Multiple LLM Connectors**: Support for Anthropic Claude, OpenAI GPT, and Ollama
- **MCP Integration**: Built-in MCP server for exposing agent memory and tools
- **Persistent Memory**: Uses SynapsD database for agent memory storage
- **Exportable Agents**: Self-contained agent directories that can be moved between instances
- **Reference MCP Server**: Includes a weather MCP server as a demonstration
- **REST API**: Complete REST API for agent management and interaction

## Directory Structure

Each agent creates the following directory structure:

```
agents/
└── {user.id}/
    └── agents/
        └── {agent.name}/
            ├── agent.json          # Agent configuration
            ├── config/            # Configuration files
            ├── db/               # SynapsD database
            ├── data/             # Agent data
            └── tmp/              # Temporary files
```

## LLM Connectors

### Anthropic Claude
```javascript
const anthropicConfig = {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-3-5-sonnet-20241022',
    maxTokens: 4096
};
```

### OpenAI GPT
```javascript
const openaiConfig = {
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4o',
    maxTokens: 4096
};
```

### Ollama
```javascript
const ollamaConfig = {
    host: 'http://localhost:11434',
    model: 'qwen2.5-coder:latest'
};
```

## REST API Endpoints

### Agent Management

- `GET /rest/v2/agents` - List all agents for the authenticated user
- `POST /rest/v2/agents` - Create a new agent
- `GET /rest/v2/agents/:agentId` - Get agent details
- `POST /rest/v2/agents/:agentId/start` - Start an agent
- `POST /rest/v2/agents/:agentId/stop` - Stop an agent
- `GET /rest/v2/agents/:agentId/status` - Get agent status

### Chat Interface

- `POST /rest/v2/agents/:agentId/chat` - Chat with an agent

Example chat request:
```json
{
  "message": "What's the weather like in London?",
  "mcpContext": true,
  "maxTokens": 1000,
  "temperature": 0.7
}
```

### Memory Management

- `GET /rest/v2/agents/:agentId/memory` - Get agent memory
- `GET /rest/v2/agents/:agentId/memory?query=search_term` - Search agent memory
- `DELETE /rest/v2/agents/:agentId/memory` - Clear agent memory

### MCP Tools

- `GET /rest/v2/agents/:agentId/mcp/tools` - List available MCP tools
- `POST /rest/v2/agents/:agentId/mcp/tools/:toolName` - Call an MCP tool

## Creating an Agent

### Basic Agent
```bash
curl -X POST http://localhost:3001/rest/v2/agents \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-assistant",
    "label": "My AI Assistant",
    "description": "A helpful AI assistant",
    "llmProvider": "anthropic",
    "model": "claude-3-5-sonnet-20241022"
  }'
```

### Agent with Custom Configuration
```bash
curl -X POST http://localhost:3001/rest/v2/agents \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "advanced-agent",
    "label": "Advanced Agent",
    "description": "An agent with custom configuration",
    "llmProvider": "anthropic",
    "model": "claude-3-5-sonnet-20241022",
    "connectors": {
      "anthropic": {
        "apiKey": "your-api-key",
        "maxTokens": 8192
      }
    },
    "mcp": {
      "servers": [
        {
          "name": "custom-server",
          "command": "node",
          "args": ["/path/to/custom-mcp-server.js"]
        }
      ]
    }
  }'
```

## Starting and Using an Agent

### 1. Start the Agent
```bash
curl -X POST http://localhost:3001/rest/v2/agents/my-assistant/start \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### 2. Chat with the Agent
```bash
curl -X POST http://localhost:3001/rest/v2/agents/my-assistant/chat \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hello! Can you tell me about the weather in Tokyo?",
    "mcpContext": true
  }'
```

### 3. Check Available MCP Tools
```bash
curl -X GET http://localhost:3001/rest/v2/agents/my-assistant/mcp/tools \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### 4. Call a Specific MCP Tool
```bash
curl -X POST http://localhost:3001/rest/v2/agents/my-assistant/mcp/tools/get_current_weather \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "arguments": {
      "location": "London"
    },
    "source": "weather"
  }'
```

## Built-in MCP Tools

Each agent automatically gets these MCP tools:

### Memory Tools
- `store_memory` - Store information in agent memory
- `query_memory` - Search agent memory
- `clear_memory` - Clear all agent memory

### Agent Info Tools
- `get_agent_info` - Get information about the agent
- `list_mcp_tools` - List all available MCP tools

### Weather Tools (from reference server)
- `get_current_weather` - Get current weather for a location
- `get_weather_forecast` - Get weather forecast
- `get_weather_alerts` - Get weather alerts
- `get_air_quality` - Get air quality information
- `list_available_locations` - List available weather locations

## Environment Variables

Set these environment variables for LLM providers:

```bash
# Anthropic
export ANTHROPIC_API_KEY="your-anthropic-api-key"

# OpenAI
export OPENAI_API_KEY="your-openai-api-key"

# Ollama (default: http://localhost:11434)
# No API key needed for local Ollama
```

## MCP Server Development

### Creating a Custom MCP Server

1. Create a new MCP server following the pattern in `mcp-servers/weather.js`
2. Use the `@modelcontextprotocol/sdk` for server implementation
3. Add it to your agent's configuration:

```json
{
  "mcp": {
    "servers": [
      {
        "name": "my-custom-server",
        "command": "node",
        "args": ["/path/to/my-server.js"]
      }
    ]
  }
}
```

### Weather MCP Server Reference

The included weather MCP server provides:
- Current weather conditions
- Weather forecasts
- Weather alerts
- Air quality information

Location data is available for: London, New York, Tokyo, Sydney

## Agent Memory

Agents automatically store:
- Conversation history
- User interactions
- Tool usage
- Custom data via MCP tools

Memory is queryable via:
- Full-text search
- Context-based filtering
- Time-based queries

## Error Handling

The system includes comprehensive error handling:
- LLM connector failures
- MCP server connection issues
- Database errors
- Authentication errors

## Security

- All API endpoints require authentication
- Agents are isolated per user
- Memory access is restricted to agent owners
- MCP tool execution is sandboxed

## Performance

- Agents use connection pooling for LLM providers
- Memory operations are optimized with SynapsD indexes
- MCP connections are cached and reused
- Graceful handling of timeouts and rate limits

## Development

### Running Tests
```bash
# Test the weather MCP server
node src/managers/agent/mcp-servers/weather.js
```

### Debugging
Set debug environment variable:
```bash
DEBUG=canvas:agent* npm start
```

This enables detailed logging for agent operations.

## Integration Examples

### Canvas CLI Integration
```bash
# Using canvas-cli to interact with agents
canvas agent create my-agent --provider anthropic
canvas agent start my-agent
canvas agent chat my-agent "What's the weather like?"
```

### Browser Extension Integration
The REST API can be used directly from browser extensions for seamless agent interaction.

### Desktop Application Integration
Use the WebSocket API for real-time agent communication in desktop applications.

---

For more examples and advanced usage, see the `tests/` directory and the Canvas documentation. 
