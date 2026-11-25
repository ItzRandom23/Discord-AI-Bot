import { BotError } from './errors.js';

export class EventDeduplication {
  constructor({ now = Date.now, limit = 30000, lifetimeMs = 2 * 60_000 } = {}) {
    this.now = now;
    this.limit = limit;
    this.lifetimeMs = lifetimeMs;
    this.events = new Map();
  }

  accept(id) {
    const now = this.now();
    for (const [key, expires] of this.events) {
      if (expires > now) break;
      this.events.delete(key);
    }
    if (this.events.has(id) || this.events.size >= this.limit) return false;
    this.events.set(id, now + this.lifetimeMs);
    return true;
  }
}

export class Admission {
  constructor(config, { now = Date.now } = {}) {
    this.config = config;
    this.now = now;
    this.windowEnd = 0;
    this.users = new Map();
    this.guilds = new Map();
    this.activeGuilds = new Map();
    this.active = 0;
    this.globalCount = 0;
  }

  enter({ guildId, userId }) {
    const { config, activeGuilds } = this;
    const tenant = guildId ?? 'dm:' + userId;
    const activeInGuild = activeGuilds.get(tenant) ?? 0;
    if (this.active >= config.concurrency || activeInGuild >= config.guildConcurrency) throw new BotError('busy');
    const now = this.now();
    if (now >= this.windowEnd) {
      this.windowEnd = now + config.rateWindowMs;
      this.users.clear();
      this.guilds.clear();
      this.globalCount = 0;
    }
    const userCount = this.users.get(userId) ?? 0;
    const guildCount = this.guilds.get(tenant) ?? 0;
    if (userCount >= config.userRate || guildCount >= config.guildRate || this.globalCount >= config.globalRate) {
      throw new BotError('rate');
    }
    this.users.set(userId, userCount + 1);
    this.guilds.set(tenant, guildCount + 1);
    this.globalCount += 1;
    this.active += 1;
    activeGuilds.set(tenant, activeInGuild + 1);
    return () => {
      this.active -= 1;
      const count = activeGuilds.get(tenant);
      if (count === 1) activeGuilds.delete(tenant);
      else activeGuilds.set(tenant, count - 1);
    };
  }
}
