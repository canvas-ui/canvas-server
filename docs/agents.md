# Canvas Agents

Canvas Server includes a built-in LLM agent runtime. Agents are user-scoped, persist their own memory via SynapsD, and connect to LLM providers through pluggable connectors. They also expose and consume tools via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

## Architecture

```
Agent
├── LLM Connector     (Anthropic / OpenAI / Ollama)
├── SynapsD Database  (LMDB-backed persistent memory)
├── MCP Server        (exposes memory & agent-info tools)
└── MCP Clients       (connects to external MCP servers)
```

Each agent is self-contained: its configuration, database, and data all live under a single directory. This makes agents portable — a directory can be moved between Canvas Server instances.

### Directory Layout

```
{CANVAS_USER_HOME}/{user.id}/agents/{agent.name}/
├── agent.json    # persisted configuration (managed by Conf)
├── config/       # additional config files
├── db/           # SynapsD LMDB database (agent memory)
├── data/         # agent data
└── tmp/          # temporary files
```

## Agent Lifecycle

| Status | Meaning |
|--------|---------|
| `available` | Directory and config exist; not loaded into memory |
| `inactive` | Loaded but not started (resources not initialized) |
| `active` | Started; DB, LLM connector, and MCP ready |
| `error` | Start failed or unrecoverable error |
| `removed` | Marked for removal |
| `destroyed` | Directory deleted |

### Lifecycle flow

```
create → available → start() → active → stop() → inactive
                                    ↓ (on error)
                                   error
```

**`start()`** initializes in order:
1. SynapsD database (`db/`)
2. LLM connector (validates connectivity)
3. MCP server (registers built-in tools)
4. MCP clients (connects to configured external servers + built-in weather server)

**`stop()`** closes all MCP clients, the MCP server, and the database.

## Agent Reference Format

Agents can be addressed by a reference string:

```
{user_identifier}@{host}:{agent_slug}
```

Example: `alice@canvas.local:my-assistant`

The default host is `canvas.local`. When working with the API, you can use the agent name or ID as the `:agentIdentifier` path parameter.

## LLM Connectors

Three providers are supported. Provider is set per-agent; API keys can be passed in configuration or via environment variables.

### Anthropic Claude (default)

```json
{
  "llmProvider": "anthropic",
  "model": "claude-3-5-sonnet-20241022",
  "config": {
    "connectors": {
      "anthropic": {
        "apiKey": "sk-ant-...",
        "maxTokens": 4096
      }
    }
  }
}
```

Environment variable fallback: `ANTHROPIC_API_KEY`

### OpenAI

```json
{
  "llmProvider": "openai",
  "model": "gpt-4o",
  "config": {
    "connectors": {
      "openai": {
        "apiKey": "sk-...",
        "maxTokens": 4096
      }
    }
  }
}
```

Environment variable fallback: `OPENAI_API_KEY`

### Ollama (local)

```json
{
  "llmProvider": "ollama",
  "model": "qwen2.5-coder:latest",
  "config": {
    "connectors": {
      "ollama": {
        "host": "http://localhost:11434"
      }
    }
  }
}
```

No API key required. `host` defaults to `http://localhost:11434`.

## MCP Integration

Each agent runs its own MCP server and can connect to any number of external MCP servers.

### Built-in MCP Tools

Every agent automatically registers the following tools on its MCP server:

**Memory tools**

| Tool | Description |
|------|-------------|
| `store_memory` | Store a JSON object in agent memory at an optional context path |
| `query_memory` | Full-text search over agent memory |
| `clear_memory` | Delete all agent memory |

**Agent info tools**

| Tool | Description |
|------|-------------|
| `get_agent_info` | Return the agent's current configuration and status as JSON |
| `list_mcp_tools` | List all tools available from connected MCP clients |

### Reference MCP Server — Weather

A built-in weather MCP server (`src/core/agent/mcp-servers/weather.js`) is connected to every agent at start-up and provides:

| Tool | Description |
|------|-------------|
| `get_current_weather` | Current conditions for a location |
| `get_weather_forecast` | Multi-day forecast |
| `get_weather_alerts` | Active weather alerts |
| `get_air_quality` | Air quality index |
| `list_available_locations` | Locations covered (London, New York, Tokyo, Sydney) |

