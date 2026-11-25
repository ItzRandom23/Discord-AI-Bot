import { setTimeout as sleep } from 'node:timers/promises';
import { Admission } from './admission.js';
import { downloadImage } from './attachments.js';
import { BotError, providerError } from './errors.js';
import { visibleText } from './security.js';
import { conversationScope, trimTurns } from './state.js';

const fallbackCodes = new Set(['outage', 'timeout', 'quota', 'providerRate', 'auth']);
const maxRetryWait = 2500;

export function fitText(text, length) {
  if (length <= 0) return '';
  if (text.length <= length) return text;
  const last = text.charCodeAt(length - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
}

function promptFor(context, prompt, image) {
  return [
    ...context.flatMap(({ prompt, answer }) => [{ role: 'user', text: prompt }, { role: 'assistant', text: answer }]),
    { role: 'user', text: prompt, image },
  ];
}

function usageEstimate(prices, usage) {
  if (!prices || !usage) return undefined;
  return (prices.input * usage.input + prices.output * usage.output) / 1_000_000;
}

export class ChatService {
  constructor(config, registry, state, redactor, { signal, imageDownloader = downloadImage, admission = new Admission(config) } = {}) {
    this.config = config;
    this.registry = registry;
    this.state = state;
    this.redactor = redactor;
    this.signal = signal;
    this.imageDownloader = imageDownloader;
    this.admission = admission;
    this.activeSessions = new Map();
    this.previewGuard = Math.max(256, ...config.secrets.map((secret) => secret.length + 16));
  }

  available(guildId) {
    return [...this.registry.providers.values()]
      .filter(({ config }) => this.state.providerAllowed(guildId, config.id))
      .map(({ config }) => config);
  }

  select(guildId, providerId, modelId) {
    const provider = this.registry.providers.get(providerId ?? this.config.defaultProvider);
    if (!provider || !this.state.providerAllowed(guildId, provider.config.id)) throw new BotError('unavailable');
    const model = provider.config.models.get(modelId ?? provider.config.defaultModel);
    if (!model) throw new BotError('model');
    return { provider, model };
  }

  history(identity, providerId, modelId) {
    const { provider, model } = this.select(identity.guildId, providerId, modelId);
    return { model: model.id, label: provider.config.label,
      turns: this.state.get(conversationScope(identity), provider.config.id, model.id) };
  }

  reset(identity) {
    const scope = conversationScope(identity);
    this.state.clear(scope);
    this.activeSessions.get(scope)?.abort(new BotError('reset'));
  }

  async complete(request) {
    const { config } = this;
    const { guildId, prompt, attachment, context = true, stream, fallback, onStart, onPreview, legacy = false } = request;
    this.signal?.throwIfAborted();
    const selected = this.select(guildId, request.provider, request.model);
    if (typeof prompt !== 'string' || prompt.length > config.maxPrompt) throw new BotError('input');
    const cleaned = this.redactor.clean(prompt).trim();
    if (!cleaned) throw new BotError('input');
    if (attachment && !config.imageBytes) throw new BotError('imageDisabled');
    if (attachment && !selected.model.image) throw new BotError('image');

    const scope = conversationScope(request);
    if (this.activeSessions.has(scope)) throw new BotError('sessionBusy');
    const release = this.admission.enter(request);
    const controller = new AbortController();
    this.activeSessions.set(scope, controller);
    const deadline = AbortSignal.timeout(config.timeoutMs);
    const signal = AbortSignal.any([controller.signal, deadline, ...(this.signal ? [this.signal] : [])]);
    const canRemember = !legacy && context && config.historyMs > 0;
    let stop;
    try {
      stop = onStart?.();
      const image = attachment && await this.imageDownloader(attachment, config.imageBytes, signal);
      const alternatives = fallback && !image && !legacy
        ? config.fallback.filter((id) => id !== selected.provider.config.id)
        : [];
      const targets = [selected, ...alternatives.map((id) => {
        const provider = this.registry.providers.get(id);
        return { provider, model: provider.config.models.get(provider.config.defaultModel) };
      })];
      let lastError;
      for (const [index, { provider, model }] of targets.entries()) {
        const id = provider.config.id;
        signal.throwIfAborted();
        if (!this.state.providerAllowed(guildId, id)) {
          if (index > 0) continue;
          throw new BotError('unavailable');
        }
        let sawText = false;
        let pendingPreview = '';
        const onText = (stream ?? config.streaming) && config.streaming && model.streaming && onPreview
          ? (delta) => {
              sawText = true;
              pendingPreview += delta;
              if (pendingPreview.length <= this.previewGuard) return;
              const sanitized = this.redactor.clean(pendingPreview);
              const tail = Math.min(sanitized.length, this.previewGuard);
              const preview = fitText(visibleText(fitText(sanitized, sanitized.length - tail)), 1800).trim();
              if (preview && !signal.aborted) onPreview(preview);
            }
          : undefined;
        try {
          const { turns, result } = await this.generate({
            guildId, provider, model, scope, cleaned, image, canRemember: canRemember && index === 0,
            signal, onText, hasStreamed: () => sawText,
          });
          signal.throwIfAborted();
          const sanitized = visibleText(this.redactor.clean(result.text)).trim();
          const text = fitText(sanitized, config.maxOutput).trim();
          if (!text) throw new BotError('response');
          if (canRemember && index === 0) {
            const savedPrompt = fitText(cleaned, config.maxContext - 32);
            const savedAnswer = fitText(text, config.maxContext - savedPrompt.length);
            const retained = trimTurns([...turns, { prompt: savedPrompt, answer: savedAnswer }], config.historyTurns, config.maxContext);
            this.state.put(scope, id, model.id, retained);
          }
          return {
            text, model: model.id, label: provider.config.label, fallback: index > 0, usage: result.usage,
            truncated: result.truncated || sanitized.length > config.maxOutput,
            cost: usageEstimate(model.prices, result.usage),
          };
        } catch (error) {
          const safe = providerError(error, signal);
          if (!signal.aborted) this.registry.noteFailure(provider, safe);
          if (!fallbackCodes.has(safe.code) || signal.aborted || sawText) throw safe;
          lastError = safe;
        }
      }
      throw lastError ?? new BotError('unavailable');
    } catch (error) {
      throw signal.aborted ? providerError(error, signal) : error;
    } finally {
      this.activeSessions.delete(scope);
      release();
      stop?.();
    }
  }

  async generate({ guildId, provider, model, scope, cleaned, image, canRemember, signal, onText, hasStreamed }) {
    const cooldown = this.registry.getCooldown(provider);
    if (cooldown) throw cooldown;
    const metadata = await this.registry.verify(provider, model.id, signal);
    const maxBytes = Number.isSafeInteger(metadata.inputLimit) ? Math.max(metadata.inputLimit - 256, 0) : Infinity;
    if (Buffer.byteLength(cleaned) > maxBytes) throw new BotError('input');
    const stored = canRemember ? this.state.get(scope, provider.config.id, model.id) : [];
    let turns = trimTurns(stored, this.config.historyTurns, this.config.maxContext - cleaned.length);
    while (turns.length && turns.reduce((bytes, turn) => bytes + Buffer.byteLength(turn.prompt) + Buffer.byteLength(turn.answer), Buffer.byteLength(cleaned)) > maxBytes) {
      turns = turns.slice(1);
    }
    const maxOutputTokens = Number.isSafeInteger(metadata.outputLimit) && metadata.outputLimit > 0
      ? Math.min(this.config.maxOutputTokens, metadata.outputLimit)
      : this.config.maxOutputTokens;
    const messages = promptFor(turns, cleaned, image);
    for (let attempt = 0;; attempt++) {
      signal.throwIfAborted();
      if (!this.state.providerAllowed(guildId, provider.config.id)) throw new BotError('unavailable');
      try {
        const result = await provider.adapter.generate({ model: model.id, messages, signal, maxOutputTokens, onText });
        return { turns, result };
      } catch (error) {
        const safe = providerError(error, signal);
        const wait = Math.max(safe.retryAfterMs ?? 500, 250);
        if (safe.code !== 'providerRate' || attempt >= this.config.retries || wait > maxRetryWait || hasStreamed()) {
          throw safe;
        }
        await sleep(wait + Math.floor(Math.random() * 100), undefined, { signal });
      }
    }
  }
}
