import { MessageFlags } from 'discord.js';
import { fitText } from '../chat.js';
import { allowedMentions } from '../security.js';

const ephemeral = MessageFlags.Ephemeral;
const suppress = MessageFlags.SuppressEmbeds;

export function privateReply(content) {
  return { content, flags: ephemeral, allowedMentions };
}

export function embed(title, description) {
  return { embeds: [{ title, description, color: 0x366866 }], allowedMentions };
}

export function splitText(text, limit = 2000) {
  const parts = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const segment = fitText(rest, limit);
    const boundary = Math.max(segment.lastIndexOf('\n'), segment.lastIndexOf(' '));
    const cut = boundary >= limit / 2 ? boundary : segment.length;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function resultParts(result) {
  const headline = '**' + result.label + ' · ' + result.model + '**' + (result.fallback ? ' · fallback' : '');
  const details = [];
  if (result.usage) details.push(result.usage.input.toLocaleString('en-US') + ' input / ' +
    result.usage.output.toLocaleString('en-US') + ' output tokens');
  if (result.cost !== undefined) {
    details.push('estimated USD ' + (result.cost > 0 && result.cost < 0.000001 ? '<0.000001' : result.cost.toFixed(6)));
  }
  if (result.truncated) details.push('truncated');
  const footer = details.length ? '\n\n-# ' + details.join(' · ') : '';
  return splitText(headline + '\n\n' + result.text + footer);
}

export function createPreview(interaction, log, now = Date.now) {
  let pending;
  let lastUpdate = -Infinity;
  let count = 0;
  let previous;
  let closing = false;
  return {
    show(text) {
      const time = now();
      if (closing || pending || count >= 4 || time - lastUpdate < 1500 || previous === text) return;
      count += 1;
      lastUpdate = time;
      previous = text;
      pending = interaction.editReply({ content: text + '\n\n-# Generating…', flags: suppress, allowedMentions })
        .catch(() => log('discord_preview', 'failed')).finally(() => { pending = undefined; });
    },
    finish() {
      closing = true;
      return pending;
    },
  };
}

export async function respondWithResult(interaction, result) {
  const [first, ...rest] = resultParts(result);
  await interaction.editReply({ content: first, flags: suppress, allowedMentions });
  for (const content of rest) await interaction.followUp({ content, flags: ephemeral | suppress, allowedMentions });
}
