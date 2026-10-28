import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Read actual media duration locally; missing ffprobe never discards an existing capture. */
export async function probeCaptureDuration(file, {
  requestedSeconds, stream = 'audio', signal, runCommand = execFileAsync,
  ffprobePath = process.env.PHONE_FFPROBE || 'ffprobe',
} = {}) {
  signal?.throwIfAborted();
  const unknown = (reason) => ({ requestedSeconds, actualDurationSeconds: null,
    durationStatus: 'unknown', partial: null, durationProbeError: reason });
  try {
    const { stdout } = await runCommand(ffprobePath, [
      '-v', 'error', '-select_streams', stream === 'video' ? 'v:0' : 'a:0',
      '-show_entries', 'stream=duration:format=duration', '-of', 'json', file,
    ], { timeout: 10000, signal, maxBuffer: 256 * 1024, windowsHide: true });
    signal?.throwIfAborted();
    const metadata = JSON.parse(String(stdout));
    if (!Array.isArray(metadata.streams) || metadata.streams.length !== 1) return unknown('未检测到可测量的指定媒体轨道');
    const candidates = [metadata.streams[0]?.duration, metadata.format?.duration]
      .filter((value) => typeof value === 'number' || (typeof value === 'string' && value.trim()))
      .map(Number);
    const actual = candidates.find((value) => Number.isFinite(value) && value > 0);
    if (actual === undefined) return unknown('媒体未提供有效时长');
    const actualDurationSeconds = Math.round(actual * 1e6) / 1e6;
    return { requestedSeconds, actualDurationSeconds, durationStatus: 'measured',
      // Ignore only sub-frame/container rounding, never startup losses of tenths of a second.
      partial: Number.isFinite(requestedSeconds) ? actualDurationSeconds < requestedSeconds - 0.05 : null };
  } catch (error) {
    signal?.throwIfAborted();
    return unknown(`无法测量媒体时长：${error.message}`);
  }
}

export function captureDurationText(timing) {
  const requested = Number.isFinite(timing.requestedSeconds) ? `请求 ${timing.requestedSeconds} 秒，` : '';
  return timing.durationStatus === 'measured'
    ? `${requested}实际媒体时长 ${timing.actualDurationSeconds} 秒${timing.partial ? '（短于请求时长）' : ''}`
    : `${requested}实际媒体时长未知`;
}
