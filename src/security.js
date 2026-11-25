const credentialPatterns = [
  /\b(?:mfa\.[\w-]{45,}|[A-Za-z0-9_-]{20,30}\.[A-Za-z0-9_-]{6,8}\.[A-Za-z0-9_-]{20,})/g,
  /https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d{15,25}\/[\w-]{20,}/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]{4,}@[^/\s]+/gi,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bsk-(?:(?:proj|svcacct|admin|ant|or-v1)-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[\w]{50,}|xox[baprs]-[\w-]{16,})/g,
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/g,
];

export function createRedactor(secrets) {
  const redacted = '[redacted]';
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const clean = (value) => {
    let result = value.replace(/\r\n?/g, '\n')
      .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\uFEFF]/gu, '');
    for (const secret of values) result = result.replaceAll(secret, redacted);
    for (const pattern of credentialPatterns) result = result.replace(pattern, redacted);
    return result;
  };
  return { clean };
}

export const allowedMentions = Object.freeze({ parse: [], repliedUser: false });

export function visibleText(text) {
  return text
    .replace(/\[([^\]\n]*)\]\([^\n)]*\)/gu, '$1')
    .replace(/<(?=[@#:]|a:|\/)/gu, '‹');
}
