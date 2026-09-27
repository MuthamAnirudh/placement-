/*
  Technical pronunciation + "make it speakable" normalization.

  Ported from the Adaptive Neural Teacher Voice Engine (src/pronunciation.js) and extended:
    - more CS/DSA acronyms (kept conservative: over-normalizing sounds robotic)
    - Big-O expressions are spoken naturally ("O of n log n", "O of n squared")
    - toSpeakable() turns AI Markdown (headings, bullets, tables, code fences) into plain
      spoken-teacher text, so the voice never reads "hash hash" or "asterisk asterisk".
*/

const pronunciationDictionary = new Map([
  ['API', 'A P I'], ['CPU', 'C P U'], ['GPU', 'G P U'], ['RAM', 'RAM'], ['ROM', 'ROM'],
  ['AI', 'A I'], ['ML', 'machine learning'], ['DBMS', 'D B M S'], ['RDBMS', 'R D B M S'],
  ['OOP', 'object oriented programming'], ['OOPS', 'object oriented programming'],
  ['HTML', 'H T M L'], ['CSS', 'C S S'], ['SQL', 'S Q L'], ['OS', 'O S'],
  ['TCP', 'T C P'], ['UDP', 'U D P'], ['HTTP', 'H T T P'], ['HTTPS', 'H T T P S'],
  ['URL', 'U R L'], ['JSON', 'jason'], ['JVM', 'J V M'], ['JDK', 'J D K'], ['IDE', 'I D E'],
  ['BFS', 'B F S'], ['DFS', 'D F S'], ['BST', 'B S T'], ['DSU', 'D S U'], ['MST', 'M S T'],
  ['LRU', 'L R U'], ['LFU', 'L F U'], ['LIFO', 'lie-foh'], ['FIFO', 'fie-foh'],
  ['LCA', 'L C A'], ['LIS', 'L I S'], ['LCS', 'L C S'], ['DP', 'D P'],
]);

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function normalizePronunciation(text) {
  let result = text;
  for (const [term, spoken] of pronunciationDictionary) {
    result = result.replace(new RegExp(`(?<![\\w\\[])${escapeRe(term)}(?![\\w\\]])`, 'g'), spoken);
  }
  return result;
}

const NUM_WORDS = { 0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five' };

function speakBigOInner(inner) {
  return inner
    .replace(/\s+/g, ' ').trim()
    .replace(/\blog\s*\(?\s*([a-z0-9]+)\s*\)?/gi, 'log $1')
    .replace(/([a-zA-Z0-9]+)\s*\^\s*2\b/g, '$1 squared')
    .replace(/([a-zA-Z0-9]+)\s*\^\s*3\b/g, '$1 cubed')
    .replace(/([a-zA-Z0-9]+)\s*\^\s*([a-zA-Z0-9]+)/g, '$1 to the power $2')
    .replace(/\s*\*\s*/g, ' times ')
    .replace(/\s*\+\s*/g, ' plus ')
    .replace(/\s*\/\s*/g, ' over ')
    .replace(/^\d$/, (d) => NUM_WORDS[d] || d);
}

function speakBigO(text) {
  return text.replace(/\bO\(((?:[^()\n]|\([^()\n]*\))*)\)/g, (_m, inner) => `O of ${speakBigOInner(inner)}`);
}

/** Markdown / AI-answer -> plain text that sounds right when read aloud. */
function toSpeakable(input) {
  let t = String(input == null ? '' : input).replace(/\r\n?/g, '\n');
  // fenced code -> short spoken pointer (reading code symbol-by-symbol is useless to a listener)
  t = t.replace(/```[\s\S]*?```/g, '\nThe code for this is shown on screen.\n');
  // tables -> one sentence per row
  t = t.split('\n').filter((l) => !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)).map((l) => {
    if (/^\s*\|.*\|\s*$/.test(l)) return l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter(Boolean).join(', ') + '.';
    return l;
  }).join('\n');
  t = t
    .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, '$1.')          // headings -> sentence
    .replace(/^\s*>\s?/gm, '')                                     // quotes
    .replace(/^\s*[-*•]\s+/gm, '')                                 // bullets
    .replace(/^\s*(\d+)[.)]\s+/gm, 'Step $1. ')                    // numbered steps
    .replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_m, a, b) => a || b)
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1')              // links -> text
    .replace(/https?:\/\/\S+/g, 'the link on screen')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[→⇒]|->/g, ' then ')
    .replace(/\s*&&\s*/g, ' and ').replace(/\s*\|\|\s*/g, ' or ')
    .replace(/!=/g, ' not equal to ').replace(/<=/g, ' less than or equal to ').replace(/>=/g, ' greater than or equal to ')
    .replace(/\bvs\.?\b/gi, 'versus');
  t = speakBigO(t);
  t = t.replace(/[*_~#]+/g, ' ').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n')
    .replace(/\.\s*\./g, '.').replace(/([.!?:])\s*\n/g, '$1\n');
  return t.trim();
}

module.exports = { normalizePronunciation, toSpeakable, speakBigO, pronunciationDictionary };
