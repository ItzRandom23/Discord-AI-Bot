import { ConfigError, loadConfig } from '../src/config.js';
import { providerError } from '../src/errors.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { createRedactor } from '../src/security.js';

try {
  const config = loadConfig(process.env, { requireDiscord: false });
  const registry = new ProviderRegistry(config);
  const { clean } = createRedactor(config.secrets);
  const smoke = process.argv.includes('--generate');
  for (const provider of registry.providers.values()) {
    for (const { id } of provider.config.models.values()) {
      const label = clean(provider.config.id + '/' + id);
      try {
        await registry.verify(provider, id);
        if (smoke) {
          await provider.adapter.generate({
            model: id, messages: [{ role: 'user', text: 'Reply with the word OK.' }],
            signal: AbortSignal.timeout(config.timeoutMs), maxOutputTokens: config.maxOutputTokens,
          });
        }
        process.stdout.write(label + ' metadata OK' + (smoke ? ', live text generation OK' : '') + '\n');
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(label + ' ' + providerError(error).code + '\n');
      }
    }
  }
} catch (error) {
  process.exitCode = 1;
  process.stderr.write((error instanceof ConfigError ? error.message : 'Provider check failed.') + '\n');
}
