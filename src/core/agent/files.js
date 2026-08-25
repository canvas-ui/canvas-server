'use strict';

import path from 'path';
import * as fsPromises from 'fs/promises';
import { existsSync } from 'fs';

export const AGENT_RUNTIME_FILES = {
    context: 'AGENTS.md',
    system: 'SYSTEM.md',
    appendSystem: 'APPEND_SYSTEM.md',
    memory: 'MEMORY.md',
    skillsDir: 'skills',
    skillFile: 'SKILL.md',
};

// Server-managed skill materialized for bound agents (see setAccess). Kept out
// of user config on read-back — it follows the binding, not the skills list.
export const CANVAS_SKILL_NAME = 'canvas-tools';

const CANVAS_SKILL = {
    name: CANVAS_SKILL_NAME,
    description: 'How to query and manage user data in canvas via the canvas_* tools',
    content: [
        '# Canvas tools',
        '',
        'You are bound to a canvas workspace scope. Canvas indexes the user\'s data',
        '(emails, notes, browser tabs, files, ...) as documents in a context tree.',
        'All canvas_* tool paths are RELATIVE to your scope; you cannot access data',
        'outside it.',
        '',
        '## Tools',
        '- `canvas_find` — search/list documents. `schema` filters by type, `query` is full-text/semantic search, `path` narrows to a subtree.',
        '- `canvas_get` — fetch one document by id.',
        '- `canvas_insert` — insert a document `{ schema, data }` at an optional path.',
        '- `canvas_tree` — show the context tree of your scope.',
        '- `canvas_notify` — send a notification to your user over their configured channel (WhatsApp/Slack).',
        '',
        '## Common schemas',
        '- `data/schema/message/email` — ingested emails (data.subject, data.from, data.to, data.body)',
        '- `data/schema/note` — notes (data.title, data.content)',
        '- `data/schema/tab` — browser tabs (data.url, data.title)',
        '- `data/schema/file` — indexed files',
        '- `data/schema/task` — todo items',
        '- `data/schema/event` — calendar / alert / activity (data.title, data.start, data.end; leaf is the schema id)',
        '',
        '## Examples',
        '- "Any new emails?" → `canvas_find { "schema": "data/schema/message/email", "limit": 10 }` (results are newest-first)',
        '- "Emails about ticket X" → `canvas_find { "schema": "data/schema/message/email", "query": "ticket X" }`',
        '- "Leave me a note" → `canvas_insert { "document": { "schema": "data/schema/note", "data": { "title": "...", "content": "..." } } }`',
        '',
        'The same access is available from shell via canvas-cli: the environment',
        'variables CANVAS_URL and CANVAS_TOKEN in runtime/canvas.env authenticate it.',
    ].join('\n'),
};

function getRuntimePath(rootPath) {
    return path.join(rootPath, 'runtime');
}

function normalizeText(value) {
    if (typeof value !== 'string') return '';
    return value.trim();
}

function formatMarkdown(value) {
    const content = normalizeText(value);
    return content ? `${content}\n` : '';
}

function quoteFrontmatter(value) {
    return JSON.stringify(String(value ?? ''));
}

export function sanitizeSkillName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/--+/g, '-');
}

