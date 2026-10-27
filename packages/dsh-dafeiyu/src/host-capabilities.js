import { randomUUID } from 'node:crypto';

const KINDS = ['computer', 'desktop', 'browser', 'web'];
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,159}$/;
const RELEVANT_SKILLS = new Set(['computer-use', 'ego-browser']);
const SAFE_ERRORS = new Set(['disposed', 'cancelled', 'unauthorized', 'runtime-changed', 'scope-unavailable',
  'tools-unavailable', 'invalid-command', 'bash-unavailable', 'busy', 'invalid-signal', 'command-promoted', 'cleanup-unconfirmed',
  'ACCESSIBILITY_REQUIRED', 'DESKTOP_TARGET_UNCONFIRMED']);
const TERMINAL_JOBS = new Set(['completed', 'failed', 'killed']);
const REASONS = Object.freeze({ unchecked: '尚未检测当前宿主作用域', scope: '当前宿主检测作用域不可用',
  missing: '当前 Agent 未提供所需工具或技能', registered: '当前 Agent 工具可见，尚未执行验证',
  instructions: '技能可见；命令与实际操作能力尚未验证', metadata: '命令可调用，尚未验证实际界面操作',
  verified: '已通过当前宿主工具执行验证', denied: '宿主工具权限或执行策略阻止了检测',
  failed: '检测未成功，实际操作能力尚未确认', incomplete: '技能发现未完成，不能确认能力缺失' });
const clone = (value) => JSON.parse(JSON.stringify(value));
const initial = () => Object.fromEntries(KINDS.map((kind) => [kind, { present: null, available: null, reason: REASONS.unchecked }]));
const fault = (code) => Object.assign(new Error(code), { code });
const aborted = (signal) => signal?.aborted === true;
const versionOf = (text) => {
  if (typeof text !== 'string' || text.length > 16384) return null;
  const match = /(?:^|[\s:v])([0-9]{1,4}\.[0-9]{1,4}(?:\.[0-9]{1,8})?(?:-[A-Za-z0-9.-]{1,40})?)(?=$|[\s)])/m.exec(text);
  return match?.[1] ?? null;
};
const bashValue = (result) => result?.isError === false && result.value && result.value.exitCode === 0
  && result.value.timedOut !== true && result.value.aborted !== true && !result.value.signal
  && result.value.sandbox?.denied !== true && result.value.sandbox?.runnerFailed !== true ? result.value : null;
const fixedProbeFailure = (result) => {
  const value = result?.value;
  if (result?.isError !== false || !value || !Number.isInteger(value.exitCode) || value.exitCode === 0
    || value.timedOut !== false || value.aborted !== false || value.signal !== null
    || value.sandbox !== undefined && (value.sandbox?.denied !== false || value.sandbox?.runnerFailed === true)
    || value.stdout?.truncated !== false || typeof value.stdout.text !== 'string' || value.stdout.text.length > 64) return null;
  return /^DFY_CAPABILITY_FAILURE (UNAVAILABLE|UNCONFIRMED|FAILED|ACCESSIBILITY_REQUIRED|DESKTOP_INIT_UNCONFIRMED|DESKTOP_TARGET_UNCONFIRMED)\r?\n?$/.exec(value.stdout.text)?.[1] ?? null;
};

/** DSH same-process adapter. No RPC, raw tool body, model turn or direct process
 * spawning is used. resolveContext must return a registered isolated standard
 * Agent under owner authorization. snapshot never touches services or the OS.
 * executeCommand is an internal JS API: never bind arbitrary HTTP input to it.
 */
