import { ConfigError, loadConfig } from './src/config.js';
import { createRuntime } from './src/discord/runtime.js';

const log = (event, status) => process.stdout.write(JSON.stringify({ event, status }) + '\n');

async function main() {
  const config = loadConfig();
  let closing;
  const runtime = createRuntime(config, { log, onFatal: () => void stop(1) });

  function stop(exitCode = 0) {
    process.exitCode = Math.max(process.exitCode ?? 0, exitCode);
    if (!closing) {
      const force = setTimeout(() => process.exit(1), 10_000);
      closing = runtime.stop().catch(() => {
        log('shutdown', 'failed');
        process.exit(1);
      }).finally(() => clearTimeout(force));
    }
    return closing;
  }

  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  process.on('uncaughtException', () => {
    log('runtime', 'uncaught_exception');
    void stop(1);
  });
  process.on('unhandledRejection', () => {
    log('runtime', 'unhandled_rejection');
    void stop(1);
  });

  try {
    await runtime.start();
  } catch {
    if (!closing) {
      log('gateway', 'login_failed');
      await stop(1);
    }
  }
}

main().catch((error) => {
  process.exitCode = 1;
  if (error instanceof ConfigError) process.stderr.write(error.message + '\n');
  else log('startup', 'failed_check_state_directory_and_history_key');
});
