'use strict';

import ResponseObject from '../../ResponseObject.js';
import { validateUser } from '../../auth/strategies.js';
import { rejectAgentTokens } from '../../middleware/agent-acl.js';

/**
 * Voice utility routes — building blocks the UI (and clients) can use
 * directly. The agent voice round-trip lives at POST /agents/:id/voice.
 *
 * GET  /status     — which sides (stt/tts) are configured
 * POST /transcribe — multipart audio -> { text }
 * POST /speak      — { text, voice?, format? } -> audio bytes
 */
export default async function voiceRoutes(fastify, _options) {

    fastify.addHook('preHandler', rejectAgentTokens);

    const requireUser = (request, reply) => {
        if (!validateUser(request.user, ['id'])) {
            const r = new ResponseObject().unauthorized('Valid authentication required');
            reply.code(r.statusCode).send(r.getResponse());
            return false;
        }
        return true;
    };

    const requireVoice = (reply) => {
        if (!fastify.voice) {
            const r = new ResponseObject().serverError(
                'Voice service not configured (set CANVAS_VOICE_STT_URL / CANVAS_VOICE_TTS_URL)',
            );
            reply.code(r.statusCode).send(r.getResponse());
            return false;
        }
        return true;
    };

    fastify.get('/status', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply)) return;
        const status = fastify.voice
            ? { enabled: true, ...fastify.voice.status() }
            : { enabled: false, stt: null, tts: null };
        const r = new ResponseObject().found(status, 'Voice status retrieved');
        return reply.code(r.statusCode).send(r.getResponse());
    });

    fastify.post('/transcribe', { onRequest: [fastify.authenticate] }, async (request, reply) => {
        if (!requireUser(request, reply) || !requireVoice(reply)) return;
        try {
            const file = await request.file();
            if (!file) {
                const r = new ResponseObject().badRequest('Multipart audio file required');
                return reply.code(r.statusCode).send(r.getResponse());
            }
            const audio = await file.toBuffer();
            const result = await fastify.voice.transcribe(audio, {
                mimeType: file.mimetype,
                filename: file.filename,
            });
            const r = new ResponseObject().success(result, 'Audio transcribed');
            return reply.code(r.statusCode).send(r.getResponse());
        } catch (err) {
            fastify.log.error(err);
            const r = err.message?.includes('not configured') || err.message?.includes('required')
                ? new ResponseObject().badRequest(err.message)
                : new ResponseObject().serverError(err.message || 'Transcription failed');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });

    fastify.post('/speak', {
        onRequest: [fastify.authenticate],
        schema: {
            body: {
                type: 'object',
                required: ['text'],
                properties: {
                    text: { type: 'string', minLength: 1 },
                    voice: { type: 'string' },
                    format: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        if (!requireUser(request, reply) || !requireVoice(reply)) return;
        try {
            const { audio, mimeType } = await fastify.voice.speak(request.body.text, {
                voice: request.body.voice,
                format: request.body.format,
            });
            return reply.code(200).header('Content-Type', mimeType).send(audio);
        } catch (err) {
            fastify.log.error(err);
            const r = err.message?.includes('not configured') || err.message?.includes('required')
                ? new ResponseObject().badRequest(err.message)
                : new ResponseObject().serverError(err.message || 'Speech synthesis failed');
            return reply.code(r.statusCode).send(r.getResponse());
        }
    });
}
