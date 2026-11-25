import { BotError } from './errors.js';
import { validDiscordId } from './config.js';

const cdn = 'https://cdn.discordapp.com';
const types = new Set(['image/png', 'image/jpeg', 'image/webp']);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function pngSize(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(pngSignature) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return;
  let pixels = false;
  for (let offset = 33; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    offset += length + 12;
    if (offset > bytes.length || type === 'acTL') return;
    if (type === 'IDAT' && length) pixels = true;
    if (type === 'IEND' && length === 0 && offset === bytes.length && pixels) {
      return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    }
  }
}

function jpegSize(bytes) {
  if (bytes.length < 12 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return;
  let size;
  for (let offset = 2; offset + 3 < bytes.length;) {
    if (bytes[offset++] !== 0xff) return;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (offset + 2 > bytes.length) return;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length - 2) return;
    if (marker === 0xda) return size;
    if (sof.has(marker) && length >= 8) size = [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    offset += length;
  }
}

function webpSize(bytes) {
  if (bytes.length < 26 || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.toString('ascii', 8, 12) !== 'WEBP') return;
  let size;
  let frame = false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    offset = end + (length % 2);
    if (offset > bytes.length || type === 'ANIM' || type === 'ANMF') return;
    if (type === 'VP8X' && length === 10) {
      if (bytes[start] & 0x02) return;
      size = [bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1];
    }
    if (type === 'VP8 ' && length >= 10 && bytes.readUIntBE(start + 3, 3) === 0x9d012a) {
      frame = true;
      size ??= [bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff];
    }
    if (type === 'VP8L' && length >= 5 && bytes[start] === 0x2f) {
      frame = true;
      const bits = bytes.readUInt32LE(start + 1);
      size ??= [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
    if (frame && offset === bytes.length) return size;
  }
}

function validateImage(type, bytes) {
  const size = { 'image/png': pngSize, 'image/jpeg': jpegSize, 'image/webp': webpSize }[type](bytes);
  if (!size || size.some((value) => value < 1 || value > 8192) || size[0] * size[1] > 24_000_000) {
    throw new BotError('attachment');
  }
}

function validateAttachment(attachment, byteLimit) {
  const { id, contentType, size, url } = attachment;
  if (!validDiscordId(id) || !types.has(contentType) || !Number.isSafeInteger(size) || size < 26 || size > byteLimit) {
    throw new BotError('attachment');
  }
  const parsed = URL.parse(url);
  const route = parsed?.pathname.match(/^\/attachments\/\d{17,20}\/(\d{17,20})\/[^/]+$/);
  if (!parsed || parsed.origin !== cdn || parsed.username || parsed.password || parsed.hash ||
      route?.[1] !== id || /%(?:2f|5c|00)/i.test(parsed.pathname)) {
    throw new BotError('attachment');
  }
  return parsed;
}

export async function downloadImage(attachment, byteLimit, signal, fetchImpl = globalThis.fetch) {
  if (!byteLimit) throw new BotError('imageDisabled');
  const url = validateAttachment(attachment, byteLimit);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  let reader;
  try {
    const response = await fetchImpl(url, { redirect: 'error', signal: deadline, credentials: 'omit' });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new BotError('attachmentDownload');
    }
    reader = response.body.getReader();
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
    const length = response.headers.get('content-length');
    if (contentType !== attachment.contentType || (length !== null && Number(length) !== attachment.size)) {
      throw new BotError('attachment');
    }
    const bytes = Buffer.alloc(attachment.size);
    let offset = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > bytes.length) throw new BotError('attachment');
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== bytes.length) throw new BotError('attachment');
    validateImage(contentType, bytes);
    return { type: contentType, data: bytes.toString('base64') };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof BotError) throw error;
    throw new BotError('attachmentDownload');
  } finally {
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
