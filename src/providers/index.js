import { createGemini } from './gemini.js';
import { createOpenAI } from './openai.js';

export const providerDefinitions = Object.freeze([
  { id: 'gemini', label: 'Google Gemini', create: createGemini },
  { id: 'openai', label: 'OpenAI', create: createOpenAI },
]);
