import OpenAI from 'openai';
import { BotError, providerError } from '../errors.js';
import { appendText, fixedOrigin, readUsage } from './transport.js';

const origin = 'https://api.openai.com';

function inputFor({ role, text, image }) {
  if (role === 'assistant') return { role, content: text };
  const content = [{ type: 'input_text', text }];
  if (image) content.push({ type: 'input_image', detail: 'auto', image_url: 'data:' + image.type + ';base64,' + image.data });
  return { role: 'user', content };
}

function parseAnswer(response, streamedText = '') {
  if (response?.status === 'failed') throw responseFailure(response.error);
  const truncated = response?.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens';
  if (response?.status === 'incomplete' && response.incomplete_details?.reason === 'content_filter') {
    throw new BotError('blocked');
  }
  if ((response?.status !== 'completed' && !truncated) || !Array.isArray(response.output)) throw new BotError('response');
  let text = '';
  for (const item of response.output) {
    if (item?.type !== 'message') continue;
    if (item.role !== 'assistant' || !Array.isArray(item.content)) throw new BotError('response');
    for (const part of item.content) {
      if (part?.type === 'refusal') throw new BotError('blocked');
      if (part?.type === 'output_text') text = appendText(text, part.text);
    }
  }
  const usage = readUsage(response.usage?.input_tokens, response.usage?.output_tokens);
  if (!text.trim() || (streamedText && text !== streamedText)) throw new BotError('response');
  return { text, usage, truncated };
}

function responseFailure(error) {
  switch (error?.code) {
    case 'server_error': return new BotError('outage');
    case 'rate_limit_exceeded': return providerError({ status: 429, code: error.code });
    case 'insufficient_quota': return new BotError('quota');
    default: return new BotError('response');
  }
}

export function createOpenAI(key, { fetch: fetchImpl } = {}) {
  const client = new OpenAI({
    apiKey: key, baseURL: origin + '/v1', maxRetries: 0, logLevel: 'off', adminAPIKey: null,
    organization: null, project: null, webhookSecret: null, fetch: fixedOrigin(origin, fetchImpl),
  });
  return {
    async verify(model, signal) {
      const metadata = await client.models.retrieve(model, { signal });
      if (metadata?.id !== model || metadata.object !== 'model') throw new BotError('model');
      return {};
    },
    async generate({ model, messages, signal, maxOutputTokens, onText }) {
      const request = {
        model, input: messages.map(inputFor), max_output_tokens: maxOutputTokens,
        store: false, stream: Boolean(onText),
      };
      const result = await client.responses.create(request, { signal });
      if (!onText) return parseAnswer(result);
      let text = '';
      let final;
      for await (const event of result) {
        if (event?.type === 'response.output_text.delta') {
          text = appendText(text, event.delta);
          if (event.delta) onText(event.delta);
        } else if (['response.completed', 'response.incomplete', 'response.failed'].includes(event?.type)) {
          if (final || !event.response) throw new BotError('response');
          final = event.response;
        } else if (event?.type === 'error') {
          throw responseFailure(event);
        } else if (event?.type === 'response.refusal.delta') {
          throw new BotError('blocked');
        }
      }
      return parseAnswer(final, text);
    },
  };
}
