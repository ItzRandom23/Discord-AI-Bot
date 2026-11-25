# Changelog

## 0.2.0

- Unified Google Gemini and OpenAI behind independent provider adapters using their official SDKs, with configurable model catalogs, defaults, and account metadata checks.
- Added private slash chat, model autocomplete, history and reset, settings, and server-level provider controls. Preserved the opt-in public Gemini channel with typing indicators.
- Added ordered and isolated conversation history, bounded context and retention, optional encrypted SQLite persistence, supported image input and streams, and opt-in text fallback.
- Added request and concurrency limits, duplicate event suppression, bounded retry and timeout handling, provider backoff, safe logs and replies, and graceful shutdown.
- Updated Discord.js and the runtime to Node.js 24 LTS. Replaced the legacy Gemini SDK, added the OpenAI SDK, and added tests, dependency auditing, and CI secret scanning.

## 0.1.0

- Initial Discord bot for Gemini responses in one configured channel.
