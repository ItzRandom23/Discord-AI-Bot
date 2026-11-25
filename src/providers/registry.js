import { providerError } from '../errors.js';

const cacheSuccessMs = 15 * 60_000;
const cacheFailureMs = 20_000;

export class ProviderRegistry {
  constructor(settings, { signal, now = Date.now } = {}) {
    this.providers = new Map();
    this.signal = signal;
    this.now = now;
    for (const config of settings.providers.values()) {
      this.providers.set(config.id, {
        config, adapter: config.create(config.key), verification: new Map(), cooldown: undefined,
      });
    }
  }

  async verify(provider, model, signal) {
    signal?.throwIfAborted();
    const existing = provider.verification.get(model);
    if (existing?.pending || existing?.expires > this.now()) {
      return signal ? awaitWithSignal(existing.promise, signal) : existing.promise;
    }
    const entry = { pending: true };
    const timeout = AbortSignal.timeout(5000);
    const verificationSignal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
    entry.promise = Promise.resolve().then(() => provider.adapter.verify(model, verificationSignal)).catch((error) => {
      entry.failed = true;
      throw providerError(error, verificationSignal);
    }).finally(() => {
      entry.pending = false;
      entry.expires = this.now() + (entry.failed ? cacheFailureMs : cacheSuccessMs);
    });
    provider.verification.set(model, entry);
    // The request signal belongs to one chat. Avoid cancelling shared verification for other callers.
    if (!signal) return entry.promise;
    return awaitWithSignal(entry.promise, signal);
  }

  getCooldown(provider) {
    if (provider.cooldown?.until > this.now()) return provider.cooldown.error;
    return undefined;
  }

  noteFailure(provider, error) {
    if (provider.cooldown?.error === error) return;
    const delay = {
      outage: 5000, timeout: 3000, providerRate: Math.min(error.retryAfterMs ?? 3000, 300_000),
      quota: 60_000, auth: 30_000,
    }[error.code];
    const until = this.now() + (delay ?? 0);
    if (delay > 0 && (!provider.cooldown || provider.cooldown.until < until)) {
      provider.cooldown = { error, until };
    }
  }
}

async function awaitWithSignal(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
