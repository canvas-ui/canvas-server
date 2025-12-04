# Routes v2.0

## UI Routes (Application Frontend)

! Routes map to full UI pages with navigation chrome, session context, etc.

### Contexts

- /ctx/{contextId}
- /ctx/{contextId}/docs
- /ctx/{contextId}/files

### Workspaces

- /ws/{workspaceId}
- /ws/{workspaceId}/docs 
- /ws/{workspaceId}/files

### Agents

### Roles

### Settings




## Public / Distraction-Free Views

! Routes expose minimal UI, for either sharing or distraction-free single-resource usage.
Everything is scoped behind an opaque, revocable token.

! No menu chrome unless explicitly allowed.
! Token can encode permission scope (read/write/comment).
! Token may be short-lived or explicitly revocable.

### General Pattern

- /pub/{token}/workspace/{workspaceId}
- /pub/{token}/context/{contextId}
- /pub/{token}/agent/{agentId}
- /pub/{token}/doc/{documentId}
- /pub/{token}/file/{fileId}

### Examples

- /pub/af392d/workspace/foo
- /pub/93d029/agent/lucy
- /pub/ee9210/doc/12345

## REST API (Machine-Facing)

All REST endpoints live under a strict versioned root:  
Currently `/rest/v2/`

Consistency rules:
- Nouns only — no verbs in URLs.
- Always plural for collections.
- Standard HTTP semantics for CRUD.
- JSON for documents/metadata.
- Octet-stream for BLOBs.
- Ranged downloads with 206 Partial Content.


### Workspaces

GET    /rest/v2/workspaces
POST   /rest/v2/workspaces
GET    /rest/v2/workspaces/{wsId}
PATCH  /rest/v2/workspaces/{wsId}
DELETE /rest/v2/workspaces/{wsId}

GET    /rest/v2/workspaces/{wsId}/documents
POST   /rest/v2/workspaces/{wsId}/documents

GET    /rest/v2/workspaces/{wsId}/files
POST   /rest/v2/workspaces/{wsId}/files






## Sharing API
