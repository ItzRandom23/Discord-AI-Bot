import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { BotError } from '../src/errors.js';
import { commandDefinitions, forGuildRegistration } from '../src/discord/commands.js';
import { createDiscordHandlers } from '../src/discord/handlers.js';
import { createPreview, splitText } from '../src/discord/presentation.js';
import { createRuntime, gatewayOptions } from '../src/discord/runtime.js';
import { channel, fixture, guild, modelId, sampleSecret, user } from './helpers.js';

let nextId = 1;
function mockCommand({ name = 'ai', subcommand = 'chat', options = {}, view = true, manage = false, kind = 'chat', customId } = {}) {
  const calls = [];
  return {
    id: String(nextId++), commandName: name, customId, guildId: guild, channelId: channel, user: { id: user },
    isChatInputCommand: () => kind === 'chat',
    isButton: () => kind === 'button',
    isAutocomplete: () => kind === 'autocomplete',
    memberPermissions: { has: (permission) => manage && permission === PermissionFlagsBits.ManageGuild },
    appPermissions: { has: (permission) => view && permission === PermissionFlagsBits.ViewChannel },
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => options[name] ?? null,
      getBoolean: (name) => options[name] ?? null,
      getAttachment: (name) => options[name] ?? null,
      getFocused: () => options.focused,
    },
    async deferReply(payload) { this.deferred = true; calls.push(['defer', payload]); },
    async deferUpdate() { this.deferred = true; calls.push(['update']); },
    async editReply(payload) { calls.push(['edit', payload]); },
    async followUp(payload) { calls.push(['follow', payload]); },
    async reply(payload) { this.replied = true; calls.push(['reply', payload]); },
    async respond(payload) { this.responded = true; calls.push(['autocomplete', payload]); },
    calls,
  };
}

test('slash definitions are serializable and expose only configured options', (t) => {
  const { config } = fixture(t, { AI_HISTORY_MINUTES: '0' });
  const [ai, admin] = commandDefinitions(config);
  assert.equal(admin.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
  assert.equal(ai.options.some(({ name }) => name === 'history'), false);
  const chat = ai.options.find(({ name }) => name === 'chat');
  assert.deepEqual(chat.options.map(({ name }) => name), ['prompt', 'provider', 'model', 'one_off']);
  const [guildAi] = forGuildRegistration([ai, admin]);
  assert.equal(guildAi.contexts, undefined);
  assert.equal(guildAi.integration_types, undefined);
});

test('private chat acknowledges before provider use, deduplicates interactions, and splits long replies', async (t) => {
  const command = mockCommand({ options: { prompt: 'hello' } });
  const { chat, config, state, calls } = fixture(t, {}, {
    gemini: { generate: async () => {
      assert.equal(command.deferred, true);
      return { text: '😀'.repeat(2400) + ' <@123456789000000008> ' + sampleSecret };
    } },
  });
  const handlers = createDiscordHandlers(config, chat, state);
  await Promise.all([handlers.interaction(command), handlers.interaction(command)]);
  assert.equal(calls.length, 1);
  assert.equal(command.calls[0][1].flags, MessageFlags.Ephemeral);
  assert.ok(command.calls.some(([action]) => action === 'follow'));
  for (const [action, payload] of command.calls.slice(1)) {
    assert.equal(payload.content.length <= 2000, true);
    assert.equal(payload.content.includes(sampleSecret), false);
    assert.deepEqual(payload.allowedMentions.parse, []);
    if (action === 'follow') assert.ok(payload.flags & MessageFlags.Ephemeral);
  }
  assert.deepEqual(splitText('a😀b', 3), ['a😀', 'b']);
});

test('permissions constrain provider settings and chat before any upstream call', async (t) => {
  const { chat, config, state, calls } = fixture(t);
  const handlers = createDiscordHandlers(config, chat, state);
  const unauthorized = mockCommand({ name: 'ai-config', options: { provider: 'gemini', enabled: false } });
  await handlers.interaction(unauthorized);
  assert.match(unauthorized.calls.at(-1)[1].content, /Manage Server/);
  assert.equal(state.providerAllowed(guild, 'gemini'), true);
  const noView = mockCommand({ view: false, options: { prompt: 'private guild text' } });
  await handlers.interaction(noView);
  assert.match(noView.calls.at(-1)[1].content, /View Channel/);
  assert.equal(calls.length, 0);

  const admin = mockCommand({ name: 'ai-config', manage: true, options: { provider: 'gemini', enabled: false } });
  await handlers.interaction(admin);
  assert.equal(state.providerAllowed(guild, 'gemini'), false);
  assert.equal(state.providerAllowed('another guild', 'gemini'), true);
  const autocomplete = mockCommand({ kind: 'autocomplete', options: { focused: { name: 'provider', value: '' } } });
  await handlers.interaction(autocomplete);
  assert.deepEqual(autocomplete.calls[0], ['autocomplete', [{ name: 'OpenAI', value: 'openai' }]]);
  const models = mockCommand({ kind: 'autocomplete', options: { provider: 'openai', focused: { name: 'model', value: 'chat' } } });
  await handlers.interaction(models);
  assert.deepEqual(models.calls[0], ['autocomplete', [{ name: modelId, value: modelId }]]);
});

test('history reset buttons are user and channel bound', async (t) => {
  const { chat, config, state } = fixture(t);
  const handlers = createDiscordHandlers(config, chat, state);
  const identity = { guildId: guild, channelId: channel, userId: user };
  await chat.complete({ ...identity, prompt: 'history entry' });
  const history = mockCommand({ subcommand: 'history' });
  await handlers.interaction(history);
  const payload = history.calls.at(-1)[1];
  assert.match(payload.embeds[0].description, /history entry/);
  const customId = payload.components[0].toJSON().components[0].custom_id;
  const other = mockCommand({ kind: 'button', customId });
  other.user = { id: '123456789000000022' };
  await handlers.interaction(other);
  assert.match(other.calls[0][1].content, /opened this history/);
  const owner = mockCommand({ kind: 'button', customId });
  await handlers.interaction(owner);
  assert.equal(owner.calls[0][0], 'update');
  assert.deepEqual(owner.calls[1][1].components, []);
  assert.deepEqual(chat.history(identity).turns, []);
});

test('legacy messages use the configured channel, Gemini, typing, and mention-safe replies', async (t) => {
  const { chat, config, state, calls } = fixture(t, { DISCORD_LEGACY_CHANNEL_ID: channel, AI_DEFAULT_PROVIDER: 'openai' });
  const handlers = createDiscordHandlers(config, chat, state);
  const replies = [];
  let typing = 0;
  const message = {
    id: '1', guildId: guild, channelId: channel, author: { id: user, bot: false }, content: 'public message',
    client: { user: { id: 'bot' } },
    channel: { permissionsFor: () => ({ has: () => true }), isThread: () => false, async sendTyping() { typing += 1; } },
    async reply(payload) { replies.push(payload); },
  };
  await handlers.message({ ...message, channelId: 'wrong channel' });
  await handlers.message({ ...message, webhookId: 'external webhook' });
  await handlers.message(message);
  await handlers.message(message);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'gemini');
  assert.equal(typing, 1);
  assert.equal(replies[0].allowedMentions.repliedUser, false);
  assert.deepEqual(chat.history({ guildId: guild, channelId: channel, userId: user }, 'gemini').turns, []);
});

