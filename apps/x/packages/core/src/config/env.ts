export const API_URL =
  process.env.API_URL || 'https://api.x.rowboatlabs.com';

const codexProviderFlag = (process.env.ENABLE_CHATGPT_CODEX_PROVIDER ?? '').trim();

export const ENABLE_CHATGPT_CODEX_PROVIDER = codexProviderFlag
  ? /^(1|true|yes|on)$/i.test(codexProviderFlag)
  : true;
