import { BotError } from '../errors.js';

export function fixedOrigin(origin, fetchImpl = globalThis.fetch) {
  return (input, options) => {
    const url = new URL(typeof input === 'object' && 'url' in input ? input.url : input);
    if (url.origin !== origin || url.username || url.password) throw new BotError('internal');
    return fetchImpl(input, { ...options, redirect: 'error' });
  };
}

export function readUsage(input, output) {
  if (![input, output].every((count) => Number.isSafeInteger(count) && count >= 0)) return undefined;
  return { input, output };
}

export function appendText(current, addition) {
  if (typeof addition !== 'string' || addition.length + current.length > 131072) {
    throw new BotError('response');
  }
  return current + addition;
}
