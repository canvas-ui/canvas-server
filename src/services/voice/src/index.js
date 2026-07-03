'use strict';

/**
 * Voice — speech-to-text + text-to-speech service (embedd pattern: nested
 * package, pure-DI constructor, zero env reads).
 *
 * Both sides speak the OpenAI audio API dialect, which every practical local
 * server implements:
 *   STT: POST {sttBaseUrl}/v1/audio/transcriptions (multipart)
 *        — speaches / faster-whisper-server / whisper.cpp server / OpenAI
 *   TTS: POST {ttsBaseUrl}/v1/audio/speech (json → audio bytes)
 *        — kokoro-fastapi / openedai-speech (piper) / OpenAI
 *
 * WebRTC full-duplex is a later transport on top of the same two calls.
 */

function trimSlash(value = '') {
    return String(value || '').replace(/\/+$/, '');
}

function audioApiUrl(baseUrl, endpoint) {
    const base = trimSlash(baseUrl);
    return /\/v\d+$/.test(base) ? `${base}/audio/${endpoint}` : `${base}/v1/audio/${endpoint}`;
}

export class Voice {
    #stt;
    #tts;
    #logger;

    /**
     * @param {Object} options
     * @param {Object} [options.stt] - { baseUrl, apiKey?, model, language? }
     * @param {Object} [options.tts] - { baseUrl, apiKey?, model, voice, format? }
     * @param {Object} [options.logger]
     */
    constructor(options = {}) {
        this.#stt = options.stt?.baseUrl ? { ...options.stt } : null;
        this.#tts = options.tts?.baseUrl ? { ...options.tts } : null;
        this.#logger = options.logger || console;
    }

    get sttEnabled() { return Boolean(this.#stt); }
    get ttsEnabled() { return Boolean(this.#tts); }

    status() {
        return {
            stt: this.#stt ? { baseUrl: this.#stt.baseUrl, model: this.#stt.model } : null,
            tts: this.#tts
                ? { baseUrl: this.#tts.baseUrl, model: this.#tts.model, voice: this.#tts.voice }
                : null,
        };
    }

    /**
     * Transcribe an audio clip.
     * @param {Buffer} audio
     * @param {Object} [options]
     * @param {string} [options.mimeType]  - e.g. audio/webm
     * @param {string} [options.filename]
     * @param {string} [options.language]
     * @returns {Promise<{ text: string }>}
     */
    async transcribe(audio, options = {}) {
        if (!this.#stt) throw new Error('Speech-to-text is not configured (CANVAS_VOICE_STT_URL)');
        if (!audio?.length) throw new Error('audio is required');

        const mimeType = options.mimeType || 'audio/webm';
        const filename = options.filename
            || `audio.${(mimeType.split('/')[1] || 'webm').split(';')[0]}`;

        const form = new FormData();
        form.append('file', new Blob([audio], { type: mimeType }), filename);
        form.append('model', this.#stt.model || 'whisper-1');
        const language = options.language || this.#stt.language;
        if (language) form.append('language', language);

        const response = await fetch(audioApiUrl(this.#stt.baseUrl, 'transcriptions'), {
            method: 'POST',
            headers: this.#stt.apiKey ? { Authorization: `Bearer ${this.#stt.apiKey}` } : {},
            body: form,
            signal: AbortSignal.timeout(options.timeout || 60000),
        });

        if (!response.ok) {
            throw new Error(`STT failed: ${await this.#errorText(response)}`);
        }

        const payload = await response.json();
        const text = String(payload?.text ?? '').trim();
        this.#logger.debug?.(`voice: transcribed ${audio.length}b -> ${text.length} chars`);
        return { text };
    }

    /**
     * Synthesize speech for a text.
     * @param {string} text
     * @param {Object} [options]
     * @param {string} [options.voice]
     * @param {string} [options.format] - mp3 | wav | opus | flac (server-dependent)
     * @returns {Promise<{ audio: Buffer, mimeType: string, format: string, voice: string }>}
     */
    async speak(text, options = {}) {
        if (!this.#tts) throw new Error('Text-to-speech is not configured (CANVAS_VOICE_TTS_URL)');
        const input = String(text ?? '').trim();
        if (!input) throw new Error('text is required');

        const voice = options.voice || this.#tts.voice || 'af_heart';
        const format = options.format || this.#tts.format || 'mp3';

        const response = await fetch(audioApiUrl(this.#tts.baseUrl, 'speech'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(this.#tts.apiKey ? { Authorization: `Bearer ${this.#tts.apiKey}` } : {}),
            },
            body: JSON.stringify({
                model: this.#tts.model || 'kokoro',
                input,
                voice,
                response_format: format,
            }),
            signal: AbortSignal.timeout(options.timeout || 60000),
        });

        if (!response.ok) {
            throw new Error(`TTS failed: ${await this.#errorText(response)}`);
        }

        const audio = Buffer.from(await response.arrayBuffer());
        this.#logger.debug?.(`voice: synthesized ${input.length} chars -> ${audio.length}b ${format}`);
        return {
            audio,
            mimeType: format === 'wav' ? 'audio/wav' : format === 'opus' ? 'audio/ogg' : `audio/${format}`,
            format,
            voice,
        };
    }

    async #errorText(response) {
        const body = await response.text().catch(() => '');
        try {
            const payload = JSON.parse(body);
            const message = payload?.error?.message || payload?.message || payload?.detail;
            if (message) return `HTTP ${response.status}: ${typeof message === 'string' ? message : JSON.stringify(message)}`;
        } catch { /* non-json body */ }
        return `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`;
    }
}

export default Voice;
