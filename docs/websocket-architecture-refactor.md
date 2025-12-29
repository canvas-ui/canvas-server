# WebSocket Architecture Refactor Proposal

## Current Problems

### 1. Complex Event Re-emission Chain
The current WebSocket implementation has multiple layers of event handling:

1. **SynapsD** emits `document:inserted`
2. **Workspace** forwards as `workspace:document:inserted` 
3. **Context** forwards as both `document:insert` AND `context:workspace:document:inserted`
4. **ContextManager** forwards context events 
5. **WebSocket API** has manual event handlers for each type
6. **Frontend** expects different event names in constants

### 2. Event Name Inconsistencies
- Backend: `document:inserted` (past tense)
- Context: `document:insert` (present tense) 
- Frontend constants: `DOCUMENT_CONTEXT.INSERT` = `"context:document:insert"`
- Actual emitted: `context:workspace:document:inserted`

### 3. Missing Event Listeners
The browser extension has NO listeners for:
- `document:insert`
- `context:workspace:document:inserted` 
- `workspace:document:inserted`

This is why CLI tab insertion doesn't update the extension!

## Proposed Simplified Architecture

### Core Principle: Direct Event Forwarding with EventEmitter2 Wildcards

Instead of manual re-emission, use EventEmitter2's wildcard capabilities to forward ALL events from managers directly to WebSocket clients.

```javascript
// WebSocket setup (simplified)
manager.on('**', (eventData) => {
  const eventName = this.event; // EventEmitter2 provides this
  socket.emit(eventName, eventData); // Forward with original name
});
```

### Event Flow (Simplified)

```
CLI Insert → Context.insertDocument() → SynapsD.insert() 
     ↓
SynapsD emits: document:inserted
     ↓  
Workspace forwards: workspace:document:inserted  
     ↓
Context forwards: context:workspace:document:inserted
     ↓
WebSocket wildcard listener forwards ALL events
     ↓
Browser Extension receives: context:workspace:document:inserted
```

### Benefits

1. **Single Source of Truth**: Event names are defined once in managers
2. **No Manual Re-emission**: Wildcard listeners handle everything
3. **Consistent Naming**: Frontend uses same names as backend
4. **Easier Debugging**: Events flow through predictable path
5. **Less Code**: Remove complex event handling in WebSocket layer

## Implementation Plan

### Phase 1: Add Missing Event Listeners (Immediate Fix)

Add listeners in browser extension for currently emitted events:

```typescript
// In socket.ts
socket.on('document:insert', handleDocumentInsert);
socket.on('context:workspace:document:inserted', handleDocumentInsert);
socket.on('workspace:document:inserted', handleDocumentInsert);
socket.on('context:updated', (payload) => {
  if (payload.operation === 'document:inserted') {
    handleDocumentInsert(payload);
  }
});
```

### Phase 2: Implement Simplified WebSocket Handler

Replace current WebSocket implementation with EventEmitter2 wildcard-based forwarding:

```javascript
// src/transports/websocket/index-simplified.js
const setupManagerEventForwarding = () => {
  const managers = [
    { manager: fastify.contextManager, prefix: 'context' },
    { manager: fastify.workspaceManager, prefix: 'workspace' }
  ];

  managers.forEach(({ manager, prefix }) => {
    manager.on('**', async (eventData) => {
      const eventName = this.event;
      
      // Check user access
      if (await hasUserAccess(user, eventData)) {
        socket.emit(eventName, eventData);
      }
    });
  });
};
```

### Phase 3: Update Frontend Constants

Use consistent event names across frontend:

```typescript
// constants-simplified.ts
export const MANAGER_EVENTS = {
  DOCUMENT: {
    INSERT: "document:insert",      // Direct from Context
    INSERTED: "document:inserted"   // Direct from SynapsD
  },
  WORKSPACE: {
    DOCUMENT_INSERTED: "workspace:document:inserted"
  },
  CONTEXT_WORKSPACE: {
    DOCUMENT_INSERTED: "context:workspace:document:inserted"
  }
}
```

### Phase 4: Remove Complex WebSocket Handlers

Remove manual event handlers in:
- `src/transports/websocket/channels/context.js` (most of it)
- `src/transports/websocket/index.js` (manual event forwarding)

## Event Naming Convention

### Standardized Format: `{scope}:{object}:{action}`

- `document:insert` - Context inserting document
- `document:inserted` - SynapsD confirming insertion  
- `workspace:document:inserted` - Workspace forwarding SynapsD event
- `context:workspace:document:inserted` - Context forwarding workspace event

### Tense Convention
- **Present tense** (`insert`, `update`, `delete`) - Action being performed
- **Past tense** (`inserted`, `updated`, `deleted`) - Action completed

## Migration Strategy

### Immediate (Fix Current Issue)
1. Add missing event listeners to browser extension ✅
2. Test with current CLI insertion 
3. Verify events reach extension

### Short Term (Simplify)
1. Create simplified WebSocket handler
2. Test alongside current implementation
3. Switch when stable

### Long Term (Cleanup)  
1. Remove old WebSocket handlers
2. Update all frontend code to use new constants
3. Standardize event names across all managers

## Testing Strategy

1. **Event Emission Test**: Verify all expected events are emitted
2. **Event Reception Test**: Verify browser extension receives events
3. **Auto-open Test**: Verify `autoOpenCanvasTabs` works with new events
4. **Context Switching Test**: Verify events filtered by context access
5. **Performance Test**: Compare event forwarding performance

## Files to Modify

### Backend
- `src/transports/websocket/index-simplified.js` (new)
- `src/transports/websocket/channels/context.js` (simplify)
- `src/managers/context/lib/Context.js` (event consistency)

### Frontend  
- `extensions/browser-extensions/src/general/constants-simplified.ts` (new)
- `extensions/browser-extensions/src/background/socket.ts` (add listeners)
- `extensions/browser-extensions/src/popup/listener.ts` (use new constants)

### Tests
- `tests/test-current-websocket-events.js` (verify current state) ✅
- `tests/test-simplified-websocket.js` (verify new implementation)

## Risk Assessment

### Low Risk
- Adding missing event listeners (immediate fix)
- Creating new simplified handler alongside current

### Medium Risk  
- Switching to simplified handler
- Updating constants across frontend

### High Risk
- Removing old WebSocket handlers (do last)

## Success Metrics

1. ✅ Browser extension receives document insertion events
2. ✅ CLI tab insertion triggers auto-open if enabled
3. ✅ Context switching properly filters events
4. ✅ Reduced WebSocket handler complexity (lines of code)
5. ✅ Consistent event naming across codebase

## Current Status

- ✅ Identified root cause (missing event listeners)
- ✅ Added missing listeners to browser extension  
- ✅ Created simplified WebSocket architecture
- ✅ Created test script for current implementation
- ⏳ Need to test immediate fix
- ⏳ Need to implement simplified architecture

## Next Steps

1. **Test current fix**: Run CLI insertion, verify browser extension receives events
2. **Implement simplified handler**: Create and test new WebSocket implementation  
3. **Gradual migration**: Switch components one by one
4. **Full testing**: Comprehensive test suite for new architecture 
