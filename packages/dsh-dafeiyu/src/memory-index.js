// Rebuildable lexical search over records whose authority and scope were
// already checked by the caller. This module never reads or writes a file.
const FIELDS = Object.freeze(['title', 'key', 'summary', 'detail']);
const WEIGHTS = Object.freeze([8, 7, 5, 1]);
const INDEX_PREFIX_CHARS = 16384;
const EXCERPT_CHUNK_CHARS = 16384;
const HAN = /[\u3400-\u9fff\u{20000}-\u{2ffff}]/u;
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;

// Native string operations avoid a character/position array for a large source.
// Folding final sigma also makes chunked case normalization consistent.
const folded = value => value.toLowerCase().replace(/\u03c2/gu, '\u03c3');
const normalized = value => folded(value).replace(/\s+/gu, ' ').trim();

function queryTerms(query) {
  if (typeof query !== 'string' || query.length > 200) throw new RangeError('Memory query must be a string of at most 200 characters');
  return [...new Set(normalized(query).split(' ').filter(term => term && term !== '*'))];
}

// Chinese fallback remains lexical: every segmented word must occur. ASCII
// words, identifiers, punctuation and single-character terms stay intact.
function chineseParts(term) {
  if (!HAN.test(term)) return [term];
  const parts = [];
  for (const run of term.match(/[\u3400-\u9fff\u{20000}-\u{2ffff}]+|[^\u3400-\u9fff\u{20000}-\u{2ffff}]+/gu) || []) {
    if (!HAN.test(run)) { parts.push(run); continue; }
    const words = segmenter ? [...segmenter.segment(run)].map(item => item.segment).filter(Boolean) : [];
    if (words.length > 1) parts.push(...words);
    else {
      const characters = [...run];
      for (let index = 0; index < characters.length; index += 2) parts.push(characters.slice(index, index + 2).join(''));
    }
  }
  return [...new Set(parts)];
}

function grams(value) {
  const characters = [...value];
  if (characters.length < 2) return characters.length ? ['1:' + characters[0]] : [];
  return [...new Set(characters.slice(0, -1).map((character, index) => '2:' + character + characters[index + 1]))];
}

function intersection(sets) {
  if (!sets.length || sets.some(set => !set?.size)) return new Set();
  const ordered = sets.slice().sort((left, right) => left.size - right.size);
  return new Set([...ordered[0]].filter(id => ordered.slice(1).every(set => set.has(id))));
}

export class MemoryIndex {
  constructor(records) {
    if (!Array.isArray(records) || records.some(record => !record || typeof record !== 'object' || Array.isArray(record))) {
      throw new TypeError('MemoryIndex requires an array of validated records');
    }
    this.entries = records.map((record, ordinal) => ({ record, ordinal,
      fields: FIELDS.map(field => normalized(typeof record[field] === 'string' ? record[field] : '')) }));
    this.postings = new Map(); this.fallback = new Set();
    for (const entry of this.entries) {
      const add = key => {
        if (!this.postings.has(key)) this.postings.set(key, new Set());
        this.postings.get(key).add(entry.ordinal);
      };
      for (const field of entry.fields) {
        if (field.length > INDEX_PREFIX_CHARS) this.fallback.add(entry.ordinal);
        let previous = '';
        // Long entries remain candidates for full-text verification. Only the
        // fixed prefix creates postings, including for anomalously long titles.
        for (const character of field.slice(0, INDEX_PREFIX_CHARS)) {
          add('1:' + character);
          if (previous) add('2:' + previous + character);
          previous = character;
        }
      }
    }
  }

  candidates(term) { return intersection(grams(term).map(gram => this.postings.get(gram))); }

