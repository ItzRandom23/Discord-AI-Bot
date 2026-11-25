import { GoogleGenAI } from '@google/genai';
import { BotError, providerError } from '../errors.js';
import { appendText, fixedOrigin, readUsage } from './transport.js';

const origin = 'https://generativelanguage.googleapis.com';
const blocked = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT', 'MODEL_ARMOR']);

function partsFor({ text, image }) {
  const parts = [{ text }];
  if (image) parts.push({ inlineData: { mimeType: image.type, data: image.data } });
  return parts;
}

function contentFrom(response) {
  if (!response || typeof response !== 'object') throw new BotError('response');
  const reason = response.promptFeedback?.blockReason;
  if (reason && reason !== 'BLOCK_REASON_UNSPECIFIED') throw new BotError('blocked');
  if (response.candidates !== undefined && !Array.isArray(response.candidates)) throw new BotError('response');
  const candidate = response.candidates?.[0];
  const finish = candidate?.finishReason;
  if (blocked.has(finish)) throw new BotError('blocked');
  if (finish && !['STOP', 'MAX_TOKENS', 'FINISH_REASON_UNSPECIFIED'].includes(finish)) {
    throw new BotError('response');
  }
  const parts = candidate?.content?.parts ?? [];
  if (!Array.isArray(parts)) throw new BotError('response');
  let text = '';
  for (const part of parts) {
    if (part?.thought === true) continue;
    if (part && Object.hasOwn(part, 'text')) text = appendText(text, part.text);
  }
  const usage = response.usageMetadata;
  return { text, finish, usage: readUsage(usage?.promptTokenCount, usage?.candidatesTokenCount === undefined
    ? undefined : usage.candidatesTokenCount + (usage.thoughtsTokenCount ?? 0)) };
}

function answer(text, finish, usage) {
  if (!text.trim() || !['STOP', 'MAX_TOKENS'].includes(finish)) throw new BotError('response');
  return { text, usage, truncated: finish === 'MAX_TOKENS' };
}

async function requestError(signal, operation) {
  try {
    return await operation();
  } catch (error) {
    signal?.throwIfAborted();
    let details;
    if ([400, 429].includes(error?.status) && error.message?.length < 16_384) {
      try {
        details = JSON.parse(error.message)?.error?.details;
      } catch {}
    }
    if (Array.isArray(details)) {
      if (details.some((detail) => detail?.reason === 'API_KEY_INVALID' || detail?.reason === 'API_KEY_SERVICE_BLOCKED')) {
        throw new BotError('auth');
      }
      if (error.status === 429) {
        const violations = details.find((detail) => detail?.['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure')?.violations;
        if (Array.isArray(violations) && violations.some((item) => /per.?day/i.test(item?.quotaId ?? '') || item?.quotaValue === '0')) {
          throw new BotError('quota');
        }
        const retry = details.find((detail) => detail?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo')?.retryDelay;
        if (typeof retry === 'string' && /^\d+(?:\.\d+)?s$/.test(retry)) {
          throw new BotError('providerRate', Number.parseFloat(retry) * 1000);
        }
      }
    }
    throw providerError(error, signal);
  }
}

export function createGemini(key, { fetch: fetchImpl } = {}) {
  const client = new GoogleGenAI({
    apiKey: key,
    enterprise: false,
    vertexai: false,
    httpOptions: { baseUrl: origin, retryOptions: { attempts: 1 }, fetch: fixedOrigin(origin, fetchImpl) },
  });
  return {
    async verify(model, signal) {
      const metadata = await requestError(signal, () => client.models.get({ model, config: { abortSignal: signal } }));
      if (metadata?.name !== 'models/' + model || !Array.isArray(metadata.supportedActions) ||
          !metadata.supportedActions.includes('generateContent')) {
        throw new BotError('model');
      }
      return {
        inputLimit: metadata.inputTokenLimit,
        outputLimit: metadata.outputTokenLimit,
      };
    },
    async generate({ model, messages, signal, maxOutputTokens, onText }) {
      const request = {
        model,
        contents: messages.map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: partsFor(message),
        })),
        config: { abortSignal: signal, maxOutputTokens, candidateCount: 1 },
      };
      if (!onText) {
        const response = contentFrom(await requestError(signal, () => client.models.generateContent(request)));
        return answer(response.text, response.finish, response.usage);
      }
      let text = '';
      let finish;
      let usage;
      return requestError(signal, async () => {
        for await (const chunk of await client.models.generateContentStream(request)) {
          const next = contentFrom(chunk);
          if (next.text) {
            text = appendText(text, next.text);
            onText(next.text);
          }
          if (next.finish && next.finish !== 'FINISH_REASON_UNSPECIFIED') finish = next.finish;
          usage = next.usage ?? usage;
        }
        return answer(text, finish, usage);
      });
    },
  };
}