async function readOptionalFile(filePath) {
    try {
        return await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

async function syncOptionalFile(filePath, value) {
    const content = formatMarkdown(value);
    if (!content) {
        if (existsSync(filePath)) await fsPromises.rm(filePath, { force: true });
        return;
    }
    await fsPromises.writeFile(filePath, content);
}

export function parseSkillMarkdown(raw, fallbackName) {
    const trimmed = raw.trim();
    const match = trimmed.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) {
        return {
            name: fallbackName,
            description: '',
            content: trimmed,
            disableModelInvocation: false,
        };
    }

    const fields = {};
    for (const line of match[1].split('\n')) {
        const separatorIndex = line.indexOf(':');
        if (separatorIndex === -1) continue;
        const key = line.slice(0, separatorIndex).trim();
        const rawValue = line.slice(separatorIndex + 1).trim();
        const value = rawValue.replace(/^['"]|['"]$/g, '');
        fields[key] = value;
    }

    return {
        name: sanitizeSkillName(fields.name || fallbackName) || fallbackName,
        description: fields.description || '',
        content: match[2].trim(),
        disableModelInvocation: fields['disable-model-invocation'] === 'true',
    };
}

function buildSkillMarkdown(skill) {
    const name = sanitizeSkillName(skill?.name);
    if (!name) return null;

    const description = normalizeText(skill?.description) || `${name} skill`;
    const content = normalizeText(skill?.content) || `# ${name}`;
    const lines = [
        '---',
        `name: ${quoteFrontmatter(name)}`,
        `description: ${quoteFrontmatter(description)}`,
    ];

    if (skill?.disableModelInvocation) {
        lines.push('disable-model-invocation: true');
    }

    lines.push('---', '', content);
    return `${lines.join('\n')}\n`;
}

async function readSkills(rootPath) {
    const skillsPath = path.join(getRuntimePath(rootPath), AGENT_RUNTIME_FILES.skillsDir);
    if (!existsSync(skillsPath)) return null;

    const entries = await fsPromises.readdir(skillsPath, { withFileTypes: true });
    const skills = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillPath = path.join(skillsPath, entry.name, AGENT_RUNTIME_FILES.skillFile);
        const raw = await readOptionalFile(skillPath);
        if (!raw) continue;
        skills.push(parseSkillMarkdown(raw, entry.name));
    }

    return skills;
}

async function syncSkills(rootPath, skills) {
    const skillsPath = path.join(getRuntimePath(rootPath), AGENT_RUNTIME_FILES.skillsDir);
    if (!Array.isArray(skills) || skills.length === 0) {
        if (existsSync(skillsPath)) await fsPromises.rm(skillsPath, { recursive: true, force: true });
        return;
    }

    await fsPromises.mkdir(skillsPath, { recursive: true });
    const nextNames = new Set();

    for (const skill of skills) {
        const name = sanitizeSkillName(skill?.name);
        const markdown = buildSkillMarkdown({ ...skill, name });
        if (!name || !markdown) continue;

        nextNames.add(name);
        const dirPath = path.join(skillsPath, name);
        await fsPromises.mkdir(dirPath, { recursive: true });
        await fsPromises.writeFile(path.join(dirPath, AGENT_RUNTIME_FILES.skillFile), markdown);
    }

    const entries = await fsPromises.readdir(skillsPath, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory() || nextNames.has(entry.name)) continue;
        await fsPromises.rm(path.join(skillsPath, entry.name), { recursive: true, force: true });
    }
}

export async function loadAgentRuntimeConfig(rootPath, config) {
    const runtimePath = getRuntimePath(rootPath);
    const baseConfig = config?.config || {};
    const prompts = { ...(baseConfig.prompts || {}) };

    const [systemPrompt, appendSystemPrompt, contextPrompt, memory, skills] = await Promise.all([
        readOptionalFile(path.join(runtimePath, AGENT_RUNTIME_FILES.system)),
        readOptionalFile(path.join(runtimePath, AGENT_RUNTIME_FILES.appendSystem)),
        readOptionalFile(path.join(runtimePath, AGENT_RUNTIME_FILES.context)),
        readOptionalFile(path.join(runtimePath, AGENT_RUNTIME_FILES.memory)),
        readSkills(rootPath),
    ]);

    if (systemPrompt !== null) prompts.system = systemPrompt.trim();
    if (appendSystemPrompt !== null) prompts.append = appendSystemPrompt.trim();
    if (contextPrompt !== null) prompts.context = contextPrompt.trim();

    // The canvas skill is server-managed (materialized from the binding); keep
    // it out of user config so it never duplicates or outlives the binding.
    const userSkills = skills !== null
        ? skills.filter((skill) => skill?.name !== CANVAS_SKILL_NAME)
        : null;

    return {
        ...config,
        config: {
            ...baseConfig,
            prompts,
            ...(memory !== null ? { memory: memory.trim() } : {}),
            ...(userSkills !== null ? { skills: userSkills } : {}),
        },
    };
}

export async function materializeAgentRuntimeFiles(rootPath, config) {
    const runtimePath = getRuntimePath(rootPath);
    const agentConfig = config?.config || {};
    const prompts = agentConfig.prompts || {};

    await fsPromises.mkdir(runtimePath, { recursive: true });
    await syncOptionalFile(path.join(runtimePath, AGENT_RUNTIME_FILES.system), prompts.system);
    await syncOptionalFile(path.join(runtimePath, AGENT_RUNTIME_FILES.appendSystem), prompts.append);
    await syncOptionalFile(path.join(runtimePath, AGENT_RUNTIME_FILES.context), prompts.context);
    await syncOptionalFile(path.join(runtimePath, AGENT_RUNTIME_FILES.memory), agentConfig.memory);

    // Bound agents get the server-managed canvas skill alongside user skills.
    const skills = [
        ...(agentConfig.skills || []).filter((skill) => skill?.name !== CANVAS_SKILL_NAME),
        ...(config?.access ? [CANVAS_SKILL] : []),
    ];
    await syncSkills(rootPath, skills);
}
