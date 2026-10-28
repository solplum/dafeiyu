import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PublishError, PublishJournal, canonical, hash } from './publish-journal.mjs';
import { probeVideo } from './douyin-publisher.mjs';

const PLATFORM = 'bilibili';
const BVID = /^BV[A-Za-z0-9]{10}$/;
const MID = /^[1-9][0-9]{0,19}$/;
const VIDEO = ['.mp4', '.mov', '.m4v', '.mkv', '.flv', '.webm'];
const COVER = ['.png', '.jpg', '.jpeg', '.webp'];
const simpleObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype);
const keysAre = (value, keys) => simpleObject(value) && Object.keys(value).length === keys.length
  && Object.keys(value).every((key) => keys.includes(key));

function privateDirectory(directory) {
  const resolved = path.resolve(directory);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(resolved).isSymbolicLink() || fs.realpathSync(resolved) !== resolved) throw new PublishError('INVALID_DIRECTORY', '请使用独立的本机目录');
  fs.chmodSync(resolved, 0o700);
  return resolved;
}

async function fileIdentity(file, roots, extensions, maximum) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || fs.lstatSync(file).isSymbolicLink()) throw new PublishError('INVALID_ASSET', '请选择本机普通文件的绝对路径');
  const resolved = fs.realpathSync(file);
  if (roots.length && !roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) throw new PublishError('INVALID_ASSET', '媒体文件不在本次授权的目录内');
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size <= 0 || before.size > maximum || extensions && !extensions.includes(path.extname(resolved).toLowerCase())) throw new PublishError('INVALID_ASSET', '文件格式或大小无效');
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(resolved, { fd, autoClose: false })) digest.update(chunk);
    const after = fs.fstatSync(fd), current = fs.statSync(resolved);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino
      || current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs) throw new PublishError('ASSET_CHANGED', '读取期间文件已变化，请重新准备');
    return { path: resolved, sha256: digest.digest('hex'), bytes: before.size };
  } finally { fs.closeSync(fd); }
}

function metadata(input) {
  if (!simpleObject(input) || Object.keys(input).some((key) => !['video', 'cover', 'title', 'description', 'tags', 'tid', 'copyright', 'source'].includes(key))) throw new PublishError('INVALID_DRAFT', '稿件字段无效');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || [...title].length > 80 || /[\x00-\x1f\x7f]/.test(title)) throw new PublishError('INVALID_DRAFT', '标题需要1至80个普通字符');
  const description = input.description ?? '';
  if (typeof description !== 'string' || description.length > 2000 || /[\x00\x0b\x0c\x7f]/.test(description)) throw new PublishError('INVALID_DRAFT', '简介格式或长度无效');
  const tags = input.tags ?? [];
  if (!Array.isArray(tags) || !tags.length || tags.length > 10 || new Set(tags).size !== tags.length
    || tags.some((tag) => typeof tag !== 'string' || !tag || tag.length > 30 || /[,\x00-\x1f\x7f]/.test(tag))) throw new PublishError('INVALID_DRAFT', '请填写1至10个不重复的普通标签');
  if (!Number.isInteger(input.tid) || input.tid < 1 || input.tid > 65535) throw new PublishError('INVALID_DRAFT', '请选择有效的投稿分区');
  const copyright = input.copyright ?? 1, source = input.source ?? '';
  if (![1, 2].includes(copyright) || typeof source !== 'string' || source.length > 1000 || /[\x00-\x1f\x7f]/.test(source)
    || copyright === 2 && !source.trim() || copyright === 1 && source !== '') throw new PublishError('INVALID_DRAFT', '请确认自制或转载，并为转载填写来源');
  return { title, description, tags: [...tags], tid: input.tid, copyright, source };
}

function receiptAt(file) {
  if (fs.lstatSync(file).isSymbolicLink()) throw new PublishError('INVALID_RECEIPT', '回执必须为本次普通文件');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 4096 || process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) throw new PublishError('INVALID_RECEIPT', '回执文件权限或大小无效');
    const result = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!keysAre(result, ['code', 'data']) || result.code !== 0 || !keysAre(result.data, ['aid', 'bvid'])
      || !Number.isSafeInteger(result.data.aid) || result.data.aid <= 0 || typeof result.data.bvid !== 'string'
      || !BVID.test(result.data.bvid)) throw new PublishError('INVALID_RECEIPT', '没有本次稿件的精确平台回执');
    return { code: 0, aid: result.data.aid, bvid: result.data.bvid };
  } finally { fs.closeSync(fd); }
}

function claim(file, record) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ platform: PLATFORM, id: record.id, accountId: record.accountId, at: new Date().toISOString() })); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

