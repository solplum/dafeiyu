#!/usr/bin/env node
/** Explicit startup helper; no real QQ sends or phone connection without --run. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanion } from '../src/index.js';

const args = process.argv.slice(2);
const configIndex = args.indexOf('--config');
if (!args.includes('--run') || configIndex < 0 || !args[configIndex + 1]) {
  console.log('用法: node packages/dsh-dafeiyu/scripts/wake-auto-ready.mjs --config /绝对路径/config.json --run');
  console.log('该命令会按显式配置连接手机/QQ，catchUpUnread=true 时会生成并发送未读回复。');
  process.exitCode = args.includes('--help') || !args.length ? 0 : 1;
} else {
  const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const config = JSON.parse(fs.readFileSync(path.resolve(args[configIndex + 1]), 'utf8'));
  // This CLI has no DSH registry. It invokes only the configured startup behavior,
  // with harmless registration sinks; this is not a host-integration acceptance test.
  let instance;
  try {
    instance = await createCompanion({ logger: console, systemPrompt: { context: () => () => {} },
      tools: { register: () => () => {} } }, { projectRoot, ...config });
    console.log('启动检查结果:', JSON.stringify(instance.startup));
  } finally { instance?.dispose(); }
}
