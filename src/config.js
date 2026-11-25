import { resolve } from 'node:path';
import { providerDefinitions } from './providers/index.js';
import { createRedactor } from './security.js';

const snowflake = /^\d{17,20}$/;
const modelId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
export const validDiscordId = (value) => typeof value === 'string' && snowflake.test(value);

export class ConfigError extends Error {
  constructor(field, rule) {
    super(field + ' ' + rule);
  }
}

function read(env, field) {
  return env[field]?.trim() || undefined;
}

function id(env, field, required) {
  const value = read(env, field);
  if ((required || value) && !validDiscordId(value)) throw new ConfigError(field, 'must be a Discord ID.');
  return value;
}

function secret(env, field, required = false) {
  const value = read(env, field);
  if ((required || value) && (!value || value.length < 12 || value.length > 512 || /\s/.test(value))) {
    throw new ConfigError(field, 'must be a valid credential.');
  }
  return value;
}

function number(env, field, fallback, min, max) {
  const value = read(env, field) ?? String(fallback);
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(field, 'must be an integer from ' + min + ' to ' + max + '.');
  }
  return parsed;
}

function flag(env, field, fallback = false) {
  const value = read(env, field) ?? String(fallback);
  if (!['true', 'false'].includes(value)) throw new ConfigError(field, 'must be true or false.');
  return value === 'true';
}

function catalog(env, prefix) {
  const field = prefix + '_MODELS';
  let entries;
  try {
    entries = JSON.parse(read(env, field) ?? 'null');
  } catch {
    throw new ConfigError(field, 'must be a JSON array of model entries.');
  }
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 10) {
    throw new ConfigError(field, 'must contain 1–10 configured chat models.');
  }
  const models = new Map();
  const allowed = new Set(['id', 'image', 'streaming', 'inputUsdPerMillion', 'outputUsdPerMillion']);
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !Object.hasOwn(entry, 'id') ||
        typeof entry.id !== 'string' || !modelId.test(entry.id) || models.has(entry.id) ||
        Object.keys(entry).some((key) => !allowed.has(key)) ||
        ['image', 'streaming'].some((key) => Object.hasOwn(entry, key) && typeof entry[key] !== 'boolean')) {
      throw new ConfigError(field, 'contains an invalid or duplicate model entry.');
    }
    const { inputUsdPerMillion: input, outputUsdPerMillion: output } = entry;
    if ((input !== undefined || output !== undefined) &&
        ![input, output].every((price) => Number.isFinite(price) && price >= 0 && price <= 10000)) {
      throw new ConfigError(field, 'requires both finite input and output prices when pricing is configured.');
    }
    models.set(entry.id, {
      id: entry.id, image: entry.image === true, streaming: entry.streaming === true,
      prices: input === undefined ? undefined : { input, output },
    });
  }
  return models;
}

export function discordConfig(env = process.env, { registration = false } = {}) {
  return {
    token: secret(env, 'DISCORD_TOKEN', true),
    applicationId: id(env, 'DISCORD_APPLICATION_ID', registration),
    commandGuildId: id(env, 'DISCORD_COMMAND_GUILD_ID', false),
  };
}

