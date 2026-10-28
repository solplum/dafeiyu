import test from 'node:test';
import assert from 'node:assert/strict';
import { CompanionToolRegistry } from '../packages/dsh-dafeiyu/src/companion-tool-registry.js';
import { runToolLoop } from '../packages/companion/src/tool-loop.js';

test('a large library list remains usable by the model while preserving partial-scan warnings', async () => {
  const memes = Array.from({ length: 100 }, (_, i) => ({ filename: `${i}_${'a'.repeat(230)}.png`, isWhaleMeme: false }));
  const warnings = Array.from({ length: 20 }, (_, i) => ({ filename: `bad-${i}.png`, error: 'x'.repeat(200) }));
  const owner = { userId: 'fixture-owner', key: 'private:fixture-owner' };
  const registry = new CompanionToolRegistry({ ownerQq: owner.userId, memeManager: {
    listMemes: () => memes,
    scanMemes: () => ({ memes, warnings, partial: true, warningCount: 42, warningsTruncated: true }),
  } });
  let requests = 0;
  const result = await runToolLoop({ registry, context: owner, messages: [{ role: 'user', content: 'list library' }],
    request: async (messages) => {
      if (requests++ === 0) return { choices: [{ message: { tool_calls: [{ id: 'fixture-list', type: 'function',
        function: { name: 'meme_list', arguments: '{"limit":100}' } }] } }] };
      const response = messages.find((message) => message.role === 'tool');
      assert.ok(response.content.length <= 24000);
      const output = JSON.parse(response.content);
      assert.equal(output.ok, true); assert.equal(output.total, 100); assert.equal(output.truncated, true);
      assert.ok(output.memes.length > 0 && output.memes.length < 100);
      assert.equal(output.warningCount, 42); assert.equal(output.partial, true);
      assert.equal(output.warningsTruncated, true); assert.equal(output.warnings.length, 20);
      return { choices: [{ message: { content: 'partial library received' } }] };
    } });
  assert.equal(result.toolFailed, false);
});
