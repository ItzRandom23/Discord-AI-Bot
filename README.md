# Discord AI Bot

Private Discord chat with Google Gemini and OpenAI. Choose a model, continue a conversation, or send a one-off prompt. Image input and streaming are optional.

## Setup

1. Install Node.js 24.17.0 or newer in the 24.x line.
2. Create an app in the [Discord Developer Portal](https://discord.com/developers/applications). Enable **Guild Install** with `bot` and `applications.commands`, grant **View Channel**, and invite it to your test server.
3. Copy [`.env.example`](.env.example) to `.env`. Set `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, and `GEMINI_API_KEY` or `OPENAI_API_KEY`. Set both keys to use both providers.
4. Leave `DISCORD_COMMAND_GUILD_ID` blank for global commands. Set it to a server ID for registration in that server only.

```sh
npm ci --omit=dev --ignore-scripts
npm run check:providers
npm run register
npm start
```

Test `/ai chat` with each configured provider. For public installs, enable **Public Bot**, share the install link, and run one bot process on an always-on host.

## Commands

| Command | What it does |
| --- | --- |
| `/ai chat` | Chat privately with the selected provider and model. Use `one_off:true` to skip history. |
| `/ai models` · `/ai settings` | See available models, defaults, and history settings. |
| `/ai history` · `/ai reset` | View or clear your history in the current channel. |
| `/ai-config provider` | Enable or disable a provider for the server. Requires **Manage Server**. |

## Privacy

The selected provider receives your prompt, relevant history, and any image you attach. Text history stays in memory for 60 minutes by default. Set `AI_HISTORY_MINUTES=0` to disable it or `AI_HISTORY_KEY` to enable encrypted storage. Fallback requires user consent and sends only the current text. See the [Gemini terms](https://aistudio.google.com/docs/terms) and [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data).
