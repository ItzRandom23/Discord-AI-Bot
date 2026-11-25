import { ApplicationIntegrationType, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

function provider(option) {
  return option.setName('provider').setDescription('AI provider').setAutocomplete(true);
}

function model(option) {
  return option.setName('model').setDescription('Model from the selected provider').setAutocomplete(true);
}

export function commandDefinitions(config) {
  const ai = new SlashCommandBuilder()
    .setName('ai').setDescription('Chat with AI and manage your conversation')
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
    .addSubcommand((command) => {
      command.setName('chat').setDescription('Send a prompt to an AI provider')
        .addStringOption((option) => option.setName('prompt').setDescription('Message to send').setRequired(true)
          .setMaxLength(config.maxPrompt))
        .addStringOption(provider).addStringOption(model)
        .addBooleanOption((option) => option.setName('one_off').setDescription('Send without using or saving conversation history'));
      if (config.imageBytes && [...config.providers.values()].some((entry) => [...entry.models.values()].some((item) => item.image))) {
        command.addAttachmentOption((option) => option.setName('image').setDescription('A PNG, JPEG, or WebP image sent to the selected provider'));
      }
      if (config.streaming && [...config.providers.values()].some((entry) => [...entry.models.values()].some((item) => item.streaming))) {
        command.addBooleanOption((option) => option.setName('stream').setDescription('Show a draft as it arrives when the selected model supports streaming'));
      }
      if (config.fallback.length && config.providers.size > 1) {
        command.addBooleanOption((option) => option.setName('fallback')
          .setDescription('Allow another enabled provider to receive this text prompt if the first provider fails'));
      }
      return command;
    })
    .addSubcommand((command) => command.setName('models').setDescription('List configured models and their capabilities')
      .addStringOption(provider))
    .addSubcommand((command) => command.setName('settings').setDescription('See the bot’s defaults and privacy settings'));
  if (config.historyMs) {
    ai.addSubcommand((command) => command.setName('history').setDescription('View your recent conversation in this channel')
      .addStringOption(provider).addStringOption(model));
  }
  ai.addSubcommand((command) => command.setName('reset').setDescription('Clear your conversations in this channel'));

  const admin = new SlashCommandBuilder()
    .setName('ai-config').setDescription('Manage AI availability for this server')
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall).setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((command) => command.setName('provider').setDescription('Allow or disable a provider in this server')
      .addStringOption((option) => provider(option).setRequired(true))
      .addBooleanOption((option) => option.setName('enabled').setDescription('Allow requests to this provider').setRequired(true)));

  return [ai.toJSON(), admin.toJSON()];
}

export function forGuildRegistration(definitions) {
  return definitions.map(({ contexts: _contexts, integration_types: _integration, ...command }) => command);
}
