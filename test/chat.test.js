import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Admission, EventDeduplication } from '../src/admission.js';
import { BotError } from '../src/errors.js';
import { fixture, identity, modelId, sampleSecret } from './helpers.js';

test('history ordering is correct and isolates users, channels, guilds, DMs, and providers', async (t) => {
  const { chat, calls, verifications } = fixture(t, { AI_USER_REQUESTS: '20' });
  await chat.complete({ ...identity, prompt: 'first' });
  await chat.complete({ ...identity, prompt: 'second' });
  assert.deepEqual(calls[1].messages.map(({ role, text }) => [role, text]), [
    ['user', 'first'], ['assistant', 'a reply from gemini'], ['user', 'second'],
  ]);
  const unrelated = [
    { userId: '123456789000000017' }, { channelId: '123456789000000018' },
    { guildId: '123456789000000019' }, { guildId: null }, { provider: 'openai' },
    { context: false }, { legacy: true },
  ];
  for (const change of unrelated) {
    await chat.complete({ ...identity, ...change, prompt: 'isolated' });
    assert.equal(calls.at(-1).messages.length, 1);
  }
  assert.deepEqual(chat.history(identity).turns.map((turn) => turn.prompt), ['first', 'second']);
  assert.deepEqual(verifications.map(({ id }) => id), ['gemini', 'openai']);
});

test('history trims whole turns, expires at the configured TTL, and never saves image bytes', async (t) => {
  const { chat, clock, calls } = fixture(t, { AI_HISTORY_TURNS: '1', AI_MAX_IMAGE_KIB: '100', AI_HISTORY_MINUTES: '1' });
  chat.imageDownloader = async () => ({ type: 'image/png', data: 'rawImageBytes' });
  await chat.complete({ ...identity, prompt: 'first' });
  await chat.complete({ ...identity, prompt: 'image prompt', attachment: {} });
  assert.ok(calls.at(-1).messages.at(-1).image);
  assert.deepEqual(chat.history(identity).turns, [{ prompt: 'image prompt', answer: 'a reply from gemini' }]);
  clock.time += 60000;
  assert.deepEqual(chat.history(identity).turns, []);
  await chat.complete({ ...identity, prompt: 'after expiry' });
  assert.equal(calls.at(-1).messages.length, 1);
});

test('reset aborts an active turn and frees its session without restoring erased history', async (t) => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let hold = false;
  const { chat, calls } = fixture(t, {}, {
    gemini: { generate: async ({ signal }) => {
      if (!hold) return { text: 'first answer' };
      started();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } },
  });
  await chat.complete({ ...identity, prompt: 'first' });
  hold = true;
  const inFlight = chat.complete({ ...identity, prompt: 'second' });
  await ready;
  await assert.rejects(chat.complete({ ...identity, prompt: 'duplicate' }), { code: 'sessionBusy' });
  chat.reset(identity);
  await assert.rejects(inFlight, { code: 'reset' });
  assert.deepEqual(chat.history(identity).turns, []);
  hold = false;
  await chat.complete({ ...identity, prompt: 'fresh' });
  assert.equal(calls.at(-1).messages.length, 1);
});

test('a long saved reply replaces stale history when it fills the context budget', async (t) => {
  let text = 'short reply';
  const { chat } = fixture(t, { AI_MAX_PROMPT_CHARS: '64', AI_MAX_CONTEXT_CHARS: '80' }, {
    gemini: { generate: async () => ({ text }) },
  });
  await chat.complete({ ...identity, prompt: 'old turn' });
  text = 'a'.repeat(200);
  const result = await chat.complete({ ...identity, prompt: 'new turn' });
  assert.equal(result.text.length, 200);
  const saved = chat.history(identity).turns;
  assert.deepEqual(saved, [{ prompt: 'new turn', answer: 'a'.repeat(72) }]);
});

test('guild bans and unconfigured model IDs prevent requests from reaching the provider', async (t) => {
  const { chat, state, calls, verifications } = fixture(t);
  state.setProvider(identity.guildId, 'gemini', false);
  await assert.rejects(chat.complete({ ...identity, prompt: 'hello' }), { code: 'unavailable' });
  await assert.rejects(chat.complete({ ...identity, prompt: 'hello', provider: 'openai', model: 'unknown-id' }), { code: 'model' });
  assert.equal(verifications.length, 0);
  assert.equal(calls.length, 0);
  await chat.complete({ ...identity, prompt: 'hello', provider: 'openai' });
  assert.equal(calls[0].id, 'openai');
});

test('fallback requires per-request consent and sends only the current text', async (t) => {
  let healthy = true;
  const { chat, state, calls, clock } = fixture(t, { AI_FALLBACK_PROVIDERS: 'openai' }, {
    gemini: { generate: async () => {
      if (!healthy) throw new BotError('outage');
      return { text: 'initial answer' };
    } },
  });
  await chat.complete({ ...identity, prompt: 'previous private prompt' });
  healthy = false;
  await assert.rejects(chat.complete({ ...identity, prompt: 'keep private' }), { code: 'outage' });
  assert.deepEqual(calls.map(({ id }) => id), ['gemini', 'gemini']);
  const result = await chat.complete({ ...identity, prompt: 'allow another provider', fallback: true });
  assert.equal(result.fallback, true);
  assert.equal(result.label, 'OpenAI');
  assert.equal(result.cost, 0.00004);
  assert.deepEqual(calls.at(-1).messages.map(({ text }) => text), ['allow another provider']);
  assert.deepEqual(chat.history(identity, 'openai').turns, []);
  state.setProvider(identity.guildId, 'openai', false);
  clock.time += 5000;
  await assert.rejects(chat.complete({ ...identity, prompt: 'fallback blocked here', fallback: true }), { code: 'outage' });
  assert.equal(calls.filter(({ id }) => id === 'openai').length, 1);
});

