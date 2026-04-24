'use strict';

import { LOCAL_PROVIDER_DEFAULTS, PROVIDER_ENV_KEYS } from './Agent.js';

const DEFAULT_PROVIDER_BASE_URLS = {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com/v1',
    google: 'https://generativelanguage.googleapis.com',
    ...Object.fromEntries(Object.entries(LOCAL_PROVIDER_DEFAULTS).map(([provider, config]) => [provider, config.baseUrl])),
};

function trimTrailingSlash(value = '') {
    return String(value || '').replace(/\/+$/, '');
}

function getProviderBaseUrl(provider, config = {}) {
    return trimTrailingSlash(config.baseUrl || DEFAULT_PROVIDER_BASE_URLS[provider] || '');
}

function getProviderApiKey(provider, config = {}) {
    return config.apiKey || process.env[PROVIDER_ENV_KEYS[provider]];
}

function buildOpenAiLikeModelsUrl(provider, baseUrl) {
    if (!baseUrl) return '';
    if (provider === 'openai' && !/\/v\d+(\/|$)/.test(baseUrl)) {
        return `${baseUrl}/v1/models`;
    }
    return `${baseUrl}/models`;
}

function buildAnthropicCountTokensUrl(baseUrl) {
    if (!baseUrl) return '';
    return /\/v\d+(\/|$)/.test(baseUrl)
        ? `${baseUrl}/messages/count_tokens`
        : `${baseUrl}/v1/messages/count_tokens`;
}

async function readErrorResponse(response) {
    const text = await response.text();
    if (!text) return `HTTP ${response.status}`;

    try {
        const payload = JSON.parse(text);
        const message = payload?.error?.message || payload?.message || payload?.detail;
        return message ? `HTTP ${response.status}: ${message}` : `${response.status} ${text}`;
    } catch {
        return `${response.status} ${text}`;
    }
}

async function probeOpenAiLikeProvider(provider, model, config = {}) {
    const baseUrl = getProviderBaseUrl(provider, config);
    if (!baseUrl) throw new Error(`Missing base URL for provider "${provider}"`);

    const apiKey = getProviderApiKey(provider, config) || LOCAL_PROVIDER_DEFAULTS[provider]?.apiKey;
    const headers = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    let response;
    try {
        response = await fetch(buildOpenAiLikeModelsUrl(provider, baseUrl), {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(10000),
        });
    } catch (error) {
        throw new Error(`Cannot reach ${provider} at ${baseUrl}: ${error.message}`, { cause: error });
    }

    if (!response.ok) {
        throw new Error(`${provider} validation failed at ${baseUrl}: ${await readErrorResponse(response)}`);
    }

    // Best-effort model validation. If the endpoint reports models, use it.
    try {
        const payload = await response.json();
        const models = Array.isArray(payload?.data) ? payload.data.map((entry) => entry?.id).filter(Boolean) : [];
        if (model && models.length > 0 && !models.includes(model)) {
            throw new Error(`Model "${model}" is not available at ${baseUrl}`);
        }
    } catch (error) {
        if (String(error.message || '').includes('not available')) throw error;
    }
}

async function probeAnthropicProvider(model, config = {}) {
    const baseUrl = getProviderBaseUrl('anthropic', config);
    const apiKey = getProviderApiKey('anthropic', config);

    if (!apiKey) throw new Error('Missing Anthropic API key');
    if (!baseUrl) throw new Error('Missing base URL for provider "anthropic"');

    let response;
    try {
        response = await fetch(buildAnthropicCountTokensUrl(baseUrl), {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: 'ping' }],
            }),
            signal: AbortSignal.timeout(10000),
        });
    } catch (error) {
        throw new Error(`Cannot reach anthropic at ${baseUrl}: ${error.message}`, { cause: error });
    }

    if (!response.ok) {
        throw new Error(`anthropic validation failed at ${baseUrl}: ${await readErrorResponse(response)}`);
    }
}

export async function validateAgentProvider(config = {}) {
    const provider = config.llmProvider;
    const model = config.model;
    const agentConfig = config.config || {};

    if (!provider || !model) return;

    if (provider === 'anthropic') {
        await probeAnthropicProvider(model, agentConfig);
        return;
    }

    if (provider === 'openai' || LOCAL_PROVIDER_DEFAULTS[provider]) {
        await probeOpenAiLikeProvider(provider, model, agentConfig);
    }
}
