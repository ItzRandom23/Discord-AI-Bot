# Discord AI

A single Discord bot for private, multi-turn chat with Google Gemini and OpenAI. A dedicated channel can retain the original public Gemini experience.

| Provider | API | Features |
| --- | --- | --- |
| Google Gemini | [Gemini Developer API](https://aistudio.google.com/api-reference/generate-content) with `@google/genai` | Text chat, optional image input and streaming, reported token usage |
| OpenAI | [Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses) with `openai` | Text chat, optional image input and streaming, reported token usage |

Image input and streaming require the operator to enable them globally and in the chosen model’s catalog entry. The example models are [Gemini 3.8 Flash](https://aistudio.google.com/docs/models/gemini-3.8-flash) and [GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini). Access depends on the API account and model availability.

## Setup

1. Install Node.js **24.17.0 or later in the 24.x line** and run `npm ci --omit=dev --ignore-scripts`.
2. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and bot. Copy `.env.example` to `.env` or configure the variables in your secret manager. Set `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, and at least one provider API key and model catalog. Provision project-specific keys and provider-side budgets.
3. Install the app into a development guild with the `bot` and `applications.commands` scopes. Give it **View Channel** in AI channels. Grant **Send Messages** and **Read Message History** in the legacy channel if enabled, plus **Send Messages in Threads** if that channel is a thread. Keep privileged intents disabled for slash commands. Enable **Message Content Intent** in the portal only if you configure the legacy listener.
4. Set `DISCORD_COMMAND_GUILD_ID` for a development-guild registration. Run `npm run check:providers` to verify account access to each configured model. Run `npm run check:providers -- --generate` for a billable text smoke test with a fixed, non-user prompt.
5. Run `npm run register` explicitly, then `npm start`. Registration replaces the command list in the selected scope. Omit the test guild ID for application-wide registration, which also enables bot DMs. Rerun registration after changing command options or their availability.

The bot logs readiness, reconnect, shutdown, and sanitized failure categories. Confirm `gateway/ready` followed by a successful private response from each configured provider. For always-on hosting, use a service manager with restart-on-failure, one process per bot token, and a dedicated local state directory owned by the service account. Mount persistent storage for guild settings and any encrypted history you enable. Allow outbound Discord HTTPS and Gateway WebSocket access, plus HTTPS to the enabled provider API origins.

## Commands

| Command | Behavior |
| --- | --- |
| `/ai chat prompt:<text>` | Replies privately. Choose a provider or model with autocomplete. `one_off:true` skips history. `image`, `stream`, and `fallback` appear when enabled. |
| `/ai models [provider]` | Lists the configured model IDs and enabled capabilities in this server. |
| `/ai settings` | Shows the bot defaults, providers enabled in this server, and history policy. |
| `/ai history [provider] [model]` | Shows excerpts from your recent saved turns for this model in this channel, with a reset button. |
| `/ai reset` | Clears your saved turns across all models in this channel and cancels your active request. |
| `/ai-config provider provider:<id> enabled:<true/false>` | Changes provider availability for this server. Requires **Manage Server**. |

Chat defaults to the configured provider and that provider’s default model. If that provider is disabled for a server, select an enabled provider explicitly. Bot DMs have their own private history. Provider usage appears with the reply when available, and optional operator-supplied model rates produce an estimate in USD.

## Configuration

All variables and defaults are listed in [`.env.example`](.env.example).

| Variables | Purpose |
| --- | --- |
| `APP_NAME`, `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_COMMAND_GUILD_ID` | Display name, bot login, application ID and optional registration scope |
| `DISCORD_LEGACY_CHANNEL_ID` | Optional single guild channel. Human text messages there go to Gemini, with public replies and a typing indicator. |
| `GEMINI_API_KEY`, `OPENAI_API_KEY`, `GEMINI_MODELS`, `OPENAI_MODELS` | Enable each provider and define the models users can select. Set one or both providers. |
| `GEMINI_DEFAULT_MODEL`, `OPENAI_DEFAULT_MODEL`, `AI_DEFAULT_PROVIDER` | Choose defaults. If omitted, use the first entry in each catalog and the first configured provider (Gemini before OpenAI). |
| `AI_FALLBACK_PROVIDERS` | Priority list of configured providers eligible for explicit, per-request fallback. Blank disables fallback. |
| `AI_HISTORY_MINUTES`, `AI_HISTORY_TURNS`, `AI_MAX_SESSIONS`, `AI_HISTORY_KEY`, `AI_STATE_DIR` | History lifetime, per-session turn and global session limits, optional encryption key, and SQLite directory |
| `AI_MAX_PROMPT_CHARS`, `AI_MAX_CONTEXT_CHARS`, `AI_MAX_OUTPUT_CHARS`, `AI_MAX_OUTPUT_TOKENS` | Limits for input, replayed context, Discord output, and provider output tokens |
| `AI_MAX_IMAGE_KIB`, `AI_STREAMING_ENABLED` | Set a nonzero image limit or enable draft updates. Both default off. |
| `AI_TIMEOUT_MS`, `AI_RATE_LIMIT_RETRIES` | Total deadline for attachment and AI work, with at most one short backoff retry on explicit rate limiting |
| `AI_RATE_WINDOW_MS`, `AI_USER_REQUESTS`, `AI_GUILD_REQUESTS`, `AI_GLOBAL_REQUESTS` | Fixed-window request limits. The default grants 4 per user, 30 per guild, and 120 globally per minute. |
| `AI_MAX_CONCURRENT`, `AI_MAX_GUILD_CONCURRENT` | Cap concurrent work across the bot and within a guild |

A catalog is a JSON array of one to ten entries. Each entry requires an `id` and accepts `image`, `streaming`, and the optional price pair `inputUsdPerMillion` and `outputUsdPerMillion`. Select documented text-generation models and verify them against your provider accounts. Runtime metadata checks are cached. OpenAI’s model metadata confirms existence and access. Use the model documentation and smoke tests to verify endpoint and modality support. Estimated cost uses reported token counts and configured flat rates. Provider dashboards account for caching, tier pricing, and requests which fail after submission.

## Privacy and data retention

- Each slash response is ephemeral. The selected provider receives the current prompt, any uploaded image, and relevant prior turns. History is scoped to the guild, channel, user, provider, and model. DMs use a separate scope.
- Text history is kept in memory by default for up to 60 minutes after the last saved turn. Set `AI_HISTORY_MINUTES=0` to disable it, or use `one_off:true` for a single request. Image bytes are used for the current request only. Saved text may include descriptions of an image.
- To persist encrypted text history, provision a random 32-byte key in base64. Generate one with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"` in a private terminal and store it in your secret manager. SQLite stores encrypted turns and plaintext scope identifiers and timestamps. Guild settings contain guild IDs and provider switches and persist independently.
- Reset clears the bot’s local history. Prior replies and external copies remain subject to Discord, provider, and backup retention. OpenAI is called with `store:false`. Review provider data controls and use an account tier that rules out training on Discord message content unless you have express permission from Discord. Google’s free and paid Gemini tiers have different data-use terms. [Discord Developer Policy](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy) · [Gemini terms](https://aistudio.google.com/docs/terms) · [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)
- Fallback requires an operator-configured priority and `fallback:true`. The next allowed provider gets only the current text on eligible failures before any output starts. Images stay with the original provider. Fallback turns are skipped in history. Discord identifies the provider that answered.
- In the optional legacy channel, ordinary user text is sent to Gemini without slash history. Label the channel so users know before they post.

## Troubleshooting and maintenance

- **Commands are missing** — Verify the installed app ID, scopes and guild ID, then register the commands. Guild registration is convenient for initial testing.
- **The provider is rejected or unavailable** — Check `/ai settings`, the server policy, API key, model access and billing. Try `npm run check:providers`. Do not share provider error payloads or keys.
- **SQLite fails at startup** — Check state directory permissions and available disk space. If encrypted history already exists, restore its original key. To retire it, stop the bot and handle the old `conversations.sqlite` file and its backups according to your retention policy.
- **Busy or rate-limited** — Inspect the provider’s quotas and the bot’s request and concurrency limits. Changes take effect on restart. Cancelling a request locally may still incur provider charges.
- For local verification, run `npm ci --ignore-scripts`, `npm run lint`, `npm run check`, `npm test`, and `npm audit`. The test suite exercises the installed SDKs with mocked HTTP and SSE responses and uses simulated Discord interactions. The JavaScript runs directly on Node.

## Adding a provider or importing features

Use `src/providers/index.js` to register an adapter with an ID, display label, and factory. The factory returns `verify(model, signal)` for metadata and `generate({ model, messages, signal, maxOutputTokens, onText })` for ordered text turns, optional image bytes, optional streaming deltas, and normalized usage. Restrict destinations, disable SDK auto-retries, and add contract tests against the new provider’s documented API. Configuration follows the existing `<PROVIDER>_API_KEY` and `<PROVIDER>_MODELS` pattern.

Import useful provider code or commands into `src/providers/` or `src/discord/`, reusing `src/chat.js` for admission, history, and request orchestration. Keep the single client and listeners in `index.js` and command definitions in `src/discord/commands.js`. Preserve license notices and attribution when importing code. The original license and copyright are in [LICENSE](LICENSE).

See [SECURITY.md](SECURITY.md) for security and credential handling and [CHANGELOG.md](CHANGELOG.md) for changes.