export function createHostCapabilityAdapter({ ctx, getRuntime, resolveContext, now = Date.now,
  probeCommands = {}, nativeControl } = {}) {
  let cached = { ...initial(), checkedAt: null, tools: [], skills: [], skillsComplete: null };
  let revision = 0, disposed = false, busy = false, activeController, cachedRuntime, protectedJob;
  const tests = new Map(Object.entries(probeCommands).filter(([id, value]) => /^[a-z][a-z0-9_-]{0,79}$/.test(id)
    && value && typeof value.command === 'string' && KINDS.includes(value.capability) && typeof value.project === 'function')
    .map(([id, value]) => [id, Object.freeze({ ...value })]));
  const service = (carrier, name) => typeof carrier?.get === 'function' ? carrier.get(name) : undefined;
  const assertAuthorization = (authorize, signal, runtime) => {
    if (disposed) throw fault('disposed');
    if (aborted(signal)) throw fault('cancelled');
    let allowed = false;
    try { allowed = typeof authorize === 'function' && authorize() === true; } catch {}
    if (!allowed) throw fault('unauthorized');
    if (runtime !== undefined && getRuntime?.() !== runtime) throw fault('runtime-changed');
  };
  async function begin({ authorize, signal } = {}) {
    assertAuthorization(authorize, signal);
    const runtime = getRuntime?.();
    if (!runtime || typeof resolveContext !== 'function') throw fault('scope-unavailable');
    const context = await resolveContext(runtime, { authorize, signal });
    assertAuthorization(authorize, signal, runtime);
    const agent = context?.agent;
    const agents = service(ctx, 'agents');
    if (context?.isOwner !== true || !agent || typeof agent.id !== 'string' || agent.session?.id !== agent.id
      || agents?.get?.(agent.id) !== agent || typeof agent.ctx?.get !== 'function') throw fault('scope-unavailable');
    const tools = service(agent.ctx, 'tools');
    if (typeof tools?.schemas !== 'function' || typeof tools?.execute !== 'function') throw fault('tools-unavailable');
    return { runtime, agent, tools, cwd: context.cwd, authorize, signal };
  }
  function stillCurrent(current) {
    assertAuthorization(current.authorize, current.signal, current.runtime);
    if (service(ctx, 'agents')?.get?.(current.agent.id) !== current.agent) throw fault('scope-unavailable');
  }
  const ownedJob = (view, job) => view?.id === job.id && view.owner === job.owner && view.kind === 'bash';
  function releaseTerminalJob(job, { remove = true } = {}) {
    let view;
    try { view = job.jobs?.get?.(job.id, job.owner); } catch { return false; }
    if (!ownedJob(view, job) || !TERMINAL_JOBS.has(view.status)) return false;
    // Removing a proven terminal record is housekeeping, not termination proof.
    if (remove) try { job.jobs.remove?.(job.id, job.owner); } catch {}
    if (protectedJob === job) protectedJob = undefined;
    return true;
  }
  async function stopPromoted(current, value) {
    const job = { id: value.jobId, owner: current.agent.id, jobs: service(current.agent.ctx, 'jobs') };
    protectedJob = job;
    if (typeof job.id !== 'string' || !job.id || job.id.length > 160 || typeof job.jobs?.get !== 'function'
      || typeof job.jobs?.wait !== 'function' || typeof job.jobs?.kill !== 'function') throw fault('cleanup-unconfirmed');
    let view;
    try { view = job.jobs.get(job.id, job.owner); } catch { throw fault('cleanup-unconfirmed'); }
    if (!ownedJob(view, job)) throw fault('cleanup-unconfirmed');
    if (releaseTerminalJob(job)) throw fault('command-promoted');
    // Match the Bash tool's own stop contract. Register the awaited settlement
    // before cancellation so this isolated test cannot wake a model on finish.
    // Cleanup deliberately outlives the caller's now-aborted execution signal.
    let waiting;
    try { waiting = Promise.resolve(job.jobs.wait(job.id, 5000, job.owner)).then((result) => ({ result }), () => ({})); }
    catch { throw fault('cleanup-unconfirmed'); }
    try { job.jobs.kill(job.id, job.owner, 'capability command exceeded foreground deadline'); } catch {}
    const settled = await waiting;
    if (!ownedJob(settled.result, job) || !TERMINAL_JOBS.has(settled.result.status) || !releaseTerminalJob(job))
      throw fault('cleanup-unconfirmed');
    // Promotion is a failed check even if it happened to complete before kill.
    // Do not start another CLI or infer a successful capability from its output.
    throw fault('command-promoted');
  }
  async function discoverIn(current) {
    const schemas = current.tools.schemas(current.agent);
    if (!Array.isArray(schemas)) throw fault('tools-unavailable');
    const tools = [...new Set(schemas.map((schema) => schema?.name).filter((name) => typeof name === 'string' && TOOL_NAME.test(name)))].sort();
    let skillNames = [], complete = null;
    const skills = service(current.agent.ctx, 'skills');
    if (typeof skills?.snapshot === 'function') {
      const observation = await skills.snapshot({ scope: current.agent, ...(current.cwd ? { cwd: current.cwd } : {}), signal: current.signal });
      stillCurrent(current);
      complete = observation?.complete === true;
      if (Array.isArray(observation?.skills)) skillNames = [...new Set(observation.skills
        .filter((skill) => RELEVANT_SKILLS.has(skill?.name) && skill.invocation?.modelInvocable !== false)
        .map((skill) => skill.name))].sort();
    }
    stillCurrent(current);
    const hasBash = tools.includes('bash'), hasFiles = tools.includes('read') || tools.includes('write') || tools.includes('edit');
    const make = (present, reason = REASONS.registered) => ({ present, available: present === false ? false : null,
      reason: present === false ? REASONS.missing : reason });
    const skillCapability = (name) => skillNames.includes(name) && hasBash ? make(true, REASONS.instructions)
      : complete === true || !hasBash ? make(false) : make(null, REASONS.incomplete);
    const discovered = { computer: make(hasBash || hasFiles), desktop: skillCapability('computer-use'),
      browser: skillCapability('ego-browser'), web: make(tools.includes('web_search') || tools.includes('web_fetch')),
      checkedAt: now(), tools, skills: skillNames, skillsComplete: complete };
    if (nativeControl) Object.assign(discovered, nativeControl.metadata(current));
    return discovered;
  }
  async function commandIn(current, command, description = 'Check host capability without changing user data', timeoutMs = 10000) {
    if (typeof command !== 'string' || !command.trim() || command.length > 64000 || command.includes('\0')) throw fault('invalid-command');
    stillCurrent(current);
    // Never manufacture a parent token to bypass PTC presentation restrictions.
    if (!current.tools.schemas(current.agent).some((schema) => schema?.name === 'bash')) throw fault('bash-unavailable');
    const signal = current.signal ?? new AbortController().signal;
    const result = await current.tools.execute({ name: 'bash', arguments: { description, command,
      ...(current.cwd ? { workdir: current.cwd } : {}), timeoutMs }, agent: current.agent,
      callId: 'dafeiyu-capability-' + randomUUID(), signal });
    if (result?.isError === false && result.value?.kind === 'promoted') await stopPromoted(current, result.value);
    stillCurrent(current);
    return result;
  }
  async function exclusive(options, operation) {
    assertAuthorization(options?.authorize, options?.signal);
    if (options.signal !== undefined && (typeof options.signal?.addEventListener !== 'function'
      || typeof options.signal?.removeEventListener !== 'function' || typeof options.signal?.aborted !== 'boolean')) throw fault('invalid-signal');
    if (busy) throw fault('busy');
    if (protectedJob && !releaseTerminalJob(protectedJob)) throw fault('cleanup-unconfirmed');
    busy = true;
    const start = ++revision;
    const controller = new AbortController();
    const forward = () => controller.abort();
    options.signal?.addEventListener('abort', forward, { once: true });
    if (options.signal?.aborted) forward();
    activeController = controller;
    try {
      const current = await begin({ ...options, signal: controller.signal });
      const result = await operation(current);
      stillCurrent(current);
      if (start !== revision) throw fault('runtime-changed');
      return result;
    } catch (error) {
      throw SAFE_ERRORS.has(error?.code) ? fault(error.code) : fault('host-unavailable');
    } finally {
      options.signal?.removeEventListener('abort', forward);
      if (activeController === controller) activeController = undefined;
      busy = false;
    }
  }
  return Object.freeze({
    snapshot() {
      // The runtime getter is a local reference read, never a service/CLI probe.
      // A hot-replaced runtime cannot inherit an earlier Agent's proof.
      // Local registry get is a memory-only owner-checked observation. A GET
      // never cancels, waits, removes a job, or starts another command.
      if (protectedJob) releaseTerminalJob(protectedJob, { remove: false });
      if (protectedJob) return { ...Object.fromEntries(KINDS.map((kind) => [kind, { present: null, available: null,
        reason: '此前检测的后台进程尚未确认停止，已暂停后续检测' }])), checkedAt: null,
        tools: [], skills: [], skillsComplete: null, busy: true, cleanupPending: true };
      if (cachedRuntime !== undefined && getRuntime?.() !== cachedRuntime)
        return { ...initial(), checkedAt: null, tools: [], skills: [], skillsComplete: null };
      return clone(cached);
    },
    get busy() { return busy || Boolean(protectedJob); },
    async discover(options = {}) {
      return exclusive(options, async (current) => {
        const next = await discoverIn(current);
        stillCurrent(current); cached = next; cachedRuntime = current.runtime;
        return clone(cached);
      });
    },
    async refresh(options = {}) {
      return exclusive(options, async (current) => {
        const next = await discoverIn(current);
        if (next.tools.includes('bash')) {
          const terminal = await commandIn(current, "printf 'DSH_CAPABILITY_TERMINAL_OK\\n'");
          const value = bashValue(terminal);
          next.computer.available = Boolean(value?.stdout?.text === 'DSH_CAPABILITY_TERMINAL_OK\n');
          next.computer.reason = next.computer.available ? REASONS.verified : terminal?.isError ? REASONS.denied : REASONS.failed;
          // Only metadata is executed here. These cannot certify click/type or
          // actual browser automation, even when permissions say granted.
          for (const [kind, command] of [['browser', 'ego-browser --version'], ['desktop', 'orca computer capabilities --json']]) {
            if (nativeControl) continue;
            if (next[kind].present !== true) continue;
            const result = await commandIn(current, command);
            let output = bashValue(result);
            let guideDetected = false;
            if (kind === 'browser' && !output) {
              const guide = bashValue(await commandIn(current, 'ego-browser skill'));
              guideDetected = typeof guide?.stdout?.text === 'string' && guide.stdout.text.length <= 64000
                && guide.stdout.text.includes('[ego-browser:skill] end of guide');
              if (guideDetected) output = guide;
            }
            let version = kind === 'browser' && !guideDetected ? versionOf(output?.stdout?.text) : null;
            next[kind] = { ...next[kind], available: null, reason: output ? REASONS.metadata : result?.isError ? REASONS.denied : REASONS.failed,
              cliPresent: output ? true : null, ...(version ? { version } : {}) };
            if (kind === 'desktop' && output) {
              let capabilities;
              try { capabilities = JSON.parse(output.stdout?.text); } catch {}
              if (capabilities?.ok === true && capabilities.result?.platform === 'darwin'
                && capabilities.result?.provider === 'orca-computer-use-macos') {
                next.desktop.metadata = { screenshotSupported: capabilities.result.supports?.observation?.screenshot === true,
                  clickSupported: capabilities.result.supports?.actions?.click === true,
                  typeTextSupported: capabilities.result.supports?.actions?.typeText === true };
                const permissionResult = bashValue(await commandIn(current, 'orca computer permissions --json'));
                let permissions;
                try { permissions = JSON.parse(permissionResult?.stdout?.text); } catch {}
                if (permissions?.ok === true && Array.isArray(permissions.result?.permissions)) {
                  next.desktop.metadata.accessibilityGranted = permissions.result.permissions.some((row) => row?.id === 'accessibility' && row.status === 'granted');
                  next.desktop.metadata.screenshotsGranted = permissions.result.permissions.some((row) => row?.id === 'screenshots' && row.status === 'granted');
                }
              }
            }
          }
        }
        stillCurrent(current); cached = next; cachedRuntime = current.runtime;
        return clone(cached);
      });
    },
    async probeControl(id, options = {}) {
      if (!nativeControl || !['desktop', 'browser'].includes(id)) throw fault('unknown-test');
      return exclusive(options, async (current) => nativeControl.probe(id, current));
    },
    /** Internal-only stdout for fixed proof parsing, never an HTTP tool API. */
    async executeCommand(command, options = {}) {
      const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1000, Math.min(60000, Math.trunc(options.timeoutMs))) : 10000;
      return exclusive(options, async (current) => {
        const result = await commandIn(current, command, undefined, timeoutMs);
        const value = bashValue(result);
        const failureCode = fixedProbeFailure(result);
        if (failureCode) return { ok: false, stdout: '', exitCode: result.value.exitCode, code: failureCode };
        if (!value || typeof value.stdout?.text !== 'string' || value.stdout.text.length > 64000 || value.stdout.truncated === true)
          return { ok: false, stdout: '', exitCode: Number.isInteger(result?.value?.exitCode) ? result.value.exitCode : null,
            code: result?.isError ? 'host-denied' : 'invalid-result' };
        return { ok: true, stdout: value.stdout.text, exitCode: 0 };
      });
    },
    /** Tests are constructor-owned fixed commands, never caller tool args. */
    async executeNativeTool({ testId, ...options } = {}) {
      const test = tests.get(testId);
      if (!test) throw fault('unknown-test');
      return exclusive(options, async (current) => {
        const next = await discoverIn(current);
        const result = await commandIn(current, test.command);
        const accepted = result?.isError === false && test.project(result) === true;
        stillCurrent(current);
        next[test.capability] = { ...next[test.capability], available: accepted, reason: accepted ? REASONS.verified : REASONS.failed };
        cached = next; cachedRuntime = current.runtime;
        return { ok: accepted, capability: test.capability, snapshot: clone(cached) };
      });
    },
    dispose() { disposed = true; revision++; activeController?.abort(); cachedRuntime = undefined;
      cached = { ...initial(), checkedAt: null, tools: [], skills: [], skillsComplete: null }; },
  });
}

export default createHostCapabilityAdapter;
