import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { downloadImage } from '../src/attachments.js';
import { loadConfig } from '../src/config.js';
import { createRedactor, visibleText } from '../src/security.js';
import { BotState, conversationScope, trimTurns } from '../src/state.js';
import { channel, identity, modelId, sampleSecret, testEnvironment } from './helpers.js';

test('configuration rejects invalid limits, secrets, model IDs, pricing, and pollution keys', () => {
  const failures = [
    [{ DISCORD_TOKEN: '' }, 'DISCORD_TOKEN'],
    [{ AI_DEFAULT_PROVIDER: 'toString' }, 'AI_DEFAULT_PROVIDER'],
    [{ AI_FALLBACK_PROVIDERS: 'openai,openai' }, 'AI_FALLBACK_PROVIDERS'],
    [{ GEMINI_MODELS: '[{"id":"model/../secret"}]' }, 'GEMINI_MODELS'],
    [{ GEMINI_MODELS: '[{"id":"valid","__proto__":{"image":true}}]' }, 'GEMINI_MODELS'],
    [{ GEMINI_MODELS: '[{"id":"valid","inputUsdPerMillion":2}]' }, 'GEMINI_MODELS'],
    [{ GEMINI_MODELS: '[{"id":"valid"},{"id":"valid"}]' }, 'GEMINI_MODELS'],
    [{ GEMINI_MODELS: JSON.stringify([{ id: sampleSecret }]) }, 'GEMINI_MODELS'],
    [{ APP_NAME: sampleSecret }, 'APP_NAME'],
    [{ AI_HISTORY_KEY: sampleSecret }, 'AI_HISTORY_KEY'],
    [{ AI_MAX_CONCURRENT: '1', AI_MAX_GUILD_CONCURRENT: '2' }, 'AI_MAX_GUILD_CONCURRENT'],
    [{ AI_STREAMING_ENABLED: 'yes' }, 'AI_STREAMING_ENABLED'],
    [{ DISCORD_LEGACY_CHANNEL_ID: channel, GEMINI_API_KEY: '' }, 'DISCORD_LEGACY_CHANNEL_ID'],
  ];
  for (const [env, field] of failures) {
    assert.throws(() => loadConfig(testEnvironment(env)), (error) =>
      error.message.startsWith(field + ' ') && !error.message.includes(sampleSecret));
  }
  const config = loadConfig(testEnvironment({ OPENAI_API_KEY: '', AI_HISTORY_MINUTES: '0' }));
  assert.deepEqual([...config.providers.keys()], ['gemini']);
  assert.equal(config.historyMs, 0);
  assert.equal(config.imageBytes, 0);
  assert.equal(config.legacyChannel, undefined);
  assert.deepEqual(config.fallback, []);
});

test('encrypted sessions and guild policy survive a reopen, clear securely, and reject a wrong key', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'discord-ai-state-test-'));
  t.after(() => {
    for (const entry of readdirSync(directory)) unlinkSync(join(directory, entry));
    rmdirSync(directory);
  });
  const config = loadConfig(testEnvironment({ AI_HISTORY_KEY: randomBytes(32).toString('base64') }));
  const scope = conversationScope(identity);
  const transcript = [{ prompt: 'unique private original', answer: 'private reply data' }];
  let store = new BotState(config, { directory });
  try {
    store.put(scope, 'gemini', modelId, transcript);
    store.setProvider(identity.guildId, 'openai', false);
    assert.equal(readFileSync(join(directory, 'conversations.sqlite')).includes(transcript[0].prompt), false);
  } finally {
    store.close();
  }
  assert.throws(() => new BotState({ ...config, historyKey: randomBytes(32) }, { directory }));
  store = new BotState(config, { directory });
  try {
    assert.deepEqual(store.get(scope, 'gemini', modelId), transcript);
    assert.equal(store.providerAllowed(identity.guildId, 'openai'), false);
    assert.equal(store.providerAllowed('somewhere else', 'openai'), true);
    store.clear(scope);
    assert.deepEqual(store.get(scope, 'gemini', modelId), []);
  } finally {
    store.close();
  }
});

