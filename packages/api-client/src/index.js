export { CanvasClient } from './CanvasClient.js';
export { HttpClient } from './HttpClient.js';
export { SocketClient } from './SocketClient.js';
export { CanvasApiError } from './errors.js';

// Resource classes — useful for type-checking or extension
export { AuthResource } from './resources/AuthResource.js';
export { WorkspacesResource } from './resources/WorkspacesResource.js';
export { ContextsResource } from './resources/ContextsResource.js';
export { AgentsResource } from './resources/AgentsResource.js';
export { AdminResource } from './resources/AdminResource.js';

// Default export for simple import patterns
export { CanvasClient as default } from './CanvasClient.js';
