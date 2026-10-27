import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryIndex, memoryExcerpt } from '../packages/dsh-dafeiyu/src/memory-index.js';

const record = (id, detail, extra = {}) => ({ id, title: '', key: '', summary: '', detail, ...extra });
const ids = result => result.records.map(row => row.id);

test('lexical index normalizes case and whitespace while preserving every requested term and stable source order', () => {
  const records = [record('first', 'ALPHA\n\tBeta'), record('second', 'alpha beta'), record('other', 'alpha only')];
  const before = structuredClone(records), index = new MemoryIndex(records);
  assert.deepEqual(ids(index.search('  ALpha   beta\n')), ['first', 'second']);
  assert.equal(index.search('alpha beta').total, 2);
  assert.deepEqual(index.search('alpha beta', { offset: 1, limit: 1 }).records, [records[1]]);
  assert.deepEqual(ids(index.search('')), ['first', 'second', 'other']);
  assert.deepEqual(ids(index.search('*')), ['first', 'second', 'other']);
  assert.deepEqual(records, before, 'index construction and searches never mutate source records');
});

test('complete phrase outranks split words and title, key and summary outrank detail-only ties', () => {
  const index = new MemoryIndex([
    record('split', 'alpha other beta'), record('detail', 'alpha beta'),
    record('summary', '', { summary: 'alpha beta' }), record('key', '', { key: 'alpha beta' }), record('title', '', { title: 'alpha beta' }),
  ]);
  assert.deepEqual(ids(index.search('alpha beta')), ['title', 'key', 'summary', 'detail', 'split']);
  assert.deepEqual(ids(index.search('alpha beta')), ids(index.search('alpha beta')), 'ordering is deterministic');
});

test('Chinese lexical fallback locates separated words while exact phrases stay first and single characters are not discarded', () => {
  const index = new MemoryIndex([record('separated', '这里记录项目的开发方法'), record('exact', '项目开发'), record('single', '鱼'), record('irrelevant', '项目安排')]);
  assert.deepEqual(ids(index.search('项目开发')), ['exact', 'separated']);
  assert.deepEqual(ids(index.search('鱼')), ['single']);
  assert.deepEqual(ids(index.search('项目 鱼')), []);
  assert.deepEqual(ids(index.search('项目开发 missing')), []);
});

test('ASCII canary identifiers remain complete rather than becoming broad partial-token matches', () => {
  const index = new MemoryIndex([record('whole', 'MATCH_NEAR_END_CANARY'), record('pieces', 'MATCH NEAR END CANARY'), record('prefix', 'MATCH_NEAR_END_OTHER')]);
  assert.deepEqual(ids(index.search('match_near_end_canary')), ['whole']);
  assert.deepEqual(ids(index.search('z')), []);
  assert.equal(index.search('match').total, 3, 'existing substring queries remain supported');
});

test('ten thousand fictional records retain older tail matches with a bounded result page', () => {
  const records = Array.from({ length: 10000 }, (_value, at) => record('fictional-' + at, '虚构测试条目 ' + at + '：普通内容', { summary: '虚构索引条目' }));
  records[3].detail = '普通开头。'.repeat(500) + 'MATCH_NEAR_END_CANARY';
  const index = new MemoryIndex(records);
  assert.deepEqual(ids(index.search('MATCH_NEAR_END_CANARY')), ['fictional-3']);
  assert.equal(index.search('虚构', { offset: 25, limit: 20 }).records.length, 20);
  assert.equal(index.search('虚构').total, 10000);
  assert.deepEqual(index.search('虚构', { offset: 20000 }).records, []);
});

test('excerpt follows tail matches and respects case, whitespace, character budgets and absent matches', () => {
  const detail = 'HIDDEN_HEAD_CANARY ' + 'ordinary filler '.repeat(300) + 'MATCH_NEAR_END_CANARY end';
  const excerpt = memoryExcerpt(detail, 'match_near_end_canary', 80);
  assert.ok(excerpt.includes('MATCH_NEAR_END_CANARY')); assert.ok(excerpt.length <= 80);
  assert.equal(excerpt.includes('HIDDEN_HEAD_CANARY'), false);
  assert.equal(memoryExcerpt('short text', 'short', 100), 'short text');
  assert.equal(memoryExcerpt(detail, 'notfound', 20), detail.slice(0, 20));
  assert.equal(memoryExcerpt(detail, 'MATCH_NEAR_END_CANARY', 0), '');
  const unicode = '前缀😀 '.repeat(100) + 'ALPHA\n\tBETA 真实尾部';
  assert.ok(memoryExcerpt(unicode, 'alpha beta', 30).includes('ALPHA\n\tBETA'));
  const emoji = memoryExcerpt('😀😀😀😀', '', 3);
  assert.ok(emoji.length <= 3); assert.equal(emoji, '😀');
});

test('large fictional entries bound postings to prefixes without losing tail matches in any indexed field', () => {
  const long = 'ordinary filler '.repeat(65536), index = new MemoryIndex([
    record('large-detail', long + ' MATCH_NEAR_END_CANARY'),
    record('large-title', '', { title: long + ' TITLE_TAIL_CANARY' }),
    record('large-key', '', { key: long + ' KEY_TAIL_CANARY' }),
    record('large-summary', '', { summary: long + ' SUMMARY_TAIL_CANARY' }),
  ]);
  for (const [query, id] of [['match_near_end_canary', 'large-detail'], ['title_tail_canary', 'large-title'],
    ['key_tail_canary', 'large-key'], ['summary_tail_canary', 'large-summary']]) {
    assert.deepEqual(ids(index.search(query)), [id]);
  }
  assert.deepEqual(ids(index.search('match_near_end_canary impossible')), [], 'fallback still verifies every query term');
  assert.deepEqual(ids(index.search('', { limit: 2 })), ['large-detail', 'large-title']);
  assert.equal(index.postings.has('2:ca'), false, 'the tail does not create postings beyond the fixed prefix');
  const excerpt = memoryExcerpt(long + ' MATCH_NEAR_END_CANARY', 'match_near_end_canary', 90);
  assert.ok(excerpt.includes('MATCH_NEAR_END_CANARY')); assert.ok(excerpt.length <= 90);
});

test('chunked excerpts locate phrases across block boundaries and prefer a late complete phrase', () => {
  const detail = 'ALPHA early partial. ' + 'x'.repeat(16384 - 25) + 'ALPHA\n\tBETA end';
  assert.ok(memoryExcerpt(detail, 'alpha beta', 60).includes('ALPHA\n\tBETA'));
  const expansion = 'İ'.repeat(17000) + ' MATCH_NEAR_END_CANARY';
  assert.ok(memoryExcerpt(expansion, 'match_near_end_canary', 60).includes('MATCH_NEAR_END_CANARY'));
});

test('invalid query, pagination and excerpt budgets fail explicitly rather than silently widening retrieval', () => {
  const index = new MemoryIndex([]);
  for (const query of [null, 123, 'x'.repeat(201)]) assert.throws(() => index.search(query), RangeError);
  for (const options of [{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 100001 }, { limit: 1.5 }]) {
    assert.throws(() => index.search('', options), RangeError);
  }
  for (const budget of [-1, 0.5, 100001, NaN]) assert.throws(() => memoryExcerpt('text', '', budget), RangeError);
  assert.throws(() => new MemoryIndex([null]), TypeError);
});
