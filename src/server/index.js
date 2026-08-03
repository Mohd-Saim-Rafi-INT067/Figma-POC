/**
 * Server entry point. `npm run server` (dev) / `npm start` (demo).
 */

import 'dotenv/config';
import { createApp } from './app.js';
import { RUNS_DIR } from './runs.js';

const PORT = Number(process.env.PORT) || 5173;

const app = createApp();

app.listen(PORT, () => {
  const llm =
    (process.env.LLM_PROVIDER || '').trim() ||
    (process.env.GEMINI_API_KEY ? 'gemini' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : null);

  console.log(`\n  figma-parity demo server`);
  console.log(`  ${'-'.repeat(46)}`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  runs      ${RUNS_DIR}`);
  console.log(`  figma     ${process.env.FIGMA_TOKEN ? 'token set' : 'NO TOKEN - runs will fail'}`);
  console.log(`  llm       ${llm ?? 'none - reports will have no written summary'}`);
  console.log(`  ${'-'.repeat(46)}\n`);
});
