import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectCoreOverrides } from './lib/runtime-core-health.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let agentHome = os.homedir();
let fixLinks = false;
let profile;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--fix-links') fixLinks = true;
  else if (args[i] === '--agent-home' && args[i + 1]) agentHome = path.resolve(args[++i]);
  else if (args[i] === '--profile' && args[i + 1]) profile = path.resolve(args[++i]);
  else if (args[i] === '--help') {
    console.log('用法: bash scripts/doctor.sh [--fix-links] [--agent-home PATH] [--profile PATH]');
    process.exit(0);
  } else throw new Error(`未知或缺少参数: ${args[i]}`);
}
const source = path.join(projectRoot, 'skills/dafeiyu');
let failures = 0;
console.log('大肥鱼环境检查（不连接设备、不调用模型）');
const coreHealth = inspectCoreOverrides(profile || path.join(agentHome, '.dsh/profiles/desktop'));
for (const finding of coreHealth.findings) {
  const detail = finding.missing?.length ? `，缺少: ${finding.missing.join(', ')}` : '';
  console.log(`宿主核心 ${finding.name}: ${finding.status}${detail}`);
}
if (!coreHealth.ok) {
  failures++;
  console.error('发现不完整或不可读的本地核心包覆盖；需先备份核对并恢复宿主内置包，不能用测试 shim 代替。');
  fixLinks = false;
} else console.log('宿主核心覆盖检查: 未发现已知不完整 shim（不代表完整启动验收）');
const pluginConfigFile = path.join(projectRoot, 'packages/dsh-dafeiyu/config.json');
const runtimeConfig = fs.existsSync(pluginConfigFile) ? JSON.parse(fs.readFileSync(pluginConfigFile, 'utf8')) : {};
if (!runtimeConfig || typeof runtimeConfig !== 'object' || Array.isArray(runtimeConfig)) throw new Error('伴侣本地配置必须是对象');
const memoryRoot = path.resolve(runtimeConfig.memoryProjectRoot || projectRoot);
const companionConfig = path.resolve(runtimeConfig.companionConfigPath || path.join(projectRoot, 'packages/companion/config.json'));
console.log(`当前代码: ${projectRoot}`);
console.log(`共享记忆目录: ${memoryRoot}`);
for (const [label, file] of [['主人档案', path.join(memoryRoot, 'memory/user.md')],
  ['事件手账', path.join(memoryRoot, 'memory/timeline.md')], ['独立伴侣配置', companionConfig]]) {
  console.log(`${fs.existsSync(file) ? '存在' : '待配置'}: ${label}`);
}
if (!fs.existsSync(path.join(source, 'SKILL.md'))) {
  console.error('技能源目录缺少 SKILL.md');
  failures++;
}
for (const rel of ['.minimax/skills/dafeiyu', '.agents/skills/dafeiyu', '.gemini/config/skills/dafeiyu']) {
  const target = path.join(agentHome, rel);
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat && !stat.isSymbolicLink()) {
    console.error(`保留现有文件或目录，拒绝覆盖: ${rel}`);
    failures++;
    continue;
  }
  const correct = stat && path.resolve(path.dirname(target), fs.readlinkSync(target)) === source;
  if (correct) console.log(`软链接正确: ${rel}`);
  else if (fixLinks && fs.existsSync(path.join(source, 'SKILL.md'))) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (stat) fs.unlinkSync(target);
    fs.symlinkSync(source, target, 'dir');
    console.log(`已校准软链接: ${rel}`);
  } else console.log(`软链接待校准: ${rel}（使用 --fix-links）`);
}
console.log('真机、QQ、模型和宿主装载状态: 未验证；文件检查不能证明这些服务就绪。');
process.exitCode = failures ? 1 : 0;