test('provider error details are excluded from interaction replies and logs', async (t) => {
  const { chat, config, state } = fixture(t, {}, {
    gemini: { generate: () => { throw Object.assign(new Error(sampleSecret), { status: 429, code: 'insufficient_quota' }); } },
  });
  const logs = [];
  const handlers = createDiscordHandlers(config, chat, state, { log: (...entry) => logs.push(entry) });
  const command = mockCommand({ options: { prompt: 'test' } });
  await handlers.interaction(command);
  assert.match(command.calls.at(-1)[1].content, /quota or billing limit/);
  assert.deepEqual(logs, [['interaction', 'quota']]);
  assert.ok(!JSON.stringify(command.calls).includes(sampleSecret));
});

test('draft updates finish before the final response and are capped', async () => {
  let time = 10000;
  const command = mockCommand();
  const log = () => assert.fail('Unexpected preview error');
  const preview = createPreview(command, log, () => time);
  for (let i = 0; i < 8; i++) {
    preview.show('draft ' + i);
    await new Promise((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
    time += 1500;
  }
  await preview.finish();
  preview.show('late draft');
  assert.equal(command.calls.length, 4);
});

test('known public errors cannot expose an inherited object property', () => {
  assert.equal(new BotError('constructor').code, 'internal');
});

test('one gateway starts, uses minimal intents, and drains work during shutdown', async (t) => {
  let resolveGeneration;
  const generationStarted = new Promise((resolve) => { resolveGeneration = resolve; });
  const { config } = fixture(t, {}, {
    gemini: { generate: async ({ signal }) => {
      resolveGeneration();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } },
  });
  assert.deepEqual(gatewayOptions(config).intents, [GatewayIntentBits.Guilds]);
  assert.deepEqual(gatewayOptions({ ...config, legacyChannel: channel }).intents,
    [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]);
  const activity = [];
  const client = new EventEmitter();
  client.login = async () => { activity.push('login'); client.emit(Events.ClientReady, client); };
  client.destroy = async () => { activity.push('destroy'); };
  const runtime = createRuntime(config, { client, directory: null, log: (event, status) => activity.push(event + '/' + status) });
  t.after(() => runtime.stop());
  await Promise.all([runtime.start(), runtime.start()]);
  assert.equal(client.listenerCount(Events.InteractionCreate), 1);
  assert.equal(client.listenerCount(Events.MessageCreate), 0);
  client.emit(Events.ShardResume);
  const chat = mockCommand({ options: { prompt: 'test' } });
  client.emit(Events.InteractionCreate, chat);
  await generationStarted;
  const stopping = runtime.stop();
  assert.equal(runtime.stop(), stopping);
  await stopping;
  assert.match(chat.calls.at(-1)[1].content, /shutting down/);
  assert.deepEqual(activity, ['login', 'gateway/ready', 'gateway/resumed', 'interaction/stopped', 'destroy', 'gateway/stopped']);
  assert.throws(() => runtime.start(), { code: 'stopped' });
});

test('an unexpected Discord application ID triggers the safe shutdown path', async (t) => {
  const { config } = fixture(t, { DISCORD_APPLICATION_ID: guild });
  const client = new EventEmitter();
  client.login = async () => { client.emit(Events.ClientReady, { application: { id: channel } }); };
  client.destroy = async () => {};
  const statuses = [];
  const runtime = createRuntime(config, {
    client, directory: null, log: (_, status) => statuses.push(status), onFatal: () => { void runtime.stop(); },
  });
  t.after(() => runtime.stop());
  await runtime.start();
  await runtime.stop();
  assert.deepEqual(statuses, ['application_id_mismatch', 'stopped']);
});