test('stores evict the oldest sessions and skip history entirely when disabled', () => {
  const config = loadConfig(testEnvironment({ AI_MAX_SESSIONS: '1' }));
  let now = 5;
  const state = new BotState(config, { directory: null, now: () => now });
  const turns = [{ prompt: 'prompt', answer: 'answer' }];
  try {
    state.put('first', 'gemini', modelId, turns);
    now += 1;
    state.put('second', 'gemini', modelId, turns);
    assert.deepEqual(state.get('first', 'gemini', modelId), []);
    assert.deepEqual(state.get('second', 'gemini', modelId), turns);
    assert.deepEqual(trimTurns([...turns, ...turns], 10, 12), turns);
  } finally {
    state.close();
  }
  const off = new BotState({ ...config, historyMs: 0 }, { directory: null });
  try {
    off.put('first', 'gemini', modelId, turns);
    assert.deepEqual(off.get('first', 'gemini', modelId), []);
  } finally {
    off.close();
  }
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1i8AAAAASUVORK5CYII=', 'base64');
const fileId = '123456789000000008';
const attachment = {
  id: fileId, url: 'https://cdn.discordapp.com/attachments/' + channel + '/' + fileId + '/image.png?sig=present',
  contentType: 'image/png', size: png.length,
};
const signal = new AbortController().signal;

test('image downloader requires a Discord CDN route and never follows redirects', async () => {
  const requested = [];
  const result = await downloadImage(attachment, 1024, signal, async (url, options) => {
    requested.push([url.origin, options.redirect, options.credentials]);
    return new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
  });
  assert.deepEqual(requested, [['https://cdn.discordapp.com', 'error', 'omit']]);
  assert.deepEqual(result, { type: 'image/png', data: png.toString('base64') });
  const fetchForbidden = () => assert.fail('Unsafe attachment was fetched');
  for (const url of [
    'https://127.0.0.1/test', 'https://cdn.discordapp.com.evil.com/attachments/' + channel + '/' + fileId + '/image.png',
    'file:///etc/passwd', attachment.url.replace('cdn.', 'user@cdn.'), attachment.url.replace(fileId, channel),
    attachment.url.replace('image.png', 'image%2F.png'), attachment.url.replace('https:', 'http:'),
  ]) {
    await assert.rejects(downloadImage({ ...attachment, url }, 1024, signal, fetchForbidden), { code: 'attachment' });
  }
  await assert.rejects(downloadImage(attachment, 0, signal, fetchForbidden), { code: 'imageDisabled' });
  await assert.rejects(downloadImage(attachment, 20, signal, fetchForbidden), { code: 'attachment' });
  await assert.rejects(downloadImage(attachment, 1024, signal,
    async () => Response.redirect('https://127.0.0.1/')), { code: 'attachmentDownload' });
});

test('image downloader rejects malformed signatures, oversized dimensions, MIME mismatches and streamed overflow', async () => {
  const header = { 'content-type': 'image/png' };
  const giant = Buffer.from(png);
  giant.writeUInt32BE(5500, 16);
  giant.writeUInt32BE(5500, 20);
  for (const invalid of [Buffer.alloc(png.length), giant, Buffer.concat([png, Buffer.from('extra')]), png.subarray(0, -1)]) {
    await assert.rejects(downloadImage(attachment, 1024, signal, async () => new Response(invalid, { headers: header })), {
      code: 'attachment',
    });
  }
  await assert.rejects(downloadImage(attachment, 1024, signal, async () => new Response(png, {
    headers: { 'content-type': 'text/html' },
  })), { code: 'attachment' });
});

test('rendering removes recognized secrets, hidden controls, Discord mention markup and masked destinations', () => {
  const { clean } = createRedactor([sampleSecret]);
  const token = 'sk-' + 'z'.repeat(30);
  const googleKey = 'AIza' + 'z'.repeat(35);
  assert.equal(clean(token + ' ' + googleKey + ' ' + sampleSecret), '[redacted] [redacted] [redacted]');
  assert.equal(clean('a\u202eb\u0000c'), 'abc');
  assert.equal(visibleText('[click](https://bad.example) <@123> <#456>'), 'click ‹@123> ‹#456>');
});
