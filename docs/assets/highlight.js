// Colors the code blocks marked class="language-js" or "language-ts", and the signatures in a
// <dl class="language-ts">. It only wraps the text in spans, so without JavaScript it reads the same, and Copy copies
// the same text either way.
const keywords = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'else', 'export',
  'extends', 'for', 'from', 'function', 'if', 'import', 'in', 'instanceof', 'interface', 'keyof', 'let', 'new', 'of',
  'readonly', 'return', 'switch', 'throw', 'try', 'type', 'typeof', 'var', 'while', 'yield',
]);
const literals = new Set(['true', 'false', 'null', 'undefined', 'this']);
const primitives = new Set([
  'any', 'bigint', 'boolean', 'never', 'number', 'object', 'string', 'symbol', 'unknown', 'void',
]);

const pattern = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")|(`)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(?=(\s*\()?)/y;

/** @typedef {'comment' | 'string' | 'keyword' | 'literal' | 'function' | 'type' | 'punctuation' | null} Kind */

/**
 * Splits JavaScript or TypeScript into colored runs. The runs' text joins back to the source, character for character.
 * @param {string} source
 * @returns {Array<[Kind, string]>}
 */
export function tokenize(source) {
  /** @type {Array<[Kind, string]>} */
  const out = [];
  const push = (/** @type {Kind} */ kind, /** @type {string} */ text) => {
    const last = out.at(-1);
    if (last && last[0] === kind) last[1] += text;
    else if (text) out.push([kind, text]);
  };
  let i = 0;
  while (i < source.length) {
    pattern.lastIndex = i;
    const m = pattern.exec(source);
    if (!m) { push(null, source[i++]); continue; }
    const [text, comment, string, tick, number, word, call] = m;
    if (comment) push('comment', text);
    else if (string) push('string', text);
    else if (number) push('literal', text);
    else if (tick) { i = template(source, i, push); continue; }
    else if (keywords.has(word)) push('keyword', text);
    else if (literals.has(word)) push('literal', text);
    else if (primitives.has(word) || /^[A-Z]/.test(word)) push('type', text);
    else push(call ? 'function' : null, text);
    i = pattern.lastIndex;
  }
  return out;
}

/**
 * A template literal from its opening backtick, with each `${…}` colored as code. Returns the index after it.
 * @param {string} source
 * @param {number} start
 * @param {(kind: Kind, text: string) => void} push
 */
function template(source, start, push) {
  let i = start + 1;
  let from = start;
  while (i < source.length && source[i] !== '`') {
    if (source[i] === '\\') { i += 2; continue; }
    if (source.startsWith('${', i)) {
      push('string', source.slice(from, i));
      push('punctuation', '${');
      let depth = 1;
      let end = i + 2;
      while (end < source.length && depth) depth += source[end] === '{' ? 1 : source[end] === '}' ? -1 : 0, end++;
      for (const [kind, text] of tokenize(source.slice(i + 2, end - 1))) push(kind, text);
      push('punctuation', '}');
      from = i = end;
      continue;
    }
    i++;
  }
  push('string', source.slice(from, i + 1));
  return i + 1;
}

if (typeof document !== 'undefined') {
  for (const code of document.querySelectorAll('pre > code.language-js, pre > code.language-ts, dl.language-ts > dt')) {
    code.replaceChildren(...tokenize(code.textContent ?? '').map(([kind, text]) =>
      kind ? Object.assign(document.createElement('span'), { className: `tok-${kind}`, textContent: text }) : text));
  }
}
