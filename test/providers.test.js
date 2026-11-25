import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGemini } from '../src/providers/gemini.js';
import { createOpenAI } from '../src/providers/openai.js';
import { modelId, sampleSecret } from './helpers.js';

function sse(events, openai = false) {
  return new Response(events.map((event) => (openai ? 'event: ' + event.type + '\n' : '') +
    'data: ' + JSON.stringify(event) + '\n\n').join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

const geminiModel = {
  name: 'models/' + modelId, inputTokenLimit: 120000, outputTokenLimit: 4000,
  supportedGenerationMethods: ['generateContent'],
};
const image = { type: 'image/png', data: 'AA==' };
const messages = [
  { role: 'user', text: 'first question' },
  { role: 'assistant', text: 'first answer' },
  { role: 'user', text: 'current question', image },
];
const signal = new AbortController().signal;
const generation = { model: modelId, messages, signal, maxOutputTokens: 750 };

function geminiChunk(text, finishReason, usageMetadata) {
  return {
    candidates: [{ content: { role: 'model', parts: [{ text: 'internal thinking', thought: true }, { text }] }, finishReason }],
    usageMetadata,
  };
}
const geminiUsage = { promptTokenCount: 27, candidatesTokenCount: 8, thoughtsTokenCount: 2 };

test('Gemini SDK uses the developer API with inline images, ordered roles, and usage', async () => {
  const requests = [];
  const gemini = createGemini(sampleSecret, { fetch: async (input, options) => {
    const request = new Request(input, options);
    requests.push(request);
    return Response.json(request.method === 'GET' ? geminiModel : geminiChunk('A Gemini reply', 'STOP', geminiUsage));
  } });
  assert.deepEqual(await gemini.verify(modelId, signal), { inputLimit: 120000, outputLimit: 4000 });
  assert.deepEqual(await gemini.generate(generation), {
    text: 'A Gemini reply', usage: { input: 27, output: 10 }, truncated: false,
  });
  assert.equal(new URL(requests[0].url).origin, 'https://generativelanguage.googleapis.com');
  assert.match(requests[0].url, /\/models\/example-chat$/);
  assert.match(requests[1].url, /:generateContent$/);
  assert.equal(requests[1].headers.get('x-goog-api-key'), sampleSecret);
  assert.equal(requests[1].redirect, 'error');
  const body = await requests[1].json();
  assert.deepEqual(body.contents.map((item) => item.role), ['user', 'model', 'user']);
  assert.deepEqual(body.contents[2].parts[1], { inlineData: { mimeType: image.type, data: image.data } });
  assert.equal(body.generationConfig.maxOutputTokens, 750);
  assert.equal(body.tools, undefined);
});

test('Gemini SDK parses a real-shaped SSE contract and rejects blocked or unterminated responses', async () => {
  const deltas = [];
  let chunks = [geminiChunk('one'), geminiChunk(' two', 'MAX_TOKENS', geminiUsage)];
  const gemini = createGemini(sampleSecret, { fetch: async (input) => {
    assert.match(String(input), /:streamGenerateContent\?alt=sse$/);
    return sse(chunks);
  } });
  const request = { ...generation, onText: (value) => deltas.push(value) };
  assert.deepEqual(await gemini.generate(request), { text: 'one two', usage: { input: 27, output: 10 }, truncated: true });
  assert.deepEqual(deltas, ['one', ' two']);
  chunks = [geminiChunk('partial')];
  await assert.rejects(gemini.generate(request), { code: 'response' });
  chunks = [{ promptFeedback: { blockReason: 'SAFETY' } }];
  await assert.rejects(gemini.generate(request), { code: 'blocked' });
});

test('Gemini rejects incompatible metadata and classifies quota and invalid keys without raw details', async () => {
  let body = { ...geminiModel, supportedGenerationMethods: ['embedContent'] };
  let status = 200;
  let requests = 0;
  const gemini = createGemini(sampleSecret, { fetch: async () => {
    requests += 1;
    return Response.json(body, { status });
  } });
  await assert.rejects(gemini.verify(modelId, signal), { code: 'model' });
  status = 429;
  body = { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '8.7s' }] } };
  await assert.rejects(gemini.generate(generation), { code: 'providerRate', retryAfterMs: 8700 });
  body = { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'FreeRequestsPerDay' }] }] } };
  await assert.rejects(gemini.generate(generation), { code: 'quota' });
  status = 400;
  body = { error: { message: sampleSecret, details: [{ reason: 'API_KEY_INVALID' }] } };
  await assert.rejects(gemini.generate(generation), (error) => error.code === 'auth' && !error.message.includes(sampleSecret));
  assert.equal(requests, 4);
});

