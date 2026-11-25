import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function privateDatabase(directory, name) {
  if (!directory) return new DatabaseSync(':memory:');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error('State directory must be a regular directory.');
  const path = join(directory, name);
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('State file must be a regular non-linked file.');
  if (process.platform !== 'win32') chmodSync(path, 0o600);
  return new DatabaseSync(path);
}

function seal(key, text, aad) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]);
}

function unseal(key, bytes, aad) {
  const buffer = Buffer.from(bytes);
  const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(12, 28));
  decipher.setAAD(Buffer.from(aad));
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString();
}

export function conversationScope({ guildId, channelId, userId }) {
  return [guildId ?? 'dm', channelId, userId].join(':');
}

export class BotState {
  constructor(config, { directory = config.stateDirectory, now = Date.now } = {}) {
    this.config = config;
    this.now = now;
    this.policy = privateDatabase(directory, 'settings.sqlite');
    try {
      this.policy.exec('PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF;');
      this.policy.exec('CREATE TABLE IF NOT EXISTS policy (guild TEXT, provider TEXT, enabled INTEGER CHECK(enabled IN (0, 1)), PRIMARY KEY(guild, provider)) STRICT;');
      this.memory = privateDatabase(config.historyKey ? directory : null, 'conversations.sqlite');
      this.memory.exec('PRAGMA busy_timeout=1000; PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON;');
      this.memory.exec([
        'CREATE TABLE IF NOT EXISTS history (scope TEXT, provider TEXT, model TEXT, updated INTEGER NOT NULL, turns BLOB NOT NULL, PRIMARY KEY(scope, provider, model)) STRICT;',
        'CREATE INDEX IF NOT EXISTS history_updated ON history(updated);',
        'CREATE TABLE IF NOT EXISTS history_key (id INTEGER PRIMARY KEY CHECK(id=1), verifier BLOB NOT NULL) STRICT;',
      ].join('\n'));
      if (config.historyKey) {
        const verifier = this.memory.prepare('SELECT verifier FROM history_key WHERE id=1').get()?.verifier;
        if (!verifier) {
          this.memory.prepare('INSERT INTO history_key VALUES (1, ?)').run(seal(config.historyKey, 'v1', 'history-key'));
        } else if (unseal(config.historyKey, verifier, 'history-key') !== 'v1') {
          throw new Error('Invalid conversation key.');
        }
      }
      this.sweep();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  providerAllowed(guildId, provider) {
    if (!guildId) return true;
    return this.policy.prepare('SELECT enabled FROM policy WHERE guild=? AND provider=?').get(guildId, provider)?.enabled !== 0;
  }

  setProvider(guildId, provider, enabled) {
    this.policy.prepare('INSERT INTO policy VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET enabled=excluded.enabled')
      .run(guildId, provider, Number(enabled));
  }

  get(scope, provider, model) {
    if (!this.config.historyMs) return [];
    const row = this.memory.prepare('SELECT updated, turns FROM history WHERE scope=? AND provider=? AND model=?')
      .get(scope, provider, model);
    if (!row) return [];
    if (row.updated <= this.now() - this.config.historyMs) {
      this.memory.prepare('DELETE FROM history WHERE scope=? AND provider=? AND model=?').run(scope, provider, model);
      return [];
    }
    const binding = JSON.stringify([scope, provider, model, row.updated]);
    const json = this.config.historyKey
      ? unseal(this.config.historyKey, row.turns, binding)
      : Buffer.from(row.turns).toString();
    return JSON.parse(json);
  }

  put(scope, provider, model, turns) {
    if (!this.config.historyMs || !turns.length) return;
    const now = this.now();
    const binding = JSON.stringify([scope, provider, model, now]);
    const json = JSON.stringify(turns);
    const bytes = this.config.historyKey ? seal(this.config.historyKey, json, binding) : Buffer.from(json);
    this.memory.exec('BEGIN IMMEDIATE');
    try {
      this.memory.prepare('INSERT INTO history VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET updated=excluded.updated, turns=excluded.turns')
        .run(scope, provider, model, now, bytes);
      this.sweep();
      this.memory.exec('COMMIT');
    } catch (error) {
      this.memory.exec('ROLLBACK');
      throw error;
    }
  }

  clear(scope) {
    this.memory.prepare('DELETE FROM history WHERE scope=?').run(scope);
  }

  sweep() {
    this.memory.prepare('DELETE FROM history WHERE updated<=?').run(this.now() - this.config.historyMs);
    this.memory.prepare('DELETE FROM history WHERE rowid IN (SELECT rowid FROM history ORDER BY updated DESC, rowid DESC LIMIT -1 OFFSET ?)')
      .run(this.config.maxSessions);
  }

  close() {
    this.memory?.close();
    this.policy.close();
  }
}

export function trimTurns(turns, slots, maxChars) {
  const retained = [];
  for (const turn of turns.slice(-slots).reverse()) {
    maxChars -= turn.prompt.length + turn.answer.length;
    if (maxChars < 0) break;
    retained.push(turn);
  }
  return retained.reverse();
}