/** No stdout parsing: only the private exact receipt can prove submission. */
export function runBiliup({ binary, args, cwd, home, signal, timeoutMs = 300000 }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new PublishError('ABORTED', '操作已取消')); return; }
    let child, settled = false, timer, killTimer, abandonTimer, stopped = false;
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(abandonTimer);
      signal?.removeEventListener('abort', stop);
      if (error) reject(error); else resolve(value);
    };
    const stop = () => {
      if (stopped) return; stopped = true;
      try { child?.kill('SIGTERM'); } catch { /* Preserve unknown. */ }
      killTimer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* Preserve unknown. */ } }, 2000);
      abandonTimer = setTimeout(() => finish(new PublishError('CLEANUP_UNKNOWN', '子进程停止尚未确认')), 6000);
    };
    try {
      child = spawn(binary, args, { cwd, shell: false, stdio: 'ignore', windowsHide: true,
        env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, LANG: 'zh_CN.UTF-8', RUST_LOG: 'off' } });
      child.once('error', () => finish(new PublishError('EXECUTION_UNKNOWN', '投稿进程未获得确定结果')));
      child.once('close', (exitCode, exitSignal) => finish(null, { exitCode, exitSignal, closed: true, cancelled: stopped }));
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      timer = setTimeout(stop, timeoutMs);
    } catch { finish(new PublishError('EXECUTION_UNKNOWN', '投稿进程未获得确定结果')); }
  });
}