  search(query = '', { offset = 0, limit = 20 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100000) {
      throw new RangeError('Memory pagination requires a nonnegative offset and a limit from 1 to 100000');
    }
    const terms = queryTerms(query);
    if (!terms.length) return { records: this.entries.slice(offset, offset + limit).map(entry => entry.record), total: this.entries.length };
    const parts = terms.map(chineseParts);
    const indexed = intersection(terms.map((term, at) => {
      const exact = this.candidates(term), fallback = intersection(parts[at].map(part => this.candidates(part)));
      return new Set([...exact, ...fallback]);
    }));
    const candidates = new Set([...indexed, ...this.fallback]);
    const phrase = normalized(query).split(' ').filter(term => term !== '*').join(' ');
    const matches = [];
    for (const id of candidates) {
      const entry = this.entries[id], exact = terms.map(term => entry.fields.some(field => field.includes(term)));
      if (terms.some((_term, at) => !exact[at] && !parts[at].every(part => entry.fields.some(field => field.includes(part))))) continue;
      const tier = entry.fields.some(field => field.includes(phrase)) ? 3 : exact.every(Boolean) ? 2 : 1;
      let score = 0;
      for (let at = 0; at < terms.length; at++) for (let field = 0; field < entry.fields.length; field++) {
        if (entry.fields[field].includes(terms[at])) score += WEIGHTS[field] * 10;
        else if (!exact[at]) score += parts[at].filter(part => entry.fields[field].includes(part)).length * WEIGHTS[field];
      }
      matches.push({ entry, tier, score });
    }
    matches.sort((left, right) => right.tier - left.tier || right.score - left.score || left.entry.ordinal - right.entry.ordinal);
    return { records: matches.slice(offset, offset + limit).map(match => match.entry.record), total: matches.length };
  }
}

/** A bounded passage around an actual lexical match, with no added content. */
export function memoryExcerpt(detail, query = '', maxChars = 1200) {
  if (typeof detail !== 'string' || !Number.isInteger(maxChars) || maxChars < 0 || maxChars > 100000) {
    throw new RangeError('Memory excerpt requires text and a character budget from 0 to 100000');
  }
  const terms = queryTerms(query);
  if (!maxChars) return '';
  if (detail.length <= maxChars) return detail;
  const phrase = normalized(query).split(' ').filter(term => term !== '*').join(' ');
  const targets = [...new Set(terms.flatMap(term => [term, ...chineseParts(term)]))];
  const overlap = Math.max(phrase.length, ...targets.map(term => term.length), 1) - 1;
  let at = -1, fallbackAt = -1, carry = '', carryPositions = [], emitted = false, spaced = false;
  // Only one small chunk and the query-sized overlap own offset mappings.
  // A late exact phrase still takes precedence over an earlier partial term.
  for (let sourceAt = 0; sourceAt < detail.length && phrase; ) {
    let end = Math.min(detail.length, sourceAt + EXCERPT_CHUNK_CHARS);
    if (end < detail.length && /[\uD800-\uDBFF]/u.test(detail[end - 1])) end--;
    const pieces = [], positions = [];
    let rawAt = sourceAt;
    for (const character of detail.slice(sourceAt, end)) {
      if (/^\s$/u.test(character)) {
        if (emitted && !spaced) { pieces.push(' '); positions.push(rawAt); spaced = true; }
      } else {
        const lower = folded(character); pieces.push(lower);
        for (let index = 0; index < lower.length; index++) positions.push(rawAt);
        emitted = true; spaced = false;
      }
      rawAt += character.length;
    }
    const text = carry + pieces.join(''), mapped = carryPositions.concat(positions);
    const exact = text.indexOf(phrase);
    if (exact >= 0) { at = mapped[exact]; break; }
    for (const target of targets) {
      const hit = text.indexOf(target);
      if (hit >= 0 && (fallbackAt < 0 || mapped[hit] < fallbackAt)) fallbackAt = mapped[hit];
    }
    carry = overlap ? text.slice(-overlap) : '';
    carryPositions = overlap ? mapped.slice(-overlap) : [];
    sourceAt = end;
  }
  if (at < 0) at = fallbackAt;
  let start = at >= 0 ? Math.max(0, at - Math.floor(maxChars / 4)) : 0;
  // Do not return half of a UTF-16 surrogate pair at either edge.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(detail[start])) start--;
  let end = Math.min(detail.length, start + maxChars);
  if (end > start && /[\uD800-\uDBFF]/u.test(detail[end - 1])) end--;
  return detail.slice(start, end);
}