test('requests with images and partial streams never fall back', async (t) => {
  const { chat, calls, clock } = fixture(t, {
    AI_FALLBACK_PROVIDERS: 'openai', AI_MAX_IMAGE_KIB: '100', AI_STREAMING_ENABLED: 'true',
  }, {
    gemini: { generate: async ({ onText }) => {
      onText?.('raw partial response');
      throw new BotError('outage');
    } },
  });
  chat.imageDownloader = async () => ({ type: 'image/png', data: 'bytes' });
  await assert.rejects(chat.complete({ ...identity, prompt: 'image', attachment: {}, fallback: true }), { code: 'outage' });
  clock.time += 5000;
  await assert.rejects(chat.complete({ ...identity, prompt: 'stream', fallback: true, onPreview: () => {} }), { code: 'outage' });
  assert.deepEqual(calls.map(({ id }) => id), ['gemini', 'gemini']);
});

test('secret values are removed from upstream prompts, streaming drafts, stored turns, and final text', async (t) => {
  const drafts = [];
  const { chat, calls } = fixture(t, { AI_STREAMING_ENABLED: 'true' }, {
    gemini: { generate: async ({ onText }) => {
      const start = 'start '.repeat(100);
      const end = ' end'.repeat(90);
      onText(start + sampleSecret.slice(0, 12));
      onText(sampleSecret.slice(12) + end);
      return { text: start + sampleSecret + end };
    } },
  });
  const result = await chat.complete({
    ...identity, prompt: 'do not share ' + sampleSecret, onPreview: (draft) => drafts.push(draft),
  });
  assert.ok(drafts.length > 0);
  for (const value of [...drafts, result.text, calls[0].messages[0].text, JSON.stringify(chat.history(identity).turns)]) {
    assert.equal(value.includes(sampleSecret.slice(0, 12)), false);
  }
  assert.match(result.text, /\[redacted\]/);
});

test('explicit short 429 is retried once, long Retry-After and timeouts are bounded', async (t) => {
  let fail = 'short';
  let attempts = 0;
  const { chat, clock } = fixture(t, { AI_TIMEOUT_MS: '1000' }, {
    gemini: { generate: async ({ signal }) => {
      attempts += 1;
      if (fail === 'short' && attempts === 1) throw new BotError('providerRate', 20);
      if (fail === 'long') throw new BotError('providerRate', 20000);
      if (fail === 'timeout') {
        return new Promise((_, reject) => {
          const keepAlive = setTimeout(() => reject(new Error('test timeout did not reach the provider')), 2000);
          signal.addEventListener('abort', () => {
            clearTimeout(keepAlive);
            reject(signal.reason);
          }, { once: true });
        });
      }
      return { text: 'ok' };
    } },
  });
  assert.equal((await chat.complete({ ...identity, prompt: 'retry' })).text, 'ok');
  assert.equal(attempts, 2);
  fail = 'long';
  await assert.rejects(chat.complete({ ...identity, prompt: 'no wait' }), { code: 'providerRate' });
  assert.equal(attempts, 3);
  clock.time += 20000;
  fail = 'timeout';
  await assert.rejects(chat.complete({ ...identity, prompt: 'deadline' }), { code: 'timeout' });
  assert.equal(attempts, 4);
});

test('admission enforces per-user, guild, global, and concurrent limits; duplicate events expire', () => {
  let time = 1000;
  const now = () => time;
  const control = new Admission({
    concurrency: 3, guildConcurrency: 1, userRate: 1, guildRate: 2, globalRate: 3, rateWindowMs: 1000,
  }, { now });
  const first = control.enter(identity);
  assert.throws(() => control.enter({ ...identity, userId: 'B' }), { code: 'busy' });
  first();
  assert.throws(() => control.enter({ ...identity, guildId: 'another' }), { code: 'rate' });
  control.enter({ ...identity, userId: 'B' })();
  assert.throws(() => control.enter({ ...identity, userId: 'C' }), { code: 'rate' });
  control.enter({ ...identity, guildId: 'another', userId: 'C' })();
  assert.throws(() => control.enter({ ...identity, guildId: 'third', userId: 'D' }), { code: 'rate' });
  time += 1000;
  control.enter(identity)();

  const dedupe = new EventDeduplication({ now, limit: 2, lifetimeMs: 10 });
  assert.equal(dedupe.accept('A'), true);
  assert.equal(dedupe.accept('A'), false);
  assert.equal(dedupe.accept('B'), true);
  assert.equal(dedupe.accept('C'), false);
  time += 10;
  assert.equal(dedupe.accept('A'), true);
});

test('verification is coalesced, cancellation remains per request, and caching refreshes', async (t) => {
  let finish;
  const waiting = new Promise((resolve) => { finish = resolve; });
  let started;
  const verifying = new Promise((resolve) => { started = resolve; });
  const { chat, calls, verifications, clock } = fixture(t, {}, {
    gemini: { verify: async () => { started(); return waiting; } },
  });
  const first = chat.complete({ ...identity, prompt: 'one' });
  await verifying;
  const second = chat.complete({ ...identity, userId: 'different', prompt: 'two' });
  chat.reset(identity);
  await assert.rejects(first, { code: 'reset' });
  finish({ inputLimit: 9999, outputLimit: 500 });
  await second;
  assert.equal(verifications.length, 1);
  assert.equal(calls[0].maxOutputTokens, 500);
  clock.time += 15 * 60_000;
  await chat.complete({ ...identity, prompt: 'verify again', model: modelId });
  assert.equal(verifications.length, 2);
});