### Adding External MCP Servers

Pass additional servers in the agent's `config.mcp.servers` array. Each entry requires a `name`, `command`, and optional `args` (the server is launched as a child process over stdio):

```json
{
  "config": {
    "mcp": {
      "servers": [
        {
          "name": "my-tool-server",
          "command": "node",
          "args": ["/path/to/my-mcp-server.js"]
        }
      ]
    }
  }
}
```

## Agent Memory

Memory is stored in SynapsD (LMDB + roaring bitmaps) under the agent's `db/` directory. Every chat exchange is automatically persisted. You can also store arbitrary JSON via `storeMemory()` or the `store_memory` MCP tool.

Memory retrieval:
- **Full-text search** — `ftsQuery` over stored documents
- **Context-based** — scoped to a virtual context path (default `/`)
- **Fallback** — `findDocuments` if FTS index is unavailable

## REST API

All endpoints are under `/rest/v2/agents` and require authentication (JWT or API token).

### Agent Management

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/agents` | List agents for the authenticated user |
| `POST` | `/agents` | Create a new agent |
| `GET` | `/agents/:id` | Get agent details |
| `PUT` | `/agents/:id` | Update agent configuration |
| `DELETE` | `/agents/:id` | Delete agent (stops it first if running) |
| `GET` | `/agents/:id/status` | Get current status |
| `POST` | `/agents/:id/start` | Start the agent |
| `POST` | `/agents/:id/stop` | Stop the agent |

### Chat

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/agents/:id/chat` | Send a message, receive full response |
| `POST` | `/agents/:id/chat/stream` | Send a message, receive SSE stream |

**Chat request body**

```json
{
  "message": "What's the weather in Tokyo?",
  "context": [],
  "mcpContext": true,
  "maxTokens": 4096,
  "temperature": 0.7
}
```

**Streaming** uses Server-Sent Events. Event types: `start`, `chunk` (`{content, delta}`), `complete`, `error`, `[DONE]`.

### Memory

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/agents/:id/memory` | List or search memory (`?query=…&context=/&limit=50`) |
| `DELETE` | `/agents/:id/memory` | Clear all memory |

### MCP Tools

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/agents/:id/mcp/tools` | List all available MCP tools |
| `POST` | `/agents/:id/mcp/tools/:toolName` | Call a specific MCP tool |

**Tool call request body**

```json
{
  "arguments": { "location": "London" },
  "source": "weather"
}
```

`source` is optional — if omitted, the server searches all connected MCP clients for the named tool.

## Quick Start

### 1. Create an agent

```bash
curl -X POST http://localhost:8001/rest/v2/agents \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-assistant",
    "label": "My Assistant",
    "llmProvider": "anthropic",
    "model": "claude-3-5-sonnet-20241022"
  }'
```

### 2. Start it

```bash
curl -X POST http://localhost:8001/rest/v2/agents/my-assistant/start \
  -H "Authorization: Bearer <token>"
```

### 3. Chat

```bash
curl -X POST http://localhost:8001/rest/v2/agents/my-assistant/chat \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello! What can you do?"}'
```

### 4. Inspect memory

```bash
curl "http://localhost:8001/rest/v2/agents/my-assistant/memory?query=hello" \
  -H "Authorization: Bearer <token>"
```

## Environment Variables

```bash
ANTHROPIC_API_KEY=sk-ant-...    # Anthropic connector fallback
OPENAI_API_KEY=sk-...           # OpenAI connector fallback
# Ollama needs no key; configure host in agent config
```

## Source Layout

```
src/core/agent/
├── index.js              # AgentManager (create/open/start/stop/list/delete)
├── Agent.js              # Agent class
├── README.md
└── lib/
    └── connectors/
        ├── BaseLLMConnector.js
        ├── AnthropicConnector.js
        ├── OpenAIConnector.js
        ├── OllamaConnector.js
        └── index.js

src/core/agent/mcp-servers/
└── weather.js            # Reference MCP server (stdio transport)

src/transports/routes/agents/
└── index.js              # Fastify route handlers
```
