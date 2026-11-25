import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { EventDeduplication } from '../admission.js';
import { fitText } from '../chat.js';
import { BotError, publicError } from '../errors.js';
import { allowedMentions, visibleText } from '../security.js';
import { createPreview, embed, privateReply, respondWithResult, resultParts } from './presentation.js';

const resetPrefix = 'ai-reset:';

function identity(interaction) {
  return { guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id };
}

function choices(items, value) {
  const search = String(value).toLowerCase();
  return items.filter(({ name, value: id }) => name.toLowerCase().includes(search) || id.toLowerCase().includes(search))
    .slice(0, 25);
}

function settingsText(config, enabled) {
  const providers = enabled.map(({ id, label, defaultModel }) => label + ' (' + id + ') · ' + defaultModel).join('\n');
  const retention = config.historyMs === 0 ? 'Disabled' : (config.historyKey ? 'Encrypted local storage' : 'In memory') +
    ' for up to ' + config.historyMs / 60_000 + ' minutes after the last saved turn';
  const defaultLabel = config.providers.get(config.defaultProvider).label;
  return [
    '**Enabled here**\n' + (providers || 'No providers are enabled.'),
    '**Bot default**\n' + defaultLabel + ' · ' + config.providers.get(config.defaultProvider).defaultModel,
    '**History**\n' + retention + '. /ai reset clears your saved history in this channel.',
    '**Privacy**\nSlash replies are private. The selected provider receives the prompt, relevant history, and any uploaded image. ' +
      'Choose one_off to skip history. Fallback requires consent and sends only the current text to another enabled provider.',
  ].join('\n\n');
}

function historyPayload(key, history) {
  const title = history.label + ' · ' + history.model;
  if (!history.turns.length) return embed(title, 'There are no saved turns for this model in this channel.');
  const lines = [];
  let chars = 0;
  for (const { prompt, answer } of [...history.turns].reverse()) {
    const line = '**You**\n' + fitText(visibleText(prompt), 450) + '\n**Assistant**\n' + fitText(answer, 550);
    if (chars + line.length + 2 > 3650) break;
    lines.unshift(line);
    chars += line.length + 2;
  }
  const payload = embed(title, lines.join('\n\n') + '\n\nUse Reset to clear your saved history for all models in this channel.');
  payload.components = [new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId(resetPrefix + key.userId + ':' + key.channelId)
    .setLabel('Reset history').setStyle(ButtonStyle.Danger))];
  return payload;
}

function startTyping(channel, log) {
  if (typeof channel?.sendTyping !== 'function') return;
  let pending = false;
  const indicate = () => {
    if (pending) return;
    pending = true;
    void channel.sendTyping().catch(() => log('discord_typing', 'failed')).finally(() => { pending = false; });
  };
  indicate();
  const interval = setInterval(indicate, 8000);
  interval.unref();
  return () => clearInterval(interval);
}

function canReplyTo(message) {
  const user = message.client.user;
  const permissions = user && message.channel.permissionsFor(user);
  const sendPermission = message.channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  return permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, sendPermission]);
}

