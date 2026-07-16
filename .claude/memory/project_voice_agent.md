---
name: project-voice-agent
description: Voice agent pipeline (STT/TTS service + agents/:id/voice endpoint + web UI mic) implemented 2026-07-03
metadata: 
  node_type: memory
  type: project
  originSessionId: 87724821-8838-49f1-b9cb-aaf03216ea06
---

Voice agent implemented (2026-07-03), server + web UI submodule.

**Server:** `src/services/voice/` (embedd pattern, pure DI) — OpenAI audio API dialect both sides: STT `POST {base}/v1/audio/transcriptions` (speaches/faster-whisper/whisper.cpp), TTS `POST {base}/v1/audio/speech` (kokoro-fastapi/openedai-speech-piper). Each side activates only when its base URL env is set; `GET /rest/v2/voice/status` reports. Utility routes `/rest/v2/voice/{transcribe,speak}` (agent tokens rejected).

**Round-trip:** `POST /rest/v2/agents/:id/voice` (multipart audio OR JSON base64) → transcribe → `agents.prompt` → TTS → JSON `{transcript, reply, audio(base64), audioMimeType, voice}`. `?tts=false`, `voice`, `format`, `language` opts. TTS failure degrades to text-only (doesn't fail request).

**UI (src/ui/web submodule):** mic button in `AgentChatPanel.tsx` (shown only when voice status stt enabled), `useVoiceRecorder.ts` (MediaRecorder webm/opus), `sendVoice` in `useAgentPromptStream.ts` (appends 🎤 transcript + reply, plays base64 audio via `new Audio(data:...)`). `voicePrompt`/`getVoiceStatus` in `services/agent.ts`. Built dist verified served.

**Env:** `CANVAS_VOICE_STT_URL`, `CANVAS_VOICE_STT_MODEL` (default whisper-1), `CANVAS_VOICE_STT_LANGUAGE`, `CANVAS_VOICE_TTS_URL`, `CANVAS_VOICE_TTS_MODEL` (default kokoro), `CANVAS_VOICE_TTS_VOICE` (default af_heart), `CANVAS_VOICE_TTS_FORMAT` (mp3), plus `_API_KEY` for both. No local STT/TTS servers were running as of 2026-07-03 — user needs to start kokoro (:8880) / speaches (:8000) or similar.

**Verified** via mock OpenAI-compatible server (scratchpad mock-speech.js pattern: fake transcriptions/speech/models/chat-completions SSE) — full audio→STT→pi-agent→TTS round-trip through real REST. Trick for testing agents without real LLM: `llmProvider: lm-studio` + `config.baseUrl` pointing at mock serving /v1/models + SSE /v1/chat/completions.

**Deferred:** WebRTC full-duplex (streaming STT/TTS on same service seam); voice as messaging adapter (call agent via WhatsApp voice); barge-in; per-agent voice config.

Related: [[project-agent-scoping]]
