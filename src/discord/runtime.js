import { Client, Events, GatewayIntentBits } from 'discord.js';
import { ChatService } from '../chat.js';
import { BotError } from '../errors.js';
import { ProviderRegistry } from '../providers/registry.js';
import { createRedactor } from '../security.js';
import { BotState } from '../state.js';
import { createDiscordHandlers } from './handlers.js';

export function gatewayOptions(config) {
  const intents = [GatewayIntentBits.Guilds];
  if (config.legacyChannel) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  return { intents, rest: { timeout: 12_000, retries: 1 } };
}

export function createRuntime(config, {
  client = new Client(gatewayOptions(config)), directory = config.stateDirectory,
  log = () => {}, onFatal = () => {},
} = {}) {
  const shutdown = new AbortController();
  const registry = new ProviderRegistry(config, { signal: shutdown.signal });
  const state = new BotState(config, { directory });
  const service = new ChatService(config, registry, state, createRedactor(config.secrets), { signal: shutdown.signal });
  const handlers = createDiscordHandlers(config, service, state, { log });
  const operations = new Set();
  const track = (handler) => (input) => {
    if (shutdown.signal.aborted) return;
    const task = Promise.resolve().then(() => handler(input)).catch(() => log('discord_event', 'failed'))
      .finally(() => operations.delete(task));
    operations.add(task);
  };

  const sweep = setInterval(() => {
    try {
      state.sweep();
    } catch {
      log('state', 'cleanup_failed');
    }
  }, 15_000);
  sweep.unref();

  client.on(Events.InteractionCreate, track(handlers.interaction));
  if (config.legacyChannel) client.on(Events.MessageCreate, track(handlers.message));
  client.on(Events.Error, () => log('gateway', 'client_error'));
  client.on(Events.ShardError, () => log('gateway', 'shard_error'));
  client.on(Events.ShardResume, () => log('gateway', 'resumed'));
  client.once(Events.ClientReady, (readyClient) => {
    if (config.applicationId && readyClient.application?.id !== config.applicationId) {
      log('gateway', 'application_id_mismatch');
      onFatal();
    } else {
      log('gateway', 'ready');
    }
  });

  let starting;
  let closing;
  return {
    start() {
      shutdown.signal.throwIfAborted();
      starting ??= client.login(config.token);
      return starting;
    },
    stop() {
      closing ??= (async () => {
        shutdown.abort(new BotError('stopped'));
        clearInterval(sweep);
        let timer;
        try {
          await Promise.race([Promise.allSettled(operations), new Promise((resolve) => { timer = setTimeout(resolve, 5000); })]);
          await client.destroy();
          log('gateway', 'stopped');
        } finally {
          clearTimeout(timer);
          state.close();
        }
      })();
      return closing;
    },
  };
}