export function loadConfig(env = process.env, { requireDiscord = true, definitions = providerDefinitions } = {}) {
  const discord = requireDiscord ? discordConfig(env) : undefined;
  const providers = new Map();
  for (const definition of definitions) {
    const prefix = definition.id.toUpperCase();
    const key = secret(env, prefix + '_API_KEY');
    if (!key) continue;
    const models = catalog(env, prefix);
    const defaultModel = read(env, prefix + '_DEFAULT_MODEL') ?? models.keys().next().value;
    if (!models.has(defaultModel)) throw new ConfigError(prefix + '_DEFAULT_MODEL', 'must appear in its model catalog.');
    providers.set(definition.id, { ...definition, key, models, defaultModel });
  }

  const defaultProvider = read(env, 'AI_DEFAULT_PROVIDER') ?? providers.keys().next().value;
  if (!providers.has(defaultProvider)) throw new ConfigError('AI_DEFAULT_PROVIDER', 'must identify a configured provider with a key and model catalog.');
  const fallback = (read(env, 'AI_FALLBACK_PROVIDERS') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (new Set(fallback).size !== fallback.length || fallback.some((value) => !providers.has(value))) {
    throw new ConfigError('AI_FALLBACK_PROVIDERS', 'must contain distinct configured provider IDs.');
  }

  const historyMinutes = number(env, 'AI_HISTORY_MINUTES', 60, 0, 1440);
  const storedKey = read(env, 'AI_HISTORY_KEY');
  let historyKey;
  if (storedKey) {
    if (historyMinutes === 0 || !/^[A-Za-z0-9+/]{43}=$/.test(storedKey) ||
        Buffer.from(storedKey, 'base64').toString('base64') !== storedKey) {
      throw new ConfigError('AI_HISTORY_KEY', 'requires enabled retention and a base64-encoded 32-byte key.');
    }
    historyKey = Buffer.from(storedKey, 'base64');
  }

  const applicationName = read(env, 'APP_NAME') ?? 'Discord AI';
  const secrets = [discord?.token, storedKey, ...Array.from(providers.values(), ({ key }) => key)].filter(Boolean);
  const { clean } = createRedactor(secrets);
  if (!/^[\p{L}\p{N} ._-]{1,50}$/u.test(applicationName) || clean(applicationName) !== applicationName) {
    throw new ConfigError('APP_NAME', 'must be 1–50 letters, numbers, spaces, or ._- characters.');
  }
  for (const { id, models } of providers.values()) {
    if ([...models.keys()].some((model) => clean(model) !== model)) {
      throw new ConfigError(id.toUpperCase() + '_MODELS', 'contains a credential-like model ID.');
    }
  }
  const maxPrompt = number(env, 'AI_MAX_PROMPT_CHARS', 2000, 64, 4000);
  const concurrency = number(env, 'AI_MAX_CONCURRENT', 8, 1, 64);
  const legacyChannel = id(env, 'DISCORD_LEGACY_CHANNEL_ID', false);
  if (legacyChannel && !providers.has('gemini')) {
    throw new ConfigError('DISCORD_LEGACY_CHANNEL_ID', 'requires a configured Gemini provider.');
  }
  return {
    ...discord, applicationName, providers, defaultProvider, fallback, legacyChannel,
    stateDirectory: resolve(read(env, 'AI_STATE_DIR') ?? '.bot-data'),
    secrets,
    historyKey,
    historyMs: historyMinutes * 60_000,
    historyTurns: number(env, 'AI_HISTORY_TURNS', 6, 1, 30),
    maxSessions: number(env, 'AI_MAX_SESSIONS', 1500, 1, 20000),
    maxContext: number(env, 'AI_MAX_CONTEXT_CHARS', 12000, maxPrompt, 64000),
    maxPrompt,
    maxOutput: number(env, 'AI_MAX_OUTPUT_CHARS', 8000, 500, 16000),
    maxOutputTokens: number(env, 'AI_MAX_OUTPUT_TOKENS', 2048, 256, 8192),
    imageBytes: number(env, 'AI_MAX_IMAGE_KIB', 0, 0, 8192) * 1024,
    streaming: flag(env, 'AI_STREAMING_ENABLED'),
    timeoutMs: number(env, 'AI_TIMEOUT_MS', 45000, 1000, 120000),
    retries: number(env, 'AI_RATE_LIMIT_RETRIES', 1, 0, 1),
    rateWindowMs: number(env, 'AI_RATE_WINDOW_MS', 60000, 1000, 300000),
    userRate: number(env, 'AI_USER_REQUESTS', 4, 1, 100),
    guildRate: number(env, 'AI_GUILD_REQUESTS', 30, 1, 1000),
    globalRate: number(env, 'AI_GLOBAL_REQUESTS', 120, 1, 10000),
    concurrency,
    guildConcurrency: number(env, 'AI_MAX_GUILD_CONCURRENT', Math.min(2, concurrency), 1, concurrency),
  };
}
