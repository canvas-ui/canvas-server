'use strict';

import path from 'path';
import * as fsPromises from 'fs/promises';

/*
 * Agent runtime environment — the canvas-edge injection contract.
 *
 * A bound agent talks to canvas exclusively through its own token, and the
 * whole contract is expressed as a flat env map:
 *
 *   CANVAS_URL        - REST base url (loopback in-process, public under canvas-edge)
 *   CANVAS_TOKEN      - the agent's canvas-agent-* token (plaintext)
 *   CANVAS_AGENT_ID   - agent uuid
 *   CANVAS_WORKSPACE  - bound workspace id
 *   CANVAS_BASE_PATH  - path prefix the agent is clamped to ('/' = whole workspace)
 *   CANVAS_BINDING_TYPE   - context | workspace | global (informational)
 *   CANVAS_WORKSPACE_NAME - human name of the bound workspace (informational)
 *   CANVAS_CONTEXT_ID     - bound context id (context bindings only)
 *   CANVAS_CONTEXT_URL    - bound context url at env-build time (context bindings only)
 *
 * In-process MVP the map feeds the canvas tool factory; under canvas-edge the
 * same map becomes literal container env. The token plaintext is persisted
 * only inside the agent's own runtime dir (0600) so restarts survive without
 * re-minting — the server keeps only the hash.
 */

const CANVAS_ENV_FILENAME = 'canvas.env';

function canvasEnvPath(rootPath) {
    return path.join(rootPath, 'runtime', CANVAS_ENV_FILENAME);
}

function serializeEnv(env) {
    return Object.entries(env)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n';
}

function parseEnv(content) {
    const env = {};
    for (const line of String(content).split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const separatorIndex = trimmed.indexOf('=');
        if (separatorIndex === -1) continue;
        env[trimmed.slice(0, separatorIndex).trim()] = trimmed.slice(separatorIndex + 1).trim();
    }
    return env;
}

/**
 * Build the runtime env map for a bound agent.
 * @param {Object} params
 * @param {string} params.agentId
 * @param {string} params.tokenValue  - plaintext canvas-agent-* token
 * @param {string} params.workspaceId
 * @param {string} params.basePath
 * @param {string} params.apiBaseUrl  - e.g. http://127.0.0.1:8001/rest/v2
 * @param {string} [params.bindingType]   - context | workspace | global
 * @param {string} [params.workspaceName]
 * @param {string} [params.contextId]
 * @param {string} [params.contextUrl]
 */
export function buildAgentRuntimeEnv({ agentId, tokenValue, workspaceId, basePath, apiBaseUrl, bindingType, workspaceName, contextId, contextUrl }) {
    if (!agentId || !tokenValue || !workspaceId || !apiBaseUrl) return null;
    return {
        CANVAS_URL: apiBaseUrl,
        CANVAS_TOKEN: tokenValue,
        CANVAS_AGENT_ID: agentId,
        CANVAS_WORKSPACE: workspaceId,
        CANVAS_BASE_PATH: basePath || '/',
        ...(bindingType ? { CANVAS_BINDING_TYPE: bindingType } : {}),
        ...(workspaceName ? { CANVAS_WORKSPACE_NAME: workspaceName } : {}),
        ...(contextId ? { CANVAS_CONTEXT_ID: contextId } : {}),
        ...(contextUrl ? { CANVAS_CONTEXT_URL: contextUrl } : {}),
    };
}

/**
 * Persist the env map to {rootPath}/runtime/canvas.env (0600).
 */
export async function persistAgentRuntimeEnv(rootPath, env) {
    const filePath = canvasEnvPath(rootPath);
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, serializeEnv(env), { mode: 0o600 });
    return filePath;
}

/**
 * Load a previously persisted env map. Returns null when absent/unreadable.
 */
export async function loadAgentRuntimeEnv(rootPath) {
    try {
        const content = await fsPromises.readFile(canvasEnvPath(rootPath), 'utf8');
        const env = parseEnv(content);
        return env.CANVAS_TOKEN ? env : null;
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

export async function removeAgentRuntimeEnv(rootPath) {
    await fsPromises.rm(canvasEnvPath(rootPath), { force: true });
}