export function createDiscordHandlers(config, chat, state, { log = () => {}, events = new EventDeduplication() } = {}) {
  async function autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const enabled = chat.available(interaction.guildId);
    if (focused.name === 'provider') {
      const providers = interaction.commandName === 'ai-config' ? [...config.providers.values()] : enabled;
      await interaction.respond(choices(providers.map(({ id, label }) => ({ name: label, value: id })), focused.value));
      return;
    }
    if (focused.name === 'model') {
      const requested = interaction.options.getString('provider') ?? config.defaultProvider;
      const selected = enabled.find(({ id }) => id === requested);
      const models = Array.from(selected?.models.values() ?? [], ({ id }) => ({ name: id, value: id }));
      await interaction.respond(choices(models, focused.value));
      return;
    }
    await interaction.respond([]);
  }

  async function handleConfiguration(interaction) {
    if (!interaction.guildId || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      throw new BotError('permission');
    }
    const id = interaction.options.getString('provider', true);
    const provider = config.providers.get(id);
    if (!provider) throw new BotError('unavailable');
    const enabled = interaction.options.getBoolean('enabled', true);
    state.setProvider(interaction.guildId, id, enabled);
    await interaction.editReply(embed('Provider settings', provider.label + ' is ' + (enabled ? 'enabled' : 'disabled') + ' in this server.'));
  }

  async function handleCommand(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (interaction.commandName === 'ai-config') return handleConfiguration(interaction);
    const key = identity(interaction);
    const { options } = interaction;
    switch (options.getSubcommand()) {
      case 'chat': {
        if (key.guildId && !interaction.appPermissions?.has(PermissionFlagsBits.ViewChannel)) {
          throw new BotError('channelPermission');
        }
        const preview = createPreview(interaction, log);
        let result;
        try {
          result = await chat.complete({
            ...key,
            prompt: options.getString('prompt', true),
            provider: options.getString('provider'),
            model: options.getString('model'),
            attachment: options.getAttachment('image'),
            context: options.getBoolean('one_off') !== true,
            stream: options.getBoolean('stream') ?? undefined,
            fallback: options.getBoolean('fallback') === true,
            onPreview: preview.show,
          });
        } finally {
          await preview.finish();
        }
        await respondWithResult(interaction, result);
        break;
      }
      case 'settings':
        await interaction.editReply(embed(config.applicationName, settingsText(config, chat.available(key.guildId))));
        break;
      case 'models': {
        const requested = options.getString('provider');
        const providers = chat.available(key.guildId).filter(({ id }) => !requested || id === requested);
        if (requested && !providers.length) throw new BotError('unavailable');
        const lines = providers.flatMap(({ label, models }) => ['**' + label + '**', ...Array.from(models.values(), (item) => {
          const features = ['text'];
          if (config.imageBytes && item.image) features.push('image input');
          if (config.streaming && item.streaming) features.push('streaming');
          return '• ' + item.id + ' · ' + features.join(', ');
        })]);
        await interaction.editReply(embed('Configured models', lines.join('\n') || 'No providers are enabled here.'));
        break;
      }
      case 'history':
        await interaction.editReply(historyPayload(key, chat.history(key, options.getString('provider'), options.getString('model'))));
        break;
      case 'reset':
        chat.reset(key);
        await interaction.editReply(embed('History cleared', 'Your saved conversations in this channel have been cleared.'));
        break;
      default:
        throw new BotError('internal');
    }
  }

  async function handleButton(interaction) {
    const key = identity(interaction);
    if (interaction.customId !== resetPrefix + key.userId + ':' + key.channelId) throw new BotError('buttonOwner');
    await interaction.deferUpdate();
    chat.reset(key);
    await interaction.editReply({ ...embed('History cleared', 'Your saved conversations in this channel have been cleared.'), components: [] });
  }

  return {
    async interaction(interaction) {
      const isButton = interaction.isButton();
      if (isButton ? !interaction.customId.startsWith(resetPrefix) :
        ((!interaction.isChatInputCommand() && !interaction.isAutocomplete()) ||
          !['ai', 'ai-config'].includes(interaction.commandName))) return;
      if (!events.accept(interaction.id)) return;
      try {
        if (isButton) await handleButton(interaction);
        else if (interaction.isAutocomplete()) await autocomplete(interaction);
        else await handleCommand(interaction);
      } catch (error) {
        const safe = publicError(error);
        log('interaction', safe.code);
        try {
          if (interaction.isAutocomplete()) {
            if (!interaction.responded) await interaction.respond([]);
          } else if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: safe.message, embeds: [], components: [], allowedMentions });
          } else {
            await interaction.reply(privateReply(safe.message));
          }
        } catch {
          log('discord_reply', 'failed');
        }
      }
    },

    async message(message) {
      if (!config.legacyChannel || message.channelId !== config.legacyChannel || !message.guildId ||
          message.author.bot || message.webhookId || message.system || !message.content.trim() ||
          !canReplyTo(message) || !events.accept(message.id)) return;
      try {
        const result = await chat.complete({
          guildId: message.guildId, channelId: message.channelId, userId: message.author.id,
          provider: 'gemini', prompt: message.content, legacy: true, onStart: () => startTyping(message.channel, log),
        });
        for (const [index, content] of resultParts(result).entries()) {
          const payload = { content, flags: MessageFlags.SuppressEmbeds, allowedMentions };
          if (index === 0) await message.reply(payload);
          else await message.channel.send(payload);
        }
      } catch (error) {
        const safe = publicError(error);
        if (['rate', 'busy', 'sessionBusy'].includes(safe.code)) return;
        log('legacy_message', safe.code);
        try {
          await message.reply({ content: safe.message, allowedMentions });
        } catch {
          log('discord_reply', 'failed');
        }
      }
    },
  };
}
