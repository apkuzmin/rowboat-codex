export const API_URL =
  process.env.API_URL || 'https://api.x.rowboatlabs.com';

export const ENABLE_CHATGPT_CODEX_PROVIDER = /^(1|true|yes|on)$/i.test(
  process.env.ENABLE_CHATGPT_CODEX_PROVIDER ?? '',
);
