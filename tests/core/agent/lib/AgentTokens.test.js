import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    mintAgentToken,
    hashToken,
    isAgentToken,
    normalizeAgentPermissions,
    verifyAgentTokenValue,
    AGENT_TOKEN_PREFIX,
} from '../../../../src/core/agent/lib/AgentTokens.js';

describe('AgentTokens', () => {
    test('mint produces prefixed value with matching sha256 hash', () => {
        const token = mintAgentToken();
        assert.ok(token.value.startsWith(AGENT_TOKEN_PREFIX));
        assert.equal(token.hash, hashToken(token.value));
        assert.ok(token.hash.startsWith('sha256:'));
        assert.deepEqual(token.permissions, ['read']);
        assert.ok(token.id);
    });

    test('permissions normalize and validate', () => {
        assert.deepEqual(normalizeAgentPermissions(['READ', 'write', 'write']), ['read', 'write']);
        assert.deepEqual(normalizeAgentPermissions(undefined), ['read']);
        assert.throws(() => normalizeAgentPermissions(['admin']), /Invalid agent permission/);
    });

    test('isAgentToken discriminates prefixes', () => {
        assert.ok(isAgentToken(`${AGENT_TOKEN_PREFIX}abc`));
        assert.ok(!isAgentToken('canvas-workspace-abc'));
        assert.ok(!isAgentToken(null));
    });

    test('verifyAgentTokenValue checks hash and expiry', () => {
        const token = mintAgentToken({ permissions: ['read', 'write'] });
        const access = { tokenHash: token.hash };
        assert.ok(verifyAgentTokenValue(token.value, access));
        assert.ok(!verifyAgentTokenValue(`${AGENT_TOKEN_PREFIX}wrong`, access));
        assert.ok(!verifyAgentTokenValue(token.value, { tokenHash: token.hash, tokenExpiresAt: '2000-01-01T00:00:00Z' }));
        assert.ok(!verifyAgentTokenValue(token.value, null));
    });

    test('rotation invalidates the previous value', () => {
        const first = mintAgentToken();
        const second = mintAgentToken({ permissions: first.permissions });
        const access = { tokenHash: second.hash };
        assert.ok(!verifyAgentTokenValue(first.value, access));
        assert.ok(verifyAgentTokenValue(second.value, access));
    });
});
