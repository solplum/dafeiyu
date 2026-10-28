/** DSH Cordis adapter. Loading registers capabilities; device/network startup is explicit. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { MemoryBridge } from './memory-bridge.js';
import { LifeMemory } from './life-memory.js';
import { TokenBudget } from './token-budget.js';
import { createTokenAccounting, tokenPrompt, registerTokenStatusTool } from './token-accounting.js';
import { createContextGuard } from './context-guard.js';
import { createDesktopContextControl } from './desktop-context-control.js';
import { AutonomyEngine } from './autonomy-engine.js';
import { createAutonomyRunner, createAutonomyUserPriority } from './autonomy-runner.js';
import { PhoneTools } from './phone-tools.js';
import { MemeManager } from './meme-manager.js';
import { VoiceProcessor } from './voice-processor.js';
import { QQGateway } from './qq-gateway.js';
import { oneBotMessageSegments } from './qq-message-input.js';
import { SidebarDashboard } from './ui/sidebar.js';
import { WidgetEnhancer } from './ui/widget.js';
import { AutoReadyManager } from './auto-ready.js';
import { ownerContextFor, buildHostPrompt } from './native-context.js';
import { NativeCompanionTools } from './native-companion-tools.js';
import { CompanionToolRegistry } from './companion-tool-registry.js';
import { createNativeSttProvider } from './stt-provider.js';
import { MemeTools } from './meme-tools.js';
import { NativeOneBotBridge } from './native-onebot.js';
import { isAllowedOneBotMessage } from './onebot-admission.js';
import { normalizeQQAccounts, validateQQAccounts, activeQQIdentity } from './account-identities.js';
import { registerNativeOneBotTools } from './native-onebot-tools.js';
import { PrivateConfigStore, ConfigStoreError } from './config-store.js';
import { ConfigurationPanelController, readablePaths, registerConfigPanel } from './config-panel.js';
import { NapCatPanel } from './napcat-panel.js';
import { PanelLibrary } from './panel-library.js';
import { ModelPanel } from './model-panel.js';
import { createModelTestRunner } from './model-test-runner.js';
import { DependencyPanel } from './dependency-panel.js';
import { VoiceOutput, registerVoiceOutputTool } from './voice-output.js';
import { VoicePanel } from './voice-panel.js';
import { RuntimeDiagnostics } from './runtime-diagnostics.js';
import { MemoryPanelController } from './memory-panel.js';
import { BackgroundTaskManager } from './background-tasks.js';
import { registerBackgroundTools } from './background-tools.js';
import { createNativeTaskExecutor } from './native-task-executor.js';
import { createExternalExecutor } from './external-executors.js';
import { createCodexCliExecutor } from './codex-cli-executor.js';
import { CapabilityRegistry, capabilityPromptSummary } from './capabilities.js';
import { registerCapabilityTools } from './capabilities-tools.js';
import { createHostCapabilityAdapter } from './host-capabilities.js';
import { createCapabilityProbes } from './capability-probes.js';
import { prepareCurrentDesktopAccessibility } from './native-accessibility.js';
import { createControlAccess } from './control-access.js';
import { createNativeControlBackend } from './native-control-backend.js';
import { BiliBrowser, registerBiliBrowserTools } from './bili-browser.js';
import { SocialPanel } from './social-panel.js';
import { createSocialAccounts } from './social/accounts-factory.mjs';
import { registerSocialAccountTools } from './social/account-tools.mjs';
import { DouyinBrowser, createDouyinToolRunner, registerDouyinBrowserTools } from './douyin-browser.js';

export const name = 'dsh-dafeiyu';
// This installed Cordis fork accepts service names directly, not required/optional wrappers.
export const inject = ['systemPrompt', 'tools'];
const defaultProjectRoot = fileURLToPath(new URL('../../../', import.meta.url));

export async function createCompanion(ctx, config = {}, { capabilities, controlAccess } = {}) {
  const localConfigPath = config.configFile || (!config.projectRoot ? fileURLToPath(new URL('../config.json', import.meta.url)) : '');
  if (localConfigPath && fs.existsSync(localConfigPath)) {
    let localConfig;
    try { localConfig = JSON.parse(fs.readFileSync(localConfigPath, 'utf8')); }
    catch (error) { throw new Error(`伴侣插件本地配置无法读取: ${error.message}`); }
    if (!localConfig || typeof localConfig !== 'object' || Array.isArray(localConfig)) throw new Error('伴侣插件本地配置必须是 JSON 对象');
    config = { ...localConfig, ...config };
  }
  const logger = ctx.logger || console;
  const projectRoot = path.resolve(config.projectRoot || defaultProjectRoot);
  const ownerOpenId = String(config.ownerOpenId || '');
  const ownerQq = String(config.ownerQq || '');
  const onebotSelfId = String(config.onebotSelfId || '');
  const onebotEngine = config.onebotEngine || 'native';
  const accountErrors = validateQQAccounts({ ...config, onebotEngine });
  if (accountErrors.length) throw new Error(accountErrors.map((error) => error.message).join('；'));
  const qqAccounts = normalizeQQAccounts(config);
  if (!['native', 'legacy'].includes(onebotEngine)) throw new Error('onebotEngine 必须为 native 或 legacy');
  if (config.autoStartOneBot === true && (!/^\d+$/.test(ownerQq) || !/^\d+$/.test(onebotSelfId) || ownerQq === onebotSelfId)) {
    throw new Error('启用个人 QQ 需要分别配置 ownerQq（主人）和 onebotSelfId（小号），两者不能相同');
  }
  if (onebotEngine === 'native' && config.catchUpUnread === true) throw new Error('原生个人 QQ 暂不支持历史补回；请关闭 catchUpUnread');
  let nativeOneBot;
  let backgroundTasks;
  const trustedDesktopSessionIds = config.trustedDesktopSessionIds ?? [];
  if (!Array.isArray(trustedDesktopSessionIds) || !trustedDesktopSessionIds.every((id) => typeof id === 'string' && id.trim() === id && id.length)) {
    throw new Error('trustedDesktopSessionIds 必须是实际宿主会话 ID 的字符串数组');
  }
  const memoryProjectRoot = path.resolve(config.memoryProjectRoot || projectRoot);
  let companionCfg = {};
  const cfgPath = path.resolve(config.companionConfigPath || path.join(projectRoot, 'packages/companion/config.json'));
  const companionDir = path.dirname(cfgPath);
  try {
    companionCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`伴侣配置无法读取: ${error.message}`);
  }
  const load = (file) => import(pathToFileURL(path.join(projectRoot, 'packages/companion/src', file)).href);
  const [{ Brain }, { Role }, { Memory }, { Humanizer }] = await Promise.all([
    load('brain.js'), load('role.js'), load('memory.js'), load('humanize.js'),
  ]);
  const role = new Role({ cardPath: path.resolve(companionDir, companionCfg.roleCard || 'role.md'), maxChars: companionCfg.roleMaxChars || 12000, memoryProjectRoot });
  const memory = new Memory({ dir: path.resolve(config.companionDataDir || path.resolve(companionDir, companionCfg.dataDir || 'data')) });
  const brain = new Brain({ apiKey: config.apiKey || process.env.MINIMAX_API_KEY || process.env.DEEPSEEK_API_KEY || companionCfg.apiKey || '',
    baseUrl: config.baseUrl || companionCfg.baseUrl || 'https://api.deepseek.com/v1',
    model: config.model || companionCfg.model || 'deepseek-chat', role, memory,
    ownerIds: [ownerQq, ownerOpenId].filter(Boolean) });
  const humanizer = new Humanizer(companionCfg.humanize || {});
  const memoryBridge = new MemoryBridge({ projectRoot: memoryProjectRoot, ownerOpenId, ownerQq });
  brain.memoryBridge = memoryBridge;
  const lifeMemory = new LifeMemory({ directory: path.join(memoryProjectRoot, 'memory/life') });
  const tokenBudget = new TokenBudget({ store: lifeMemory.store });
  let tokenAccounting;
  let contextGuard;
  let desktopContext;
  let modelTests;
  const executionTokenBudget = Object.create(tokenBudget);
  executionTokenBudget.bindSession = (...args) => {
    const result = tokenBudget.bindSession(...args); tokenAccounting?.markSession(args[0]); return result;
  };
  let autonomy;
  const getExecutionContext = (execution) => {
    const identity = ownerContextFor(execution?.agent, ownerOpenId, {
      settingsNs: config.qqSettingsNs || '', trustedDesktopSessionIds, ownerQq, onebotManager: nativeOneBot,
    });
    // Verified desktop/official sessions use the same configured owner identity
    // as their prompt, without accepting an account or identity from the model.
    if (identity.isOwner && !identity.accountProfile) return { ...identity,
      accountProfile: activeQQIdentity({ ownerQq, qqAccounts }, ownerQq, { requireEnabled: false }) };
    return identity;
  };
  const speechService = typeof ctx.get === 'function' ? ctx.get('speechToText') : undefined;
  const nativeStt = !config.stt && speechService ? createNativeSttProvider(speechService) : undefined;
  const voiceProcessor = new VoiceProcessor({ sttProvider: config.sttProvider || nativeStt, stt: config.stt });
  const voiceOutput = new VoiceOutput({ config });
  const biliBrowser = new BiliBrowser({ enabled: config.biliEnabled === true, pythonPath: config.biliPythonPath,
    scriptPath: config.biliScriptPath, stateDir: config.biliStateDir, scriptSha256: config.biliScriptSha256 });
  const douyinBrowser = new DouyinBrowser({ enabled: config.douyinEnabled === true, runScript: createDouyinToolRunner({ ctx, controlAccess }) });
  const socialAccounts = createSocialAccounts({ directory: path.join(path.dirname(localConfigPath || path.join(projectRoot, 'packages/dsh-dafeiyu/config.json')), 'data/platform-accounts'), biliPythonPath: config.biliPythonPath, isOpen: () => !disposed && !maintenance });
  const phoneTools = new PhoneTools({ device: config.phoneDevice || '', adbPath: config.adbPath,
    enabled: config.phoneEnabled === true, getExecutionContext, allowDesktop: trustedDesktopSessionIds.length > 0,
    allowedTools: config.allowedPhoneTools, allowedKeys: config.allowedPhoneKeys || ['back'],
    maxListenSeconds: config.maxListenSeconds || 3,
    transcribeAudio: typeof voiceProcessor.sttProvider === 'function'
      ? (file, options) => voiceProcessor.transcribeFile(file, options) : undefined });
  const memeManager = new MemeManager({ phoneTools, desktopMemeDir: path.resolve(projectRoot,
    config.memeDir || 'packages/dsh-dafeiyu/data/memes') });
  const nativeTools = new NativeCompanionTools({ memoryBridge, lifeMemory, getAutonomy: () => autonomy, memeManager, getExecutionContext,
    phoneEnabled: config.phoneEnabled === true, sttAvailable: typeof voiceProcessor.sttProvider === 'function',
    allowMemoryWrites: config.allowMemoryWrites === true });
  const memeTools = new MemeTools({ memeManager, getExecutionContext,
    phoneEnabled: config.phoneEnabled === true, allowPhoneSync: config.allowMemeSync === true,
    allowedImportRoots: [phoneTools.shotDir, ...(config.memeImportRoots || [])] });
  const qqGateway = new QQGateway({ ownerOpenId, ownerQq,
    qqAccounts,
    expectedSelfId: onebotSelfId,
    onebotWs: config.onebotWs || '', onebotHttp: config.onebotHttp || '',
    accessToken: config.onebotAccessToken || process.env.ONEBOT_ACCESS_TOKEN || '',
    appId: config.appId || process.env.QQ_BOT_APP_ID || '',
    appSecret: config.appSecret || process.env.QQ_BOT_APP_SECRET || '' });
  nativeTools.getPersonalQQStatus = () => ({ configured: Boolean(ownerQq && onebotSelfId && config.onebotWs),
    enabled: config.autoStartOneBot === true, engine: onebotEngine,
    connected: qqGateway.connected === true, loginVerified: qqGateway.loginVerified === true,
    online: qqGateway.online, identityConflict: qqGateway.identityConflict === true,
    sessionCreated: Boolean(nativeOneBot?.status?.sessionCreated),
    enabledAccounts: qqAccounts.filter((account) => account.enabled).length,
    accounts: nativeOneBot?.status?.accounts || qqAccounts.map((account) => ({ qq: account.qq,
      enabled: account.enabled, activeIdentityId: account.activeIdentityId, sessionCreated: false })) });
  const toolRegistry = new CompanionToolRegistry({ phoneTools, voiceProcessor, memoryBridge, memeManager,
    ownerQq, ownerOpenId, phoneEnabled: config.phoneEnabled === true,
    allowedPhoneTools: config.allowedPhoneTools, allowedKeys: config.allowedPhoneKeys || ['back'],
    maxListenSeconds: config.maxListenSeconds || 3, allowMemoryWrites: config.allowMemoryWrites === true,
    sendImage: (key, file) => qqGateway.sendImage(key, file), allowMemeSync: config.allowMemeSync === true,
    memeImportRoots: [phoneTools.shotDir, ...(config.memeImportRoots || [])] });
  brain.toolRegistry = toolRegistry;
  const autoReady = new AutoReadyManager({ projectRoot, ownerQq, ownerOpenId,
    enabled: onebotEngine === 'legacy' && qqAccounts.some((account) => account.qq === ownerQq && account.enabled)
      && (config.autoStartOneBot === true || config.catchUpUnread === true),
    phoneDevice: config.phoneDevice || '', qqGateway, phoneTools, memoryBridge, brain, humanizer, logger,
    connectPhone: config.autoConnectPhone === true, catchUpUnread: config.catchUpUnread === true,
    catchUpLookbackMs: config.catchUpLookbackMs || 0 });
  const sidebar = new SidebarDashboard({ memoryBridge, phoneTools, memeManager });
  const widget = new WidgetEnhancer({ memoryBridge, phoneTools });
  const disposers = [];
  let disposed = false;
  let maintenance = false;
  let incomingActive = 0;
  let backgroundProbeActive = false;
  let lastReceivedAt = null;
  const beginMaintenance = () => {
    if (disposed || maintenance || Boolean(autonomy?.active) || modelTests?.busy || socialAccounts.busy || tokenAccounting?.active > 0 || incomingActive > 0 || backgroundTasks?.status?.busy || Number(nativeOneBot?.status?.pending || 0) > 0 || phoneTools.active > 0 || voiceProcessor.active > 0 || voiceOutput.active > 0 || biliBrowser.status.active > 0 || biliBrowser.cleanupPending || douyinBrowser.active > 0 || douyinBrowser.cleanupPending) return null;
    maintenance = true;
    let released = false;
    return () => { if (!released) { released = true; maintenance = false; } };
  };
  let disposal;
  let onebotProbe = null;
  let verifiedOneBotConnection = null;
  const sameOneBotConnection = (generation) => !disposed && qqGateway.connected === true
    && Boolean(generation.socket) && qqGateway.wsClient === generation.socket
    && Number.isSafeInteger(generation.connectedAtMs) && generation.connectedAtMs > 0
    && qqGateway.connectedAtMs === generation.connectedAtMs;
  const verifiedGeneration = (generation) => verifiedOneBotConnection?.socket === generation.socket
    && verifiedOneBotConnection?.connectedAtMs === generation.connectedAtMs;
  const currentOneBotReady = (generation) => sameOneBotConnection(generation) && verifiedGeneration(generation)
    && qqGateway.loginVerified === true && qqGateway.online === true && !qqGateway.identityConflict
    && qqGateway.selfId === onebotSelfId;
  // An explicit owner-panel probe creates a real parent/activation, but never
  // fabricates a QQ inbound message or invokes the parent's model turn.
  const probeBackgroundTask = async ({ executor, requestId }, { authorize = () => false } = {}) => {
    if (!authorize() || disposed || maintenance || !backgroundTasks) throw new Error('后台连通测试尚未就绪');
    if (!['native', 'codex', 'zcode', 'minimax'].includes(executor) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId || '')) throw new Error('测试参数无效');
    if (nativeOneBot.status.pending > 0 || backgroundTasks.status.busy) throw new Error('请等当前任务结束后再测试');
    const accountProfile = activeQQIdentity({ ownerQq, qqAccounts }, ownerQq);
    const scope = { selfId: onebotSelfId, peerId: ownerQq, identityId: accountProfile?.identity.id };
    if (!nativeOneBot.isBackgroundScopeAuthorized(scope)) throw new Error('主人身份不可用');
    const connection = { socket: qqGateway.wsClient, connectedAtMs: qqGateway.connectedAtMs };
    if (!(await verifyOneBotConnection(connection)) || !authorize() || disposed) throw new Error('QQ 登录连接尚未确认');
    if (backgroundProbeActive || maintenance || incomingActive > 0 || nativeOneBot.status.pending > 0 || backgroundTasks.status.busy) throw new Error('请等当前任务结束后再测试');
    backgroundProbeActive = true;
    incomingActive++;
    try {
      const c = nativeOneBot.controlConversation({ qq: ownerQq, identityId: scope.identityId });
      const task = { epoch: c.epoch, controller: new AbortController(), connection, modelStarted: false, sendStarted: false };
      const record = await nativeOneBot.ensureRecord({ selfId: onebotSelfId, peerId: ownerQq, identityId: scope.identityId, accountProfile }, task);
      if (!authorize() || disposed || !currentOneBotReady(connection)) throw new Error('测试授权或QQ连接已改变');
      const nonce = 'DSH-BG-' + requestId.slice(0, 8);
      return backgroundTasks.submit({ scope, parent: record.agent, originId: '-' + (BigInt('0x' + createHash('sha256').update(requestId).digest('hex').slice(0, 16)) + 1n).toString(),
        executor, probe: true, title: `${executor} 只读连通测试`, difficulty: 'simple',
        prompt: `这是一次后台执行器连通测试。不要调用工具、读取文件、修改文件或查询外部资料。只回复这一行：${nonce}` });
    } finally { incomingActive--; backgroundProbeActive = false; }
  };
  const verifyOneBotConnection = (generation) => {
    if (!sameOneBotConnection(generation) || qqGateway.identityConflict) return Promise.resolve(false);
    if (currentOneBotReady(generation)) return Promise.resolve(true);
    // A later offline heartbeat revokes a previously verified connection. Wait
    // for a real online update rather than treating the old success as current.
    if (verifiedGeneration(generation) && qqGateway.online === false) return Promise.resolve(false);
    if (onebotProbe?.socket === generation.socket && onebotProbe.connectedAtMs === generation.connectedAtMs) return onebotProbe.promise;
    const probe = { ...generation, promise: null };
    onebotProbe = probe;
    probe.promise = (async () => {
      const login = await qqGateway.api('get_login_info');
      if (!sameOneBotConnection(generation) || qqGateway.identityConflict || !login.ok
        || String(login.data?.user_id || '') !== onebotSelfId || qqGateway.selfId !== onebotSelfId
        || qqGateway.loginVerified !== true) return false;
      const status = await qqGateway.api('get_status');
      if (!sameOneBotConnection(generation) || !status.ok || status.data?.online !== true
        || qqGateway.online !== true || qqGateway.loginVerified !== true || qqGateway.identityConflict) return false;
      verifiedOneBotConnection = generation;
      return true;
    })().catch(() => false).finally(() => { if (onebotProbe === probe) onebotProbe = null; });
    return probe.promise;
  };
  const dispose = () => {
    if (disposed) return disposal;
    disposed = true;
    const pendingCleanup = [];
    const cleanup = [() => desktopContext?.dispose(), () => contextGuard?.dispose(), () => tokenAccounting?.dispose(), () => autonomy?.dispose(), () => backgroundTasks?.dispose(), () => voiceOutput.dispose(), () => biliBrowser.dispose(), () => douyinBrowser.dispose(), () => socialAccounts.dispose(), () => nativeOneBot?.dispose(), () => autoReady.dispose(), () => qqGateway.stop(),
      () => phoneTools.dispose?.(), () => nativeTools.dispose(), () => memeTools.dispose(), () => toolRegistry.dispose(), ...disposers.reverse()];
    const finishCleanup = () => { for (const unregister of cleanup) {
      try {
        const pending = unregister();
        if (pending?.then) pendingCleanup.push(Promise.resolve(pending).catch(() => logger.warn?.('[dsh-dafeiyu] 异步注销未完成')));
      } catch (error) { logger.warn?.(`[dsh-dafeiyu] 注销失败: ${error.message}`); }
    } return Promise.allSettled(pendingCleanup); };
    // Keep the actual stream bridge and context guard installed until this
    // fixed diagnostic's provider/iterator has really settled.
    const diagnosticCleanup = modelTests?.dispose();
    disposal = diagnosticCleanup?.then ? Promise.resolve(diagnosticCleanup).then(finishCleanup) : finishCleanup();
    return disposal;
  };
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'dsh-dafeiyu:lifecycle');
  else ctx.on?.('dispose', dispose);
  try {
    if (tokenBudget.read().state.tokenBudget?.requests.some((row) => ['started', 'usage'].includes(row.status))) tokenBudget.recoverStartup({ authorize: () => true });
    desktopContext = createDesktopContextControl({ ctx, trustedSessionIds: trustedDesktopSessionIds, getExecutionContext,
      directory: path.join(path.dirname(localConfigPath || path.join(projectRoot, 'packages/dsh-dafeiyu/config.json')), 'data/context-control'),
      isOpen: () => !disposed && !maintenance });
    contextGuard = createContextGuard({ ctx, persistence: desktopContext.persistence });
    desktopContext.attachGuard(contextGuard);
    tokenAccounting = createTokenAccounting({ ctx, budget: tokenBudget, ownerQq, ownerOpenId, getExecutionContext, contextGuard,
      isOpen: () => !disposed && !maintenance });
    modelTests = createModelTestRunner({ ctx, tokenBudget: executionTokenBudget, isOpen: () => !disposed && !maintenance,
      getScope: () => { const profile = activeQQIdentity({ ownerQq, qqAccounts }, ownerQq, { requireEnabled: false });
        return profile ? { accountId: profile.account.qq, identityId: profile.identity.id } : null; } });
    if (onebotEngine === 'legacy') brain.wrapModelRequest = ({ input, execute }) => tokenAccounting.runLegacy(input, execute);
    if (onebotEngine === 'native' && config.autoStartOneBot === true) nativeOneBot = new NativeOneBotBridge({ ctx, qqGateway, ownerQq, qqAccounts,
      expectedSelfId: onebotSelfId, logger, preset: config.onebotPreset || 'standard', contextGuard,
      onExperience: (event, options) => lifeMemory.observe(event, options),
      onUserActivity: (scope) => autonomy?.userActivity(scope),
      rejectBeforeConnection: true,
      ...(config.onebotCwd ? { cwd: path.resolve(config.onebotCwd) } : {}) });
    if (nativeOneBot && config.backgroundTasksEnabled !== false) {
      const workspace = path.resolve(config.onebotCwd || projectRoot);
      const blockedPaths = [cfgPath, role.cardPath, path.join(memoryProjectRoot, 'memory'),
        path.resolve(config.companionDataDir || path.resolve(companionDir, companionCfg.dataDir || 'data')),
        memeManager.desktopMemeDir, ...(localConfigPath ? [localConfigPath] : [])].filter(Boolean);
      const executorStatus = new Map();
      const wrap = (executor, runner) => ({
        async available() {
          const state = await runner.available();
          const previous = executorStatus.get(executor);
          executorStatus.set(executor, { ...executorStatus.get(executor), name: executor, available: state?.available === true,
            reason: state?.reason === 'login-required' ? '需要完成执行器原生登录' : state?.reason === 'execution-unverified' ? '已安装，等待实际连通测试'
              : previous?.faulted ? '最近调用失败，暂停自动派发；请测试连通后恢复' : state?.available === true ? '已检测到执行入口，任务调用另行验证' : '执行入口尚未就绪' });
          return previous?.faulted ? { ...state, installed: state?.installed === true || state?.available === true, available: false } : state;
        },
        async run(input) {
          const result = executor === 'native' ? await runner.run(input)
            : await tokenAccounting.runExternal(executor, input, () => runner.run(input));
          executorStatus.set(executor, { ...executorStatus.get(executor), name: executor,
            verified: result?.status === 'succeeded', faulted: ['failed', 'unknown'].includes(result?.status),
            available: result?.status === 'succeeded', reason: result?.status === 'succeeded' ? '已完成实际任务调用' : '最近任务未成功，请查看任务结果' });
          return result;
        },
      });
      const executors = {
        native: wrap('native', createNativeTaskExecutor({ ctx, provider: 'spawn', controlAccess, tokenBudget: executionTokenBudget, contextGuard })),
        codex: wrap('codex', createCodexCliExecutor({ cwdRoot: workspace })),
        zcode: wrap('zcode', createExternalExecutor({ kind: 'zcode', cwdRoot: workspace, blockedPaths })),
        minimax: wrap('minimax', createExternalExecutor({ kind: 'minimax', cwdRoot: workspace, blockedPaths })),
      };
      backgroundTasks = new BackgroundTaskManager({
        storeFile: path.join(localConfigPath ? path.dirname(localConfigPath) : path.join(projectRoot, 'packages/dsh-dafeiyu'), 'data/tasks/journal.json'),
        executors, defaultCwd: workspace, externalRouting: config.externalTaskRouting !== false,
        deliver: (scope, text) => nativeOneBot.sendBackgroundResult(scope, text),
        isAuthorized: (scope) => nativeOneBot.isBackgroundScopeAuthorized(scope),
      });
      backgroundTasks.executorStatus = () => Object.keys(executors).map((key) => executorStatus.get(key)
        || { name: key, available: null, verified: false, reason: '尚未检测或调用' });
      for (const key of Object.keys(executors)) {
        const latest = backgroundTasks.status.tasks.find((task) => task.executor === key && ['failed', 'unknown', 'succeeded'].includes(task.status));
        if (latest && latest.status !== 'succeeded') executorStatus.set(key, { name: key, available: false, verified: false, faulted: true,
          reason: '最近调用失败，暂停自动派发；请测试连通后恢复' });
      }
      nativeOneBot.backgroundTasks = backgroundTasks;
    }
    const autonomyPriority = createAutonomyUserPriority({ ctx, resolveOwner: agent => getExecutionContext({ agent }), getAutonomy: () => autonomy });
    disposers.push(() => autonomyPriority.dispose());
    autonomy = new AutonomyEngine({ memory: lifeMemory, tokenBudget: executionTokenBudget,
      run: createAutonomyRunner({ ctx, controlAccess, tokenBudget: executionTokenBudget, socialAccounts,
        getInteractionPolicy: () => autonomy?.snapshot().policy.douyinInteractions, isOpen: () => !disposed && !maintenance }),
      browseReady: (platform, { duringExecution = false } = {}) => {
        if (platform !== 'douyin') return false;
        const row = socialAccounts.snapshot().platforms.find(row => row.platform === platform);
        return row?.state === 'bound' && !row.safetyPause && !row.blocked
          && (duringExecution || row.driverConfigured === true && !row.cleanupRequired && row.browse?.state === 'stopped');
      },
      scopes: () => qqAccounts.filter((account) => account.enabled).map((account) => ({ accountId: account.qq, identityId: account.activeIdentityId })),
      greetingScopes: () => {
        const profile = activeQQIdentity({ ownerQq, qqAccounts }, ownerQq);
        return profile ? [{ accountId: profile.account.qq, identityId: profile.identity.id }] : [];
      },
      contactReady: (scope) => {
        const profile = activeQQIdentity({ ownerQq, qqAccounts }, scope?.accountId);
        return !disposed && !maintenance && profile?.identity.id === scope?.identityId
          && currentOneBotReady({ socket: qqGateway.wsClient, connectedAtMs: qqGateway.connectedAtMs });
      },
      isBusy: () => disposed || maintenance || modelTests?.busy === true || autonomyPriority.busy || incomingActive > 0 || Number(nativeOneBot?.status?.pending || 0) > 0 || Number(backgroundTasks?.status?.active || 0) > 0,
      send: async ({ scope, text }, { authorize, signal }) => {
        const profile = activeQQIdentity({ ownerQq, qqAccounts }, scope.accountId);
        const connection = { socket: qqGateway.wsClient, connectedAtMs: qqGateway.connectedAtMs };
        if (disposed || signal.aborted || !authorize() || !profile || profile.identity.id !== scope.identityId
          || !(await verifyOneBotConnection(connection)) || !authorize() || !currentOneBotReady(connection)) return { ok: false, uncertain: false };
        return qqGateway.sendMessage(`private:${scope.accountId}`, text);
      },
    });
    try { autonomy.start(); } catch { lifeMemory.lastError = { code: 'STORAGE', message: '生活记录暂不可读，普通聊天仍可使用' }; }
    qqGateway.onConnect = () => {
      verifiedOneBotConnection = null;
      const generation = { socket: qqGateway.wsClient, connectedAtMs: qqGateway.connectedAtMs };
      return verifyOneBotConnection(generation).then((ready) => {
        if (!ready && !disposed) logger.warn?.('[dsh-dafeiyu] 个人 QQ 登录身份或在线状态尚未验证，未调用模型');
        if (ready) void backgroundTasks?.flushDeliveries().catch(() => {});
        return ready;
      });
    };
    if (typeof ctx.systemPrompt?.context !== 'function') throw new Error('宿主缺少 systemPrompt.context 服务');
    const unregister = ctx.systemPrompt.context({ name: 'dsh-dafeiyu:persona', order: 80,
      interpolate: false,
      text: (context) => { tokenAccounting.trackAgent(context?.agent); return buildHostPrompt(memoryBridge, context, { ownerOpenId,
        settingsNs: config.qqSettingsNs || '', trustedDesktopSessionIds, role, ownerQq, qqAccounts, onebotManager: nativeOneBot, backgroundTasks, lifeMemory,
        capabilitySummary: capabilityPromptSummary(capabilities),
        tokenContext: [tokenPrompt(tokenBudget, getExecutionContext(context), ownerQq), contextGuard.promptFor(context?.agent)].filter(Boolean).join('\n'),
        execution: tokenAccounting.executionFor(context?.agent),
        environmentNote: config.phoneEnabled === true
          ? '手机状态尚未探测 只有实际工具结果才能证明操作成功'
          : '手机当前离线 不尝试重连 不编造已看见屏幕或已完成手机操作' }); },
    });
    if (typeof unregister === 'function') disposers.push(unregister);
    if (typeof ctx.tools?.register !== 'function') throw new Error('宿主缺少 tools.register 服务');
    phoneTools.registerToCordis(ctx);
    nativeTools.registerToCordis(ctx);
    memeTools.registerToCordis(ctx);
    disposers.push(registerTokenStatusTool(ctx, { budget: tokenBudget, getExecutionContext, ownerQq, isOpen: () => !disposed }));
    if (nativeOneBot) disposers.push(registerNativeOneBotTools(ctx, { getExecutionContext, qqGateway, memeManager }));
    if (nativeOneBot) disposers.push(registerVoiceOutputTool(ctx, { voiceOutput, qqGateway, getExecutionContext }));
    disposers.push(registerBiliBrowserTools(ctx, { browser: biliBrowser, getExecutionContext, controlAccess }));
    disposers.push(registerSocialAccountTools(ctx, { accounts: socialAccounts, getExecutionContext, isOpen: () => !disposed && !maintenance }));
    disposers.push(registerDouyinBrowserTools(ctx, { browser: douyinBrowser, getExecutionContext, controlAccess }));
    if (backgroundTasks) disposers.push(registerBackgroundTools(ctx, { manager: backgroundTasks, bridge: nativeOneBot,
      getExecutionContext, workspaceRoots: [path.resolve(config.onebotCwd || projectRoot)] }));
    if (capabilities) disposers.push(registerCapabilityTools(ctx, { registry: capabilities, getExecutionContext,
      prepareDesktop: prepareCurrentDesktopAccessibility }));

    qqGateway.onMessage = async (msg) => {
      let counted = false;
      try {
        if (disposed || maintenance) return;
        if (config.autoStartOneBot !== true) return;
        const admit = isAllowedOneBotMessage;
        if (!admit(msg, { ownerQq, qqAccounts, expectedSelfId: onebotSelfId, connectedAtMs: qqGateway.connectedAtMs })) return;
        void backgroundTasks?.flushDeliveries().catch(() => {});
        incomingActive++; counted = true;
        const generation = { socket: qqGateway.wsClient, connectedAtMs: qqGateway.connectedAtMs };
        if (!(await verifyOneBotConnection(generation)) || disposed || maintenance || !currentOneBotReady(generation)) return;
        if (!admit(msg, { ownerQq, qqAccounts, expectedSelfId: onebotSelfId, connectedAtMs: qqGateway.connectedAtMs })) return;
        lastReceivedAt = new Date().toISOString();
        const prepare = async (input, { signal } = {}) => {
          signal?.throwIfAborted();
          if (disposed || maintenance || !currentOneBotReady(generation)) {
            throw Object.assign(new Error('消息所属的 QQ 连接已变化'), { code: 'CONNECTION_CHANGED' });
          }
          const voiceRaw = { ...input.raw, message: oneBotMessageSegments(input.raw) };
          if (!voiceProcessor.hasVoice(voiceRaw)) return input;
          if (config.voiceTranscription !== true) {
            throw Object.assign(new Error('QQ 语音接收未开启，请使用文字'), { code: 'VOICE_DISABLED' });
          }
          const result = await voiceProcessor.processInboundVoice(voiceRaw, { signal,
            resolveRecord: async (record, options) => {
              if (disposed || maintenance || !currentOneBotReady(generation)) throw new Error('QQ 语音所属的连接已变化');
              const bytes = await qqGateway.getRecordAudio(record, { ...options, selfId: onebotSelfId });
              if (disposed || maintenance || !currentOneBotReady(generation)) throw new Error('QQ 语音所属的连接已变化');
              return bytes;
            } });
          signal?.throwIfAborted();
          if (disposed || maintenance || !currentOneBotReady(generation)) {
            throw Object.assign(new Error('消息所属的 QQ 连接已变化'), { code: 'CONNECTION_CHANGED' });
          }
          if (!result.ok || !result.text) {
            throw Object.assign(new Error('语音没有识别成功，请重新录音或使用文字'), { code: 'VOICE_INPUT_FAILED' });
          }
          return { ...input, text: `${input.text || ''} ${result.text}`.trim() };
        };
        if (nativeOneBot) {
          // Admission and ordering precede STT: a later text must not overtake
          // an earlier voice message from the same account and identity.
          const result = await nativeOneBot.handleIncoming(msg, { prepare });
          if (result?.ok === false) logger.warn?.(`[dsh-dafeiyu] 个人 QQ 回复未完成: ${result.error || result.reason || '未知原因'}`);
        } else {
          const prepared = await prepare(msg);
          if (!disposed && !maintenance && currentOneBotReady(generation)) autoReady.enqueueIncomingMessage(prepared);
        }
      } catch (error) { logger.warn?.(`[dsh-dafeiyu] 入站消息处理失败: ${error.message}`); }
      finally { if (counted) incomingActive--; }
    };
    if (config.autoConnectPhone === true && !config.phoneDevice) throw new Error('autoConnectPhone 需要显式配置 phoneDevice');
    if (config.catchUpUnread === true && !ownerQq) throw new Error('catchUpUnread 需要显式配置 ownerQq');
    let startup = { phone: 'not-requested', catchUp: 'not-requested' };
    if (config.autoConnectPhone === true || config.catchUpUnread === true) {
      startup = await autoReady.executeAutoReady();
    }
    if (config.autoStartOneBot === true) {
      if (!config.onebotWs) throw new Error('autoStartOneBot 需要显式配置 onebotWs');
      await qqGateway.startOneBot();
    }
    logger.info?.('[dsh-dafeiyu] 提示词与真机工具已注册；QQ 连接状态请以网关状态为准');
    logger.info?.('[dsh-dafeiyu] 官方 QQ 沿宿主原生会话引擎运行，主人私聊按实际会话注入记忆');
    return { memoryBridge, lifeMemory, tokenBudget, tokenAccounting, contextGuard, desktopContext, modelTests, autonomy, phoneTools, memeManager, voiceProcessor, voiceOutput, biliBrowser, douyinBrowser, socialAccounts, qqGateway, autoReady, sidebar, widget, beginMaintenance,
      get incomingPending() { return incomingActive; },
      get lastReceivedAt() { return lastReceivedAt; },
      brain, humanizer, nativeTools, memeTools, toolRegistry, nativeOneBot, backgroundTasks, probeBackgroundTask, dispose, startup,
      getExecutionContext,
      capabilities: { officialInbound: 'native-host', sidebar: false, widget: false },
      configuration: { nativeModelAndSending: 'host-profile', oneBotModelAndSending: onebotEngine === 'native' ? 'host-profile' : 'companionConfigPath',
        sharedRoleAndMemory: true, voiceTranscription: config.voiceTranscription === true, trustedDesktopSessionIds: [...trustedDesktopSessionIds] } };
  } catch (error) {
    dispose();
    throw error;
  }
}

// Cordis treats apply as an effect: only void or a cleanup function is valid.
export async function apply(ctx, config = {}) {
  // Keep the owner settings endpoint alive while the child runtime reloads.
  // Local config continues to lose to explicit profile options, never defaults.
  const configFile = path.resolve(config.configFile || (config.projectRoot
    ? path.join(config.projectRoot, 'packages/dsh-dafeiyu/config.json')
    : fileURLToPath(new URL('../config.json', import.meta.url))));
  const options = { ...config, configFile };
  const store = new PrivateConfigStore({ configFile, overrides: config });
  let runtime = null, child = null, appliedRevision = null, appliedSettings = null, applying = false, runtimeError = false, stopped = false;
  let dependencies, diagnostics, capabilities, hostCapabilities, capabilityContext, capabilityCreating, social;
  const controlAccess = createControlAccess({ ctx, getRuntime: () => runtime,
    resolveOwner: (agent) => runtime?.getExecutionContext?.({ agent }) });
  controlAccess.attach();
  const stopControlContext = ctx.tools.register({ name: 'dafeiyu_control_context',
    description: '读取当前已授权界面任务的工具通道和专属浏览器空间。仅当前主人或明确授权的原生界面子任务可用；不执行界面动作，不改变主人身份。浏览器工具必须显式使用返回的space，不用共享default空间。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute(_args, exec) {
      if (exec.signal?.aborted) throw new Error('当前任务已取消');
      const scope = controlAccess.scopeFor(exec.agent);
      if (!scope) throw new Error('当前会话没有已核验的界面任务权限');
      return { ok: true, ...scope, backends: { desktop: '@anionex/dsh-computer-use', browser: 'dsh-ego-browser' },
        guidance: '先观察再操作。电脑先加载dsh-computer-use技能；浏览器只使用本任务space。结果未知不重放，不自动改用旧CLI。' };
    } });
  ctx.effect?.(() => stopControlContext);
  const capabilityInstanceIds = new WeakMap();
  let capabilityInstance = 0;
  const capabilityBusy = () => capabilities?.snapshot().busy === true;
  const capabilityRuntime = () => {
    if (!runtime) return null;
    if (!capabilityInstanceIds.has(runtime)) capabilityInstanceIds.set(runtime, 'runtime-' + (++capabilityInstance));
    return { instanceId: capabilityInstanceIds.get(runtime),
      personalQQ: runtime.nativeTools?.getPersonalQQStatus?.(),
      phone: diagnostics?.phone?.() || { enabled: runtime.phoneTools?.enabled === true, state: 'not-probed' },
      voiceInput: { ...runtime.voiceProcessor?.status, receiveEnabled: runtime.configuration?.voiceTranscription === true },
      voiceOutput: runtime.voiceOutput?.status,
      memory: { enabled: true, available: typeof runtime.memoryBridge?.searchMemories === 'function' },
      memes: { enabled: true, available: Boolean(runtime.memeManager) },
      backgroundTasks: runtime.backgroundTasks?.status || { enabled: false, ready: false } };
  };
  const disposeCapabilityContext = async () => {
    const pending = capabilityCreating;
    if (pending) { try { await pending; } catch {} }
    const value = capabilityContext; capabilityContext = null;
    if (value?.handle) await value.handle.dispose();
    if (value?.directory) await fs.promises.rm(value.directory, { recursive: true, force: true });
  };
  const resolveCapabilityContext = async (expectedRuntime, { authorize, signal }) => {
    const authorized = () => !stopped && runtime === expectedRuntime && authorize?.() === true && !signal?.aborted;
    if (!authorized()) throw new Error('能力检测授权已变化');
    if (capabilityContext?.runtime === expectedRuntime) return capabilityContext;
    if (!capabilityCreating) {
      capabilityCreating = (async () => {
        const agents = ctx.get?.('agents'), presets = ctx.get?.('agentPresets');
        const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.();
        if (!agents?.create || !presets?.mount || !selection?.provider || !selection?.model) throw new Error('宿主检测作用域不可用');
        const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dafeiyu-host-check-'));
        await fs.promises.chmod(directory, 0o700);
        let handle;
        try {
          if (!authorized()) throw new Error('能力检测已取消');
          const create = () => agents.create({ sessionId: 'dafeiyu-capability-check:' + randomUUID(),
            meta: { cwd: directory, agentPreset: 'standard' }, agentOptions: { ...selection },
            setup: async (agentCtx) => { if (!authorized()) throw new Error('能力检测已取消'); await presets.mount(agentCtx, 'standard');
              agentCtx.get('tools').presentAs('native'); } });
          handle = await (agents.withoutInitiator ? agents.withoutInitiator(create) : create());
          if (!authorized() || !handle?.agent || agents.get(handle.agent.id) !== handle.agent || typeof handle.dispose !== 'function') throw new Error('能力检测作用域已变化');
          return capabilityContext = { runtime: expectedRuntime, agent: handle.agent, cwd: directory, directory, handle, isOwner: true };
        } catch (error) {
          await handle?.dispose?.();
          await fs.promises.rm(directory, { recursive: true, force: true });
          throw error;
        }
      })().finally(() => { capabilityCreating = null; });
    }
    const value = await capabilityCreating;
    if (!authorized()) throw new Error('能力检测授权已变化');
    return value;
  };
  const companionBusy = () => applying || Number(runtime?.incomingPending || 0) > 0 || Number(runtime?.nativeOneBot?.status?.pending || 0) > 0
    || runtime?.modelTests?.busy === true
    || Number(runtime?.tokenAccounting?.active || 0) > 0
    || controlAccess.snapshot().busy === true
    || runtime?.backgroundTasks?.status?.busy === true
    || Number(runtime?.phoneTools?.active || 0) > 0 || Number(runtime?.voiceProcessor?.active || 0) > 0 || Number(runtime?.voiceOutput?.active || 0) > 0
    || Number(runtime?.biliBrowser?.status?.active || 0) > 0 || runtime?.biliBrowser?.cleanupPending === true
    || Number(runtime?.douyinBrowser?.active || 0) > 0 || runtime?.douyinBrowser?.cleanupPending === true;
  const runtimeBusy = () => runtime?.socialAccounts?.busy === true || companionBusy() || capabilityBusy() || Number(diagnostics?.active || 0) > 0 || social?.checking === true;
  const systemBusy = () => runtimeBusy() || dependencies?.snapshot().busy === true;
  const runtimePlugin = { name: 'dafeiyu-runtime', inject,
    async apply(childCtx, childConfig) { runtime = await createCompanion(childCtx, childConfig, { capabilities, controlAccess }); } };
  const loadRuntime = async () => {
    if (stopped) throw new ConfigStoreError('UNAVAILABLE', '伴侣设置已停止');
    if (systemBusy()) {
      throw new ConfigStoreError('BUSY', '正在回复 QQ 或应用配置，请稍后再试');
    }
    const snapshot = store.snapshot();
    if (snapshot.validationErrors.length) throw new ConfigStoreError('INVALID_CONFIG', '请先修正配置错误',
      { validationErrors: snapshot.validationErrors });
    applying = true;
    try {
      const previous = child;
      child = null;
      await disposeCapabilityContext();
      // The runtime disposer revokes tools/transport immediately and waits for its own work.
      await runtime?.dispose();
      if (previous) await previous.dispose();
      runtime = null;
      runtimeError = false;
      if (stopped) throw new ConfigStoreError('UNAVAILABLE', '伴侣设置已停止');
      child = ctx.plugin(runtimePlugin, options);
      await child;
      if (!runtime || stopped) throw new ConfigStoreError('UNAVAILABLE', '伴侣未能完成启动');
      appliedRevision = snapshot.revision;
      appliedSettings = snapshot.effective;
    } catch (error) {
      runtimeError = true;
      if (child) await child.dispose().catch(() => {});
      child = null;
      runtime = null;
      appliedSettings = null;
      if (error instanceof ConfigStoreError) throw error;
      throw new ConfigStoreError('APPLY_FAILED', '伴侣启动失败，配置已保留，请检查后重新应用');
    } finally { applying = false; }
  };
  const panelPaths = () => readablePaths(configFile, config);
  const napcat = new NapCatPanel({ getExpectedSelfId: () => String(appliedSettings?.onebotSelfId || store.snapshot().effective.onebotSelfId || '') });
  const library = new PanelLibrary({ getRuntime: () => runtime, paths: panelPaths });
  const memoryPanel = new MemoryPanelController({ getRuntime: () => runtime, isBusy: systemBusy });
  const model = new ModelPanel({ getService: (name) => ctx.get?.(name), getBusy: systemBusy,
    getConnectionTestStatus: () => ({ available: Boolean(runtime?.modelTests), busy: runtime?.modelTests?.busy === true, blocked: runtime?.modelTests?.blocked === true }),
    runConnectionTest: (body, options) => {
      if (!runtime?.modelTests) throw new Error('模型测试尚未就绪');
      return runtime.modelTests.run(body, options);
    } });
  dependencies = new DependencyPanel({ getRuntime: () => runtime, getConfig: () => appliedSettings || store.snapshot().effective,
    napcatPanel: napcat, getBusy: runtimeBusy, acquireMaintenance: () => runtime ? runtime.beginMaintenance() : () => {},
    getVoiceStatus: () => {
      const speech = model.speechSnapshot();
      const selected = speech.providers.find((provider) => provider.id === speech.selection?.providerId);
      return { receiveConfigured: Boolean(speech.available && speech.providers.length),
        receiveReady: Boolean(selected && ['ready', 'standby'].includes(selected.preparation.phase)) };
    } });
  const voice = new VoicePanel({ store, getRuntime: () => runtime, getBusy: systemBusy });
  social = new SocialPanel({ getRuntime: () => runtime, getBusy: systemBusy,
    probeDouyin: async ({ runtime: expected, authorize, signal }) => {
      const context = await resolveCapabilityContext(expected, { authorize, signal });
      return controlAccess.runProbe({ ...context, runtime: expected, authorize, signal }, 'browser',
        () => expected.douyinBrowser.probe({ agent: context.agent, authorize, signal }));
    } });
  diagnostics = new RuntimeDiagnostics({ getRuntime: () => runtime, getBusy: () => companionBusy() || dependencies?.snapshot().busy === true });
  hostCapabilities = createHostCapabilityAdapter({ ctx, getRuntime: () => runtime, resolveContext: resolveCapabilityContext,
    nativeControl: createNativeControlBackend({ ctx, access: controlAccess, trace: (event) => {
      try {
        const directory = path.join(path.dirname(configFile), 'data/capabilities');
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const target = path.join(directory, 'control-trace.private.jsonl');
        if (fs.existsSync(target) && fs.statSync(target).size > 65536) fs.writeFileSync(target, '', { mode: 0o600 });
        fs.appendFileSync(target, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
      } catch {}
    } }) });
  const getHostCapabilities = () => hostCapabilities.snapshot();
  getHostCapabilities.refresh = (options) => hostCapabilities.refresh(options);
  capabilities = new CapabilityRegistry({ getRuntime: capabilityRuntime, getHost: getHostCapabilities,
    controlBackend: 'dsh-plugins',
    probes: createCapabilityProbes({ host: hostCapabilities, nativeControl: true }), timeoutMs: 60000,
    storeFile: path.join(path.dirname(configFile), 'data/capabilities/verification.json') });
  const panel = new ConfigurationPanelController({ store, getRuntime: () => runtime, napcat, library, model, dependencies, voice, social, diagnostics, memory: memoryPanel, capabilities,
    getModelInfo: () => ({ defaultSelection: model.describe().selection, activeSelection: runtime?.nativeOneBot?.status?.modelSelection || null }),
    getMaintenanceBusy: () => dependencies.snapshot().busy,
    getAppliedRevision: () => appliedRevision, getAppliedSettings: () => appliedSettings, getApplying: () => applying,
    getRuntimeError: () => runtimeError, apply: typeof ctx.plugin === 'function' ? loadRuntime : undefined,
    paths: panelPaths });
  registerConfigPanel(ctx, panel);
  ctx.effect?.(() => async () => { stopped = true; capabilities.dispose(); hostCapabilities.dispose(); await disposeCapabilityContext();
    diagnostics.dispose(); await dependencies.dispose(); napcat.dispose?.(); await runtime?.dispose(); await controlAccess.dispose(); });
  if (typeof ctx.plugin !== 'function') {
    runtime = await createCompanion(ctx, options, { capabilities, controlAccess });
    appliedRevision = store.snapshot().revision;
    appliedSettings = store.snapshot().effective;
  } else {
    try { await loadRuntime(); }
    catch { runtimeError = true; (ctx.logger || console).warn?.('[dsh-dafeiyu] 伴侣未启动，可在大肥鱼设置中检查并重新应用'); }
  }
}

export default { name, inject, apply };