export class BiliupPublisher {
  constructor({ directory, mediaRoots = [], binary = '', binarySha256 = '', getAccount = () => null,
    authorize = () => false, run = runBiliup, query = null, probe = probeVideo, timeoutMs = 300000 } = {}) {
    this.directory = privateDirectory(directory); this.journal = new PublishJournal(path.join(this.directory, 'journal'));
    this.jobs = privateDirectory(path.join(this.directory, 'jobs'));
    this.mediaRoots = mediaRoots.map((root) => fs.realpathSync(root));
    Object.assign(this, { binary, binarySha256, getAccount, authorize, run, queryDriver: query, probe, timeoutMs });
  }
  #view(record, note = record.note || '') {
    return { id: record.id, platform: PLATFORM, accountId: record.accountId || null,
      state: record.state === 'dispatching' ? 'unknown' : record.state, approvalDigest: record.id,
      title: record.metadata.title, description: record.metadata.description, tags: [...record.metadata.tags], tid: record.metadata.tid,
      copyright: record.metadata.copyright, source: record.metadata.source, videoName: path.basename(record.video.path),
      media: record.media && { duration: record.media.duration, width: record.media.width, height: record.media.height },
      coverName: record.cover ? path.basename(record.cover.path) : null, receipt: record.receipt && { ...record.receipt },
      reviewStatus: record.reviewStatus || 'not-submitted', note,
      url: record.receipt?.bvid ? 'https://www.bilibili.com/video/' + record.receipt.bvid : null };
  }
  #read(id) {
    const record = this.journal.read(id);
    if (record.platform !== PLATFORM || record.id !== id) throw new PublishError('INVALID_JOURNAL', '稿件不属于本平台任务');
    return record;
  }
  #authorized(record, action, digest = record.id) {
    if (digest !== record.id || this.authorize({ platform: PLATFORM, accountId: record.accountId || null, action, approvalDigest: record.id }) !== true) throw new PublishError('FORBIDDEN', '本次稿件和账号尚未获明确授权');
  }
  #account(record) {
    const account = this.getAccount();
    if (!account || account.verified !== true || typeof account.mid !== 'string' || !MID.test(account.mid) || !account.cookieFile) return null;
    if (record && account.mid !== record.accountId) throw new PublishError('ACCOUNT_MISMATCH', '当前独立账号与准备稿件的账号不一致');
    return { mid: account.mid, cookieFile: account.cookieFile };
  }
  #sameAccount(record, expected) {
    const current = this.#account(record);
    if (!current || current.mid !== expected.mid || current.cookieFile !== expected.cookieFile) throw new PublishError('ACCOUNT_MISMATCH', '投稿期间账号已变化');
  }
  async prepare(input) {
    const meta = metadata(input);
    if (this.authorize({ platform: PLATFORM, action: 'prepare', accountId: null, approvalDigest: null }) !== true) throw new PublishError('FORBIDDEN', '尚未获稿件准备权限');
    const video = await fileIdentity(input.video, this.mediaRoots, VIDEO, 10 * 1024 * 1024 * 1024);
    const cover = input.cover ? await fileIdentity(input.cover, this.mediaRoots, COVER, 20 * 1024 * 1024) : null;
    let probed;
    try { probed = await this.probe(video.path); }
    catch { throw new PublishError('INVALID_VIDEO', '无法读取有效视频轨道，请检查视频文件和检查组件'); }
    if (!Number.isFinite(probed?.duration) || probed.duration <= 0 || !Number.isInteger(probed.width) || probed.width <= 0
      || !Number.isInteger(probed.height) || probed.height <= 0) throw new PublishError('INVALID_VIDEO', '视频需要可读取的视频轨道、有效时长和画面尺寸');
    const media = { duration: probed.duration, width: probed.width, height: probed.height };
    const checked = await fileIdentity(video.path, this.mediaRoots, VIDEO, 10 * 1024 * 1024 * 1024);
    if (checked.sha256 !== video.sha256 || checked.bytes !== video.bytes) throw new PublishError('ASSET_CHANGED', '视频在检查期间已变化，请重新准备');
    const account = this.#account(), accountId = account?.mid || null;
    const id = hash(canonical({ platform: PLATFORM, accountId, video: video.sha256, cover: cover?.sha256 || null, metadata: meta }));
    const record = { id, platform: PLATFORM, accountId, metadata: meta, video, cover, media, state: 'prepared', receipt: null,
      history: [{ state: 'prepared', at: new Date().toISOString() }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.#authorized(record, 'prepare');
    return this.#view(this.journal.create(id, record), account ? '稿件已准备，尚未投稿' : '稿件已准备；尚未绑定独立B站账号，不会上传或投稿');
  }
  preview(id) { const record = this.#read(id); this.#authorized(record, 'preview'); return this.#view(record); }
  async #unchanged(record) {
    const video = await fileIdentity(record.video.path, this.mediaRoots, VIDEO, 10 * 1024 * 1024 * 1024);
    if (video.sha256 !== record.video.sha256 || video.bytes !== record.video.bytes) throw new PublishError('ASSET_CHANGED', '视频已变化，请重新准备');
    if (record.cover) {
      const cover = await fileIdentity(record.cover.path, this.mediaRoots, COVER, 20 * 1024 * 1024);
      if (cover.sha256 !== record.cover.sha256 || cover.bytes !== record.cover.bytes) throw new PublishError('ASSET_CHANGED', '封面已变化，请重新准备');
    }
  }
  async #preflight(account) {
    if (!this.binary || !/^[a-f0-9]{64}$/.test(this.binarySha256)) throw new PublishError('BINARY_REQUIRED', '受管投稿CLI尚未准备好');
    const binary = await fileIdentity(this.binary, [], null, 1024 * 1024 * 1024);
    if (binary.sha256 !== this.binarySha256) throw new PublishError('BINARY_CHANGED', '投稿CLI已变化，请重新核验安装');
    this.#credential(account);
  }
  #credential(account) {
    if (!path.isAbsolute(account.cookieFile) || fs.lstatSync(account.cookieFile).isSymbolicLink()
      || fs.realpathSync(account.cookieFile) !== account.cookieFile) throw new PublishError('ACCOUNT_REQUIRED', '请使用本账号的独立凭据文件');
    const fd = fs.openSync(account.cookieFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size <= 0 || stat.size > 65536 || process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new PublishError('ACCOUNT_REQUIRED', '独立凭据文件尚未准备好');
      let credential;
      try { credential = JSON.parse(fs.readFileSync(fd, 'utf8')); }
      catch { throw new PublishError('ACCOUNT_REQUIRED', '独立凭据文件尚未准备好'); }
      const mid = credential?.token_info?.mid;
      const cookieUid = credential?.cookie_info?.cookies?.find((item) => item.name === 'DedeUserID')?.value;
      if (!Number.isSafeInteger(mid) || mid <= 0 || String(mid) !== account.mid || String(cookieUid) !== account.mid) throw new PublishError('ACCOUNT_MISMATCH', '独立凭据与已核验账号不一致');
    } finally { fs.closeSync(fd); }
  }
  #unknown(id, note = '投稿结果未知，请核对创作中心；不会自动重投') {
    try {
      const record = this.journal.update(id, 'unknown', { note });
      if (this.authorize({ platform: PLATFORM, accountId: record.accountId || null, action: 'preview', approvalDigest: id }) !== true) return { id, platform: PLATFORM, state: 'unknown', note: '授权已失效，执行结果保留供主人核对；不会重投' };
      return this.#view(record);
    }
    catch { return { id, platform: PLATFORM, state: 'unknown', approvalDigest: id, note: '执行或日志结果未知，请人工核对；不会自动重投' }; }
  }
  #args(record, account, receiptFile) {
    return ['--user-cookie', account.cookieFile, '--rust-log', 'off', 'upload', '--receipt-file', receiptFile,
      '--submit', 'web', '--limit', '1', '--title', record.metadata.title, '--tid', String(record.metadata.tid),
      '--tag', record.metadata.tags.join(','), '--desc', record.metadata.description, '--copyright', String(record.metadata.copyright),
      ...(record.metadata.source ? ['--source', record.metadata.source] : []), ...(record.cover ? ['--cover', record.cover.path] : []), record.video.path];
  }
  async submit(id, approvalDigest, { signal } = {}) {
    const start = this.#read(id); this.#authorized(start, 'submit', approvalDigest);
    if (start.state !== 'prepared') return this.#view(start, '该任务已尝试提交或已取得结果，不会重复执行');
    const account = this.#account(start);
    if (!account || !start.accountId) return this.#view(start, '尚未绑定并核验独立B站账号，稿件保留准备状态，不会上传或投稿');
    return this.journal.accountLock(PLATFORM, account.mid, async () => {
      let record = this.#read(id), claimed = false;
      if (record.state !== 'prepared') return this.#view(record, '该任务已处理，不会重复执行');
      try {
        await this.#unchanged(record); await this.#preflight(account);
        this.#authorized(record, 'submit', approvalDigest); this.#sameAccount(record, account);
        if (signal?.aborted) return this.#view(record, '操作已取消，尚未启动投稿');
        const job = privateDirectory(path.join(this.jobs, id)), home = privateDirectory(path.join(job, 'home'));
        const receiptFile = path.join(job, 'receipt.json'), claimFile = this.journal.claimFile(id);
        if (fs.existsSync(receiptFile) || fs.existsSync(claimFile)) return this.#unknown(id, '本任务已有提交证明或回执，请先核对；不会再次启动投稿');
        claimed = true; claim(claimFile, record);
        record = this.journal.update(id, 'dispatching', { note: '已持久保存单次投稿证明；后续异常先核对结果' });
        this.#authorized(record, 'submit', approvalDigest); this.#sameAccount(record, account);
        if (signal?.aborted) return this.#unknown(id, '单次提交已封存且操作取消，请核对；不会自动重投');
        this.#credential(account);
        const result = await this.run({ binary: this.binary, args: this.#args(record, account, receiptFile), cwd: job, home, signal, timeoutMs: this.timeoutMs });
        this.#authorized(record, 'submit', approvalDigest); this.#sameAccount(record, account);
        if (result?.closed !== true || result.exitCode !== 0 || result.cancelled === true || signal?.aborted) return this.#unknown(id);
        const receipt = receiptAt(receiptFile);
        record = this.journal.update(id, 'submitted', { receipt, reviewStatus: 'pending-verification', note: '平台已接收稿件，等待按稿件号回查；尚未证明公开可见' });
        if (!this.queryDriver) return this.#view(record);
        return await this.#verify(record, account, signal);
      } catch (error) {
        // accountLock retains its lock only when the action RETURNS unknown.
        // Never throw a started/claimed operation through its finally block.
        if (claimed) return this.#unknown(id);
        throw error;
      }
    });
  }
  async #verify(record, account, signal) {
    const actual = await this.queryDriver({ platform: PLATFORM, accountId: account.mid, aid: record.receipt.aid,
      bvid: record.receipt.bvid, expected: structuredClone(record.metadata), signal });
    this.#authorized(record, 'query'); this.#sameAccount(record, account);
    if (signal?.aborted) return this.#unknown(record.id);
    if (actual?.found === false) return this.#view(this.journal.update(record.id, 'submitted', { note: '稿件已接收，详情尚未可核验；不会重新投稿' }));
    if (actual?.accountId !== account.mid || actual.aid !== record.receipt.aid || actual.bvid !== record.receipt.bvid
      || actual.title !== record.metadata.title || actual.description !== record.metadata.description || actual.tid !== record.metadata.tid
      || actual.copyright !== record.metadata.copyright || actual.source !== record.metadata.source
      || !Array.isArray(actual.tags) || canonical(actual.tags) !== canonical(record.metadata.tags)
      || actual.partsCount !== 1 || !['reviewing', 'public', 'rejected', 'private', 'deleted'].includes(actual.reviewStatus)) return this.#unknown(record.id, '回查稿件号、账号或内容未精确匹配，请人工核对；不会重投');
    return this.#view(this.journal.update(record.id, 'verified', { reviewStatus: actual.reviewStatus,
      note: actual.reviewStatus === 'public' ? '已回查本账号稿件，平台显示已公开' : actual.reviewStatus === 'reviewing' ? '已回查本账号稿件，平台审核中' : '已回查平台状态，请核对详情' }));
  }
  async query(id, { signal } = {}) {
    const record = this.#read(id); this.#authorized(record, 'query');
    const account = this.#account(record);
    if (!account || !record.receipt || !this.queryDriver) return this.#view(record, '尚无本次精确回执、独立账号或回查驱动，不会按标题猜测结果');
    // Query performs no upload and never clears a retained unknown account lock.
    try { return await this.#verify(record, account, signal); }
    catch { return this.#unknown(id, '稿件回查尚未确认；原提交证明与账号保护继续保留'); }
  }
}
