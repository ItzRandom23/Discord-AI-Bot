import { REST, Routes } from 'discord.js';
import { ConfigError, discordConfig, loadConfig } from '../src/config.js';
import { commandDefinitions, forGuildRegistration } from '../src/discord/commands.js';

try {
  const config = loadConfig();
  const { token, applicationId, commandGuildId } = discordConfig(process.env, { registration: true });
  const client = new REST({ version: '10', timeout: 12_000, retries: 1 }).setToken(token);
  const commands = commandDefinitions(config);
  const route = commandGuildId
    ? Routes.applicationGuildCommands(applicationId, commandGuildId)
    : Routes.applicationCommands(applicationId);
  await client.put(route, { body: commandGuildId ? forGuildRegistration(commands) : commands });
  process.stdout.write('Registered ' + commands.length + ' slash commands for ' + (commandGuildId ? 'the configured guild' : 'the application') + '.\n');
} catch (error) {
  const message = error instanceof ConfigError ? error.message : 'Discord command registration failed. Check the bot token, app ID, and installation.';
  process.stderr.write(message + '\n');
  process.exitCode = 1;
}