function openaiResponse(text, extra = {}) {
  return {
    id: 'resp_example', object: 'response', status: 'completed',
    output: [{ type: 'reasoning' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 20, output_tokens: 6 },
    ...extra,
  };
}

test('OpenAI SDK sends a non-stored Responses API request on the official origin', async () => {
  const requests = [];
  const openai = createOpenAI(sampleSecret, { fetch: async (input, options) => {
    const request = new Request(input, options);
    requests.push(request);
    return Response.json(request.method === 'GET' ? { id: modelId, object: 'model' } : openaiResponse('An OpenAI reply'));
  } });
  assert.deepEqual(await openai.verify(modelId, signal), {});
  assert.deepEqual(await openai.generate(generation), { text: 'An OpenAI reply', usage: { input: 20, output: 6 }, truncated: false });
  assert.equal(requests[0].url, 'https://api.openai.com/v1/models/' + modelId);
  assert.equal(requests[1].url, 'https://api.openai.com/v1/responses');
  assert.equal(requests[1].headers.get('authorization'), 'Bearer ' + sampleSecret);
  assert.equal(requests[1].redirect, 'error');
  const body = await requests[1].json();
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 750);
  assert.deepEqual(body.input.slice(0, 2), [
    { role: 'user', content: [{ type: 'input_text', text: 'first question' }] },
    { role: 'assistant', content: 'first answer' },
  ]);
  assert.deepEqual(body.input[2].content[1], { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,AA==' });
  assert.equal(body.tools, undefined);
});

test('OpenAI SDK checks terminal SSE events, refusals, and malformed output', async () => {
  const deltas = [];
  const delta = { type: 'response.output_text.delta', delta: 'first' };
  const finish = { type: 'response.completed', response: openaiResponse('first') };
  let events = [delta, finish];
  const openai = createOpenAI(sampleSecret, { fetch: async (input, options) => {
    assert.equal((await new Request(input, options).json()).stream, true);
    return sse(events, true);
  } });
  const request = { ...generation, onText: (text) => deltas.push(text) };
  assert.equal((await openai.generate(request)).text, 'first');
  assert.deepEqual(deltas, ['first']);
  events = [delta];
  await assert.rejects(openai.generate(request), { code: 'response' });
  events = [delta, { ...finish, response: openaiResponse('different text') }];
  await assert.rejects(openai.generate(request), { code: 'response' });
  events = [{ type: 'response.incomplete', response: openaiResponse('partly done', {
    status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
  }) }];
  assert.equal((await openai.generate(request)).truncated, true);
  events = [{ type: 'response.refusal.delta', delta: 'refused' }];
  await assert.rejects(openai.generate(request), { code: 'blocked' });
});

test('OpenAI SDK does not retry HTTP failures and rejects invalid model metadata', async () => {
  let requests = 0;
  const openai = createOpenAI(sampleSecret, { fetch: async (input, options) => {
    requests += 1;
    const request = new Request(input, options);
    if (request.method === 'GET') return Response.json({ id: 'different-model', object: 'model' });
    return Response.json({ error: { code: 'insufficient_quota', message: sampleSecret } }, { status: 429 });
  } });
  await assert.rejects(openai.verify(modelId, signal), { code: 'model' });
  let caught;
  try {
    await openai.generate(generation);
  } catch (error) {
    caught = error;
  }
  assert.equal(caught?.status, 429);
  assert.equal(requests, 2);
});
