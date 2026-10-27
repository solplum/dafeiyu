import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { PublishError, PublishJournal, canonical, hash } from './publish-journal.mjs';

export const PROVENANCE = Object.freeze({ socialAutoUpload: 'dreammis/social-auto-upload@3847fff01f5434a8a32829833163cd6723cabc59',
  referenceOnly: 'LockyBee/dsh-douyin-agent@2ef7754db0fa1da05b3892cb96d0b4301fa79889', browser: 'Fisfzy/dsh-ego-browser managed 0.9.2-dfy.1' });
const exec = promisify(execFile);
function ffprobeBinary() {
  const directories = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
    ...(process.env.PATH || '').split(path.delimiter).filter(path.isAbsolute)];
  for (const directory of new Set(directories)) {
    const binary = path.join(directory, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    try { fs.accessSync(binary, fs.constants.X_OK); if (fs.statSync(binary).isFile()) return binary; }
    catch { /* Only known installed paths are checked, during an explicit probe. */ }
  }
  throw new PublishError('PROBE_REQUIRED', '视频检查组件尚未安装');
}
export async function probeVideo(file) {
  const { stdout } = await exec(ffprobeBinary(), ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries',
    'format=duration:stream=codec_type,width,height:stream_disposition=attached_pic', '-of', 'json', file],
    { timeout: 20000, maxBuffer: 128 * 1024, windowsHide: true });
  const result = JSON.parse(stdout), video = result.streams?.find((item) => item.codec_type === 'video' && item.disposition?.attached_pic !== 1);
  return { duration: Number(result.format?.duration), width: video?.width, height: video?.height };
}
async function asset(file, extensions, maximum) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || fs.lstatSync(file).isSymbolicLink()) throw new PublishError('INVALID_ASSET', '请选择本机普通文件的绝对路径');
  const resolved = fs.realpathSync(file), stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size <= 0 || stat.size > maximum || !extensions.includes(path.extname(resolved).toLowerCase())) throw new PublishError('INVALID_ASSET', '媒体文件格式或大小无效');
  const digest = createHash('sha256'); for await (const chunk of createReadStream(resolved)) digest.update(chunk);
  const after = fs.statSync(resolved);
  if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino) throw new PublishError('ASSET_CHANGED', '读取期间文件已变化');
  return { path: resolved, sha256: digest.digest('hex'), bytes: stat.size };
}
function metadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['video', 'cover', 'title', 'description', 'tags', 'declaration', 'accountId'].includes(key))) throw new PublishError('INVALID_DRAFT', '稿件字段无效');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || [...title].length > 30 || /[\u0000-\u001f]/.test(title)) throw new PublishError('INVALID_DRAFT', '标题需要1至30个字符');
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 1000)) throw new PublishError('INVALID_DRAFT', '描述最多1000个字符');
  const tags = input.tags || [];
  if (!Array.isArray(tags) || tags.length > 5 || tags.some((tag) => typeof tag !== 'string' || !/^[\p{L}\p{N}_]{1,30}$/u.test(tag))) throw new PublishError('INVALID_DRAFT', '最多5个普通文字话题');
  if (!['none', 'ai-generated'].includes(input.declaration)) throw new PublishError('INVALID_DRAFT', '请明确本次内容是否由AI生成');
  if (input.accountId !== undefined && !/^[a-zA-Z0-9_-]{3,100}$/.test(input.accountId)) throw new PublishError('INVALID_ACCOUNT', '账号标识无效');
  return { title, description: input.description || '', tags, declaration: input.declaration, publishMode: 'immediate' };
}
function publicRecord(record) {
  return { id: record.id, platform: record.platform, accountId: record.accountId, state: ['uploading', 'dispatching'].includes(record.state) ? 'unknown' : record.state,
    title: record.metadata.title, description: record.metadata.description, tags: record.metadata.tags, declaration: record.metadata.declaration,
    video: { ...record.video }, cover: record.cover && { ...record.cover }, media: record.media, approvalDigest: record.approvalDigest,
    workId: record.receipt?.workId || null, reviewStatus: record.reviewStatus || 'not-submitted', note: record.note || '', history: record.history };
}
export class DouyinPublisher {
  constructor({ directory, driver = null, authorize = () => false, probe = probeVideo } = {}) {
    this.journal = new PublishJournal(directory); this.driver = driver; this.authorize = authorize; this.probe = probe;
  }
  async prepare(input) {
    const meta = metadata(input), video = await asset(input.video, ['.mp4', '.mov', '.m4v'], 1024 * 1024 * 1024);
    const cover = input.cover ? await asset(input.cover, ['.png', '.jpg', '.jpeg', '.webp'], 20 * 1024 * 1024) : null;
    const media = await this.probe(video.path);
    if (!Number.isFinite(media.duration) || media.duration <= 0 || media.duration > 900 || !Number.isInteger(media.width) || media.width <= 0 || !Number.isInteger(media.height) || media.height <= 0) throw new PublishError('INVALID_VIDEO', '视频需要可解码的视频轨道，时长不超过15分钟');
    const checked = await asset(video.path, ['.mp4', '.mov', '.m4v'], 1024 * 1024 * 1024);
    if (checked.sha256 !== video.sha256) throw new PublishError('ASSET_CHANGED', '验证期间视频已变化');
    const accountId = input.accountId || null;
    const approvalDigest = hash(canonical({ platform: 'douyin', accountId, video: video.sha256, cover: cover?.sha256 || null, metadata: meta }));
    const record = { id: approvalDigest, platform: 'douyin', accountId, approvalDigest, metadata: meta, video, cover, media,
      state: 'prepared', provenance: PROVENANCE, receipt: null, history: [{ state: 'prepared', at: new Date().toISOString() }], updatedAt: new Date().toISOString() };
    return publicRecord(this.journal.create(record.id, record));
  }
  preview(id) { return publicRecord(this.journal.read(id)); }
  #authorized(record, action, digest) {
    if (!record.accountId) throw new PublishError('ACCOUNT_REQUIRED', '尚未绑定独立抖音账号；已准备稿件，不会上传或发布');
    if (!this.driver) throw new PublishError('DRIVER_REQUIRED', '尚未接入已验证的抖音浏览器会话');
    if (digest !== record.approvalDigest || !this.authorize({ platform: 'douyin', accountId: record.accountId, action, approvalDigest: digest })) throw new PublishError('FORBIDDEN', '本次稿件与账号尚未获明确授权');
  }
  async #unchanged(record) {
    const current = await asset(record.video.path, ['.mp4', '.mov', '.m4v'], 1024 * 1024 * 1024);
    if (current.sha256 !== record.video.sha256) throw new PublishError('ASSET_CHANGED', '视频已变化，请重新准备稿件');
    if (record.cover) { const cover = await asset(record.cover.path, ['.png', '.jpg', '.jpeg', '.webp'], 20 * 1024 * 1024);
      if (cover.sha256 !== record.cover.sha256) throw new PublishError('ASSET_CHANGED', '封面已变化，请重新准备稿件'); }
  }
  async #account(record) {
    const actual = await this.driver.account();
    if (actual?.loggedIn !== true || actual?.accountId !== record.accountId) throw new PublishError('ACCOUNT_MISMATCH', '当前抖音登录账号与稿件账号不一致');
  }
  async upload(id, approvalDigest) {
    const start = this.journal.read(id); this.#authorized(start, 'upload', approvalDigest);
    return this.journal.accountLock('douyin', start.accountId, async () => {
      const record = this.journal.read(id);
      if (record.state !== 'prepared') throw new PublishError('NO_REPLAY', '上传已经开始或结果待核对，不能重复上传');
      this.driver.validateDraft?.(record);
      await this.#unchanged(record); await this.#account(record); this.#authorized(record, 'upload', approvalDigest);
      this.journal.update(id, 'uploading', { note: '已开始上传，重启后需先核对原草稿' });
      try {
        const prepared = await this.driver.prepare(record, { claimFile: this.journal.uploadClaimFile(id) });
        this.#authorized(record, 'upload', approvalDigest); await this.#account(record);
        if (prepared?.ready !== true || prepared?.title !== record.metadata.title || prepared?.description !== record.metadata.description || prepared?.declaration !== record.metadata.declaration
          || typeof prepared.draftToken !== 'string' || !prepared.draftToken || prepared.draftToken.length > 300) throw new Error('Unverified browser draft');
        return publicRecord(this.journal.update(id, 'ready', { draftToken: prepared.draftToken, note: '已上传到编辑页，尚未发布' }));
      } catch { return publicRecord(this.journal.update(id, 'unknown', { note: '上传或草稿回读未确认，请人工核对；不会自动重试' })); }
    });
  }
  async submit(id, approvalDigest) {
    const start = this.journal.read(id); this.#authorized(start, 'submit', approvalDigest);
    return this.journal.accountLock('douyin', start.accountId, async () => {
      const record = this.journal.read(id);
      if (record.state !== 'ready') throw new PublishError('NO_REPLAY', '该稿件未就绪或已尝试提交，不会再次点击发布');
      await this.#unchanged(record); await this.#account(record);
      const actual = await this.driver.inspectDraft(record);
      if (actual?.draftToken !== record.draftToken || actual?.ready !== true || actual?.title !== record.metadata.title
        || actual?.description !== record.metadata.description || actual?.declaration !== record.metadata.declaration) throw new PublishError('DRAFT_CHANGED', '编辑页与已核对稿件不一致');
      this.#authorized(record, 'submit', approvalDigest);
      this.journal.update(id, 'dispatching', { note: '已持久化单次提交证明，后续异常必须先核对作品' });
      try {
        const receipt = await this.driver.submitOnce(record, { claimFile: this.journal.claimFile(id) });
        this.#authorized(record, 'submit', approvalDigest); await this.#account(record);
        if (receipt?.accountId !== record.accountId || receipt?.draftToken !== record.draftToken || !/^\d{6,30}$/.test(receipt?.workId || '')) throw new Error('No exact publication receipt');
        return publicRecord(this.journal.update(id, 'submitted', { receipt: { workId: receipt.workId, accountId: record.accountId }, reviewStatus: 'pending-verification', note: '已获得作品编号，等待作品列表回查' }));
      } catch { return publicRecord(this.journal.update(id, 'unknown', { note: '提交结果未知，请核对作品管理；禁止重复发布' })); }
    });
  }
  async query(id) {
    const start = this.journal.read(id); this.#authorized(start, 'query', start.approvalDigest);
    return this.journal.accountLock('douyin', start.accountId, async () => {
      const record = this.journal.read(id);
      if (!record.receipt?.workId) return { ...publicRecord(record), note: '尚无本次作品的精确编号，不能按标题猜测已发布；请人工核对' };
      await this.#account(record);
      const result = await this.driver.queryWork(record.receipt.workId);
      this.#authorized(record, 'query', record.approvalDigest); await this.#account(record);
      if (result?.workId !== record.receipt.workId || result.accountId !== record.accountId || result.title !== record.metadata.title
        || !['reviewing', 'public', 'rejected', 'private', 'deleted'].includes(result.reviewStatus)) return { ...publicRecord(record), note: '作品编号或审核状态尚未精确核对' };
      return publicRecord(this.journal.update(id, 'verified', { reviewStatus: result.reviewStatus, note: result.reviewStatus === 'public' ? '作品已公开' : result.reviewStatus === 'reviewing' ? '作品已提交，平台审核中' : '已回查平台状态，请核对详情' }));
    });
  }
}
