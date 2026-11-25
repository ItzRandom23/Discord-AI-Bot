export const messages = Object.freeze({
  attachment: 'Upload a valid PNG, JPEG, or WebP image within the configured size limit.',
  attachmentDownload: 'Discord could not provide this attachment. Upload it again and retry.',
  unavailable: 'That provider is unavailable here. Run /ai settings to see the enabled providers.',
  model: 'That model is unavailable for this provider. Choose another model from /ai models.',
  image: 'That model does not accept image input. Choose an image-capable model from /ai models.',
  imageDisabled: 'This bot has image input disabled.',
  input: 'Enter a prompt within the configured length limit.',
  rate: 'You or this server reached the request limit. Wait a short while before trying again.',
  busy: 'The bot is at capacity. Try again shortly.',
  sessionBusy: 'A request is already running in this conversation. Wait for it or use /ai reset.',
  timeout: 'The AI request timed out. Try again later or choose a different provider.',
  quota: 'The provider quota or billing limit was reached. Ask the bot operator to check the API account.',
  providerRate: 'The provider reached a rate or quota limit. Wait before trying again, or ask the bot operator to check usage.',
  outage: 'The provider is temporarily unavailable. Try again later or choose a different provider.',
  auth: 'The provider rejected the bot’s credentials. Ask the bot operator to verify the key and account access.',
  rejected: 'The provider rejected this request. Check the model settings or try a shorter prompt.',
  blocked: 'The provider did not return an answer to this request.',
  response: 'The provider returned an incomplete or invalid response. Try again later.',
  reset: 'The conversation was cleared. This request was cancelled.',
  stopped: 'The bot is shutting down. Try again once it is back online.',
  permission: 'Manage Server permission is required for this command.',
  channelPermission: 'The bot needs View Channel permission to chat here.',
  buttonOwner: 'Only the person who opened this history can use its reset button.',
  internal: 'The bot could not complete this request. Try again later.',
});

export class BotError extends Error {
  constructor(code, retryAfterMs) {
    const safeCode = Object.hasOwn(messages, code) ? code : 'internal';
    super(messages[safeCode]);
    this.code = safeCode;
    this.retryAfterMs = retryAfterMs;
  }
}

export function publicError(error) {
  return error instanceof BotError ? error : new BotError('internal');
}

export function providerError(error, signal) {
  if (signal?.aborted) return signal.reason instanceof BotError ? signal.reason : new BotError('timeout');
  if (error instanceof BotError) return error;
  const status = Number(error?.status);
  const code = error?.code ?? error?.error?.code;
  if (status === 401 || status === 403) return new BotError('auth');
  if (status === 404 || code === 'model_not_found') return new BotError('model');
  if (status === 429) {
    if (['insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active'].includes(code)) {
      return new BotError('quota');
    }
    const header = error?.headers?.get?.('retry-after');
    const seconds = typeof header === 'string' && header.trim() !== '' ? Number(header) : NaN;
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    return new BotError('providerRate', Number.isFinite(delay) ? Math.max(0, delay) : undefined);
  }
  if (status === 408 || error?.name === 'APIConnectionTimeoutError') return new BotError('timeout');
  if ((status >= 500 && status <= 599) || error?.name === 'APIConnectionError' || error instanceof TypeError) {
    return new BotError('outage');
  }
  if (status >= 400 && status <= 499) return new BotError('rejected');
  return new BotError('response');
}
