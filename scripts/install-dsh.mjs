import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectCoreOverrides } from './lib/runtime-core-health.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let profile = path.join(os.homedir(), '.dsh/profiles/desktop');
let dryRun = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--profile' && args[i + 1]) profile = path.resolve(args[++i]);
  else if (args[i] === '--help') {
    console.log('用法: bash scripts/install-dsh.sh [--dry-run] [--profile PATH]');
    process.exit(0);
  } else throw new Error(`未知或缺少参数: ${args[i]}`);
}

// 只迁移旧安装器自己生成的单插件 insert 块。其他写法拒绝猜测。
function removeLegacyInsert(text) {
  const rows = text.split(/\r?\n/);
  const kept = [];
  for (let i = 0; i < rows.length;) {
    if (/^- insert:\s*$/.test(rows[i]) && /^    - id: ['"]?dsh-dafeiyu['"]?\s*$/.test(rows[i + 1] || '')) {
      let end = i + 2;
      while (end < rows.length && !/^\S/.test(rows[end])) end++;
      const tail = rows.slice(i + 2, end);
      if (tail.some(row => row.trim() && !/^ {6,}\S/.test(row))) {
        throw new Error('旧插件声明包含其他条目，请先人工移除 profile 中重复的 dsh-dafeiyu insert');
      }
      i = end;
    } else kept.push(rows[i++]);
  }
  const result = kept.join('\n');
  if (/\bid:\s*['"]?dsh-dafeiyu\b/.test(result)) {
    throw new Error('profile 已有无法自动迁移的插件声明；请先检查重复的 dsh-dafeiyu insert');
  }
  return result.trim() ? result : '[]\n';
}

async function main() {
  const health = inspectCoreOverrides(profile);
  if (!health.ok) throw new Error(`宿主核心包存在异常覆盖，安装未修改任何文件: ${health.findings.filter((item) => item.status === 'shim' || item.status === 'unreadable').map((item) => item.name).join(', ')}。先备份核对并恢复宿主内置包，禁止补测试 shim。`);
  const pluginDir = path.join(root, 'packages/dsh-dafeiyu');
  const packageFile = path.join(profile, 'package.json');
  const patchFile = path.join(profile, 'cordis.patch.yml');
  const link = path.join(profile, 'node_modules/dsh-dafeiyu');
  const originalPackage = fs.readFileSync(packageFile, 'utf8');
  const pkg = JSON.parse(originalPackage);
  const originalPatch = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : null;
  const nextPatch = originalPatch === null ? null : removeLegacyInsert(originalPatch);
  try {
    const stat = fs.lstatSync(link);
    if (!stat.isSymbolicLink()) throw new Error(`拒绝覆盖实际文件或目录: ${link}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // 模块导入不调用 apply，避免把真实发消息当作安装自检。
  const plugin = await import(path.join(pluginDir, 'src/index.js'));
  if (typeof plugin.apply !== 'function') throw new Error('插件缺少 apply 导出');
  pkg.dependencies ??= {};
  pkg.dependencies['dsh-dafeiyu'] = `file:${pluginDir}`;
  pkg.dsh ??= {};
  pkg.dsh.profile ??= {};
  pkg.dsh.profile.bundles ??= [];
  if (!Array.isArray(pkg.dsh.profile.bundles)) throw new Error('dsh.profile.bundles 必须是数组');
  pkg.dsh.profile.bundles = [...new Set([...pkg.dsh.profile.bundles, 'dsh-dafeiyu'])];
  const nextPackage = JSON.stringify(pkg, null, 2) + '\n';
  console.log(`插件: ${pluginDir}\nProfile: ${profile}`);
  console.log('登记 dependency / bundle / 软链接；插件声明由 bundle 提供，不重复追加。');
  if (originalPatch !== nextPatch) console.log('将迁移旧安装器生成的重复插件声明，并备份原文件。');
  if (dryRun) { console.log('DRY_RUN: 未修改文件，未启动插件。'); return; }
  const suffix = `.bak-${Date.now()}-${randomUUID()}`;
  fs.copyFileSync(packageFile, packageFile + suffix);
  if (originalPatch !== nextPatch) fs.copyFileSync(patchFile, patchFile + suffix);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const stagingLink = link + '.' + randomUUID();
  try {
    fs.symlinkSync(pluginDir, stagingLink, 'dir');
    fs.writeFileSync(packageFile, nextPackage);
    if (originalPatch !== nextPatch) fs.writeFileSync(patchFile, nextPatch);
    fs.renameSync(stagingLink, link);
  } catch (error) {
    fs.writeFileSync(packageFile, originalPackage);
    if (originalPatch !== nextPatch) fs.writeFileSync(patchFile, originalPatch);
    if (fs.existsSync(stagingLink)) fs.unlinkSync(stagingLink);
    throw error;
  }
  console.log('本地安装登记完成。尚未验证 DSH 实际装载、真机连接或 QQ 通信。');
}
main().catch(error => { console.error(`安装失败: ${error.message}`); process.exitCode = 1; });
