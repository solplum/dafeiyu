#!/usr/bin/env node
/** Relocatable skill entry. Status/path reads never initialize the companion. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fs.realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
const args = process.argv.slice(2);
const command = args.shift() || '--status';
let configFile = path.join(root, 'packages/dsh-dafeiyu/config.json'), run = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config' && args[i + 1]) configFile = path.resolve(args[++i]);
  else if (args[i] === '--run') run = true;
  else throw new Error(`未知或缺少参数: ${args[i]}`);
}
const exists = fs.existsSync(configFile);
const config = exists ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('伴侣配置必须为对象');
const memoryRoot = path.resolve(config.memoryProjectRoot || root);
const companionConfig = path.resolve(config.companionConfigPath || path.join(root, 'packages/companion/config.json'));
if (command === '--status' || command === '--paths') {
  console.log(JSON.stringify({ codeRoot: root, configFile, configured: exists,
    memoryRoot, companionConfig,
    phone: { enabled: config.phoneEnabled === true, configured: Boolean(config.phoneDevice), probed: false,
      allowedTools: config.allowedPhoneTools || ['phone_screenshot', 'phone_get_ui_tree', 'phone_key', 'phone_listen'],
      allowedKeys: config.allowedPhoneKeys || ['back'], maxListenSeconds: config.maxListenSeconds || 3 },
    personalQQ: { ownerConfigured: Boolean(config.ownerQq), smallAccountConfigured: Boolean(config.onebotSelfId),
      enabled: config.autoStartOneBot === true, engine: config.onebotEngine || 'native', probed: false },
    nativeEngine: 'DSH host (model and delivery settings belong to the host)',
    note: '只读本地路径和配置；没有连接设备、读取私人记忆或调用模型' }, null, 2));
} else if (command === '--start-phone') {
  if (!run || !exists || config.phoneEnabled !== true || !config.phoneDevice) throw new Error('需要明确配置 phoneEnabled/phoneDevice 并传 --run；当前未启动手机服务');
  const allowed = config.allowedPhoneTools || ['phone_screenshot', 'phone_get_ui_tree', 'phone_key', 'phone_listen'];
  const aliases = { phone_get_ui_tree: 'phone_dump', phone_type: 'phone_text' };
  const env = { ...process.env, PHONE_SERIAL: config.phoneDevice,
    PHONE_ALLOWED_TOOLS: JSON.stringify(allowed.map((name) => aliases[name] || name)),
    PHONE_ALLOWED_KEYS: JSON.stringify(config.allowedPhoneKeys || ['back']),
    PHONE_MAX_LISTEN_SECONDS: String(config.maxListenSeconds || 3) };
  delete env.PHONE_DEVICE_IP;
  if (config.adbPath) env.PHONE_ADB = config.adbPath;
  if (config.stt) { delete env.PHONE_STT_CONFIG_FILE; env.PHONE_STT_CONFIG = JSON.stringify(config.stt); }
  const result = spawnSync(process.execPath, [path.join(root, 'packages/phone-mcp/src/phone-mcp.js')], { stdio: 'inherit', env });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else if (command === '--auto-ready') {
  if (!exists || !run) throw new Error('自动就绪需显式配置和 --run；此命令可能按配置连接设备、读取历史及发送回复');
  const result = spawnSync(process.execPath, [path.join(root, 'packages/dsh-dafeiyu/scripts/wake-auto-ready.mjs'), '--config', configFile, '--run'], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else throw new Error('支持 --status、--paths、--start-phone --run、--auto-ready --run');
