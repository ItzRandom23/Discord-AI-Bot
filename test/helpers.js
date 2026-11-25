import { ChatService } from '../src/chat.js';
import { loadConfig } from '../src/config.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { createRedactor } from '../src/security.js';
import { BotState } from '../src/state.js';

export const guild = '123456789000000001';
export const channel = '123456789000000002';
export const user = '123456789000000003';
export const identity = { guildId: guild, channelId: channel, userId: user };
export const sampleSecret = 'syntheticCredential' + 'OnlyUsedInMockRequests';
export const modelId = 'example-chat';

export function testEnvironment(overrides = {}) {
  const models = JSON.stringify([{ id: modelId, image: true, streaming: true, inputUsdPerMillion: 1, outputUsdPerMillion: 2 }]);
  return {
    DISCORD_TOKEN: sampleSecret,
    GEMINI_API_KEY: sampleSecret,
    GEMINI_MODELS: models,
    OPENAI_API_KEY: sampleSecret,
    OPENAI_MODELS: models,
    ...overrides,
  };
}

export function fixture(t, overrides = {}, factories = {}) {
  const calls = [];
  const verifications = [];
  const definitions = ['gemini', 'openai'].map((id) => ({
    id, label: id === 'gemini' ? 'Google Gemini' : 'OpenAI',
    create: () => ({
      async verify(model, signal) {
        verifications.push({ id, model, signal });
        return factories[id]?.verify ? factories[id].verify(model, signal) : {};
      },
      async generate(request) {
        calls.push({ id, ...request });
        return factories[id]?.generate ? factories[id].generate(request) : { text: 'a reply from ' + id, usage: { input: 20, output: 10 } };
      },
    }),
  }));
  const config = loadConfig(testEnvironment(overrides), { definitions });
  const clock = { time: 10000 };
  const now = () => clock.time;
  const state = new BotState(config, { directory: null, now });
  t.after(() => state.close());
  const registry = new ProviderRegistry(config, { now });
  const chat = new ChatService(config, registry, state, createRedactor(config.secrets));
  return { chat, calls, verifications, config, state, clock };
}
