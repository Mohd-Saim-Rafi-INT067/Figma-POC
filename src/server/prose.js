/**
 * Split the generated report into its named sections.
 *
 * The five headings are fixed by the system prompt in report/llm.js, so this is
 * a lookup rather than markdown parsing. Doing it here - not in the browser -
 * keeps the UI from needing to know anything about the report's structure: it
 * asks for `sections['Key Issues']` and gets a string or undefined.
 *
 * A heading that fails to appear yields undefined for that key. That is not an
 * error: the report view renders every block from computed analysis and treats
 * prose as an optional overlay (plan §5.3), so a missing block degrades to
 * structured-only rather than blanking anything.
 */

/** The headings report/llm.js instructs the model to emit, in order. */
export const PROSE_SECTIONS = [
  'Executive Assessment',
  'What To Fix First',
  'Key Issues',
  'Section Notes',
  'Conclusion',
];

/**
 * @param {string} markdown
 * @returns {{sections: Record<string,string>, preamble: string|null, unknown: string[]}}
 */
export function splitProse(markdown) {
  const sections = {};
  const unknown = [];
  if (!markdown || typeof markdown !== 'string') return { sections, preamble: null, unknown };

  const lines = markdown.split(/\r?\n/);
  let current = null;
  let buffer = [];
  let preamble = [];

  const flush = () => {
    if (current === null) return;
    const text = buffer.join('\n').trim();
    if (text) sections[current] = text;
    buffer = [];
  };

  for (const line of lines) {
    // Level-2 only. "### <issue title>" inside Key Issues must stay with its
    // parent block - splitting on it would shred the issue cards.
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m && !/^###/.test(line)) {
      flush();
      current = m[1].trim();
      if (!PROSE_SECTIONS.includes(current)) unknown.push(current);
      continue;
    }
    if (current === null) preamble.push(line);
    else buffer.push(line);
  }
  flush();

  const pre = preamble.join('\n').trim();
  return { sections, preamble: pre || null, unknown };
}
