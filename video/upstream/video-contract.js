'use strict';
const crypto = require('node:crypto');

const MAX_UPLOAD = 32 * 1024 * 1024;
const MAX_JSON = 2 * 1024 * 1024;
const TYPES = Object.freeze({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-matroska': '.mkv' });
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SILENT_LIMITS = Object.freeze({ fps: 25, minDurationSeconds: 1, maxDurationSeconds: 60, defaultDurationSeconds: 5, maxJobDurationSeconds: 600, maxTextLines: 2, minFontSize: 16, maxFontSize: 128, defaultFontSize: 48 });
const ERRORS = Object.freeze({
  INVALID_INPUT: '视频参数不正确', CLIENT_INVALID: '请选择有效客户', NOT_FOUND: '视频记录不存在或不属于当前客户',
  ASSET_INVALID: '素材不存在或不属于当前客户', MEDIA_MISSING: '本地素材缺失，请恢复原素材后重试',
  MEDIA_INVALID: '素材无法解码，请检查素材', RENDER_FAILED: '本地视频合成失败，可检查环境后重试',
  AUTH: '配音鉴权失败，已停止整批，请检查服务端配置后明确重试',
  QUOTA: '配音额度不足，已停止整批，请处理额度后明确重试',
  BILLING_UNCERTAIN: '配音请求结果不确定，可能已计费；已停止整批，请核对后明确重试',
  CANCELLED: '已停止本地视频任务',
  INTERRUPTED: '上次服务已中断，请检查后继续任务',
  ENGINE_NOT_CONNECTED: '视频引擎尚未接通，请完成服务端集成后使用',
  PROVIDER_NOT_CONFIGURED: '服务端尚未配置阿里云配音密钥',
  BUSY: '已有视频任务正在执行，请稍后重试', STORE_LOCKED: '同一视频数据目录已有服务使用，请复用该服务',
  STORE_UNAVAILABLE: '视频存储暂不可用，任务已停止，请检查本机服务',
  FILE_MISSING: '已生成文件缺失，请检查本地数据目录',
  RETRY_UNAVAILABLE: '此任务当前不可重试', ADAPTER_PROTOCOL: '视频引擎返回结果不完整，已停止任务',
  MODE_UNSUPPORTED: '此记录的制作模式不支持继续，请新建图文视频任务',
  PREVIEW_DISABLED: '当前视频工具不提供声音试听',
  TEXT_TOO_LONG: '文字无法在当前画幅和字号内清晰展示，请缩短文字或分成更多画面',
  MEDIA_CHANGED: '已上传素材的内容发生变化，请重新上传并新建任务',
  AUDIO_TRACK_PRESENT: '生成的视频包含音轨，已停止本批任务，请检查本地渲染器',
  FONT_MISSING: '缺少可用的中文字体，请安装微软雅黑或Noto CJK后重新读取本地配置',
  MEDIA_TOOLS_MISSING: '缺少FFmpeg或ffprobe，请加入PATH并重新启动本机服务',
  ENGINE_START_FAILED: '无法启动本地Python渲染器，请检查Python与Pillow安装',
  ENGINE_BUSY: '本地缓存或输出目录已有渲染任务，请等待该任务停止后再继续',
  ENGINE_FAILURE: '本地渲染器运行异常，已停止整批，请检查本机日志',
  DURATION_INVALID: '画面时长不正确，请检查每段1—60秒及总长600秒限制',
  DATA_PATH_TOO_LONG: '本地视频数据路径过长，请使用较短的私有数据目录并新建任务',
  CONTENT_SOURCES_MISSING: '当前客户缺少可读取的业务资料，或资料超过30份/8万字，请先整理客户资料',
  CONTENT_BUSY: '正在生成文案，请等待本次完成后再操作', CONTENT_VERSION_CONFLICT: '本次请求的资料或设置已变化，请重新发起生成',
  CONTENT_INVALID: '生成结果的结构、篇幅或店名要求未通过，原草稿已保留',
  CONTENT_AUTH: 'WorkBuddy认证不可用，请检查现有应用配置和服务状态',
  CONTENT_FAILED: 'WorkBuddy生成未完成，原草稿已保留，请检查本机服务记录后重试',
  CONTENT_CONFIG_MISSING: '现有WorkBuddy应用配置或SDK不可用，请先恢复文本服务',
});
function fault(status, code, message) { return Object.assign(new Error(message || ERRORS[code] || ERRORS.INVALID_INPUT), { status, code }); }
function assert(ok, message) { if (!ok) throw fault(400, 'INVALID_INPUT', message); }
function safeId(value, label) {
  assert(typeof value === 'string' && ID.test(value) && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(value), `${label}需为安全的1—64位标识`);
  return value;
}
function text(value, max, label, empty = false) {
  assert(typeof value === 'string' && (empty || value.trim()) && [...value].length <= max && !value.includes('\0'), `${label}需为${empty ? '0' : '1'}—${max}字文本`);
  return value;
}
function checkTextLayout(value, width, height, fontSize) {
  // Conservative admission check. The renderer must additionally measure its
  // actual font. Never truncate, shrink or silently paginate the submitted text.
  const usable = width * 0.84 - fontSize * 0.16;
  let lines = 1, lineWidth = 0;
  for (const character of value) {
    if (character === '\n') { lines++; lineWidth = 0; continue; }
    const code = character.codePointAt(0);
    const units = /\p{Mark}/u.test(character) ? 0 : /\s/u.test(character) ? 0.4 : code >= 0x2e80 ? 1.1 : 0.7;
    const glyphWidth = fontSize * units;
    if (glyphWidth > usable) throw fault(400, 'TEXT_TOO_LONG');
    if (lineWidth + glyphWidth > usable) { lines++; lineWidth = 0; }
    lineWidth += glyphWidth;
  }
  if (lines > SILENT_LIMITS.maxTextLines || lines * fontSize * 1.35 > height * 0.32) throw fault(400, 'TEXT_TOO_LONG');
}
function normalizeBatch(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input), '需要JSON对象');
  if (input.mode !== 'silent') throw fault(400, 'MODE_UNSUPPORTED');
  const result = { clientId: text(input.clientId, 100, '客户ID'), mode: 'silent', fps: SILENT_LIMITS.fps };
  assert(Array.isArray(input.jobs) && input.jobs.length >= 1 && input.jobs.length <= 30, '每批需要1—30条视频');
  const seen = new Set();
  result.jobs = input.jobs.map(job => {
    assert(job && typeof job === 'object', '视频条目不正确');
    const id = safeId(job.id, '视频ID');
    assert(!seen.has(id.toLowerCase()), '视频ID不能重复'); seen.add(id.toLowerCase());
    const width = job.width ?? 720, height = job.height ?? 1280;
    assert([width, height].every(n => Number.isInteger(n) && n >= 128 && n <= 1920 && n % 2 === 0), '宽高须为128—1920之间的偶数');
    if (job.mode !== undefined && job.mode !== 'silent') throw fault(400, 'MODE_UNSUPPORTED');
    const motion = job.motion ?? 'gentle';
    assert(['none', 'gentle'].includes(motion), '运动方式不正确');
    assert(job.textStyle === undefined || job.textStyle && typeof job.textStyle === 'object' && !Array.isArray(job.textStyle), '文字样式需为对象');
    const style = job.textStyle || {};
    const textStyle = { position: style.position ?? 'bottom', preset: style.preset ?? 'white-outline', fontSize: style.fontSize ?? SILENT_LIMITS.defaultFontSize };
    assert(['top', 'bottom'].includes(textStyle.position) && ['white-outline', 'yellow-outline'].includes(textStyle.preset), '文字位置或样式不正确');
    assert(Number.isInteger(textStyle.fontSize) && textStyle.fontSize >= SILENT_LIMITS.minFontSize && textStyle.fontSize <= SILENT_LIMITS.maxFontSize, '字号须为16—128之间的整数像素');
    assert(textStyle.fontSize >= Math.max(16, Math.ceil(Math.min(width, height) / 40)) && textStyle.fontSize <= Math.floor(Math.min(width, height) / 3), '字号与当前画幅不匹配，请调整字号或画幅');
    assert(Array.isArray(job.segments) && job.segments.length >= 1 && job.segments.length <= 100, '每条视频需要1—100段');
    const segmentIds = new Set();
    const segments = job.segments.map(segment => {
      assert(segment && typeof segment === 'object', '画面分段不正确');
      const sid = safeId(segment.id, '分段ID');
      assert(!segmentIds.has(sid.toLowerCase()), '分段ID不能重复'); segmentIds.add(sid.toLowerCase());
      const displayText = text(segment.text, 500, '展示文字').replace(/\r\n?/g, '\n');
      assert(!/[\x00-\x09\x0b-\x1f\x7f]/.test(displayText), '展示文字不能含控制字符');
      checkTextLayout(displayText, width, height, textStyle.fontSize);
      const durationSeconds = segment.durationSeconds ?? SILENT_LIMITS.defaultDurationSeconds;
      assert(typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds >= SILENT_LIMITS.minDurationSeconds && durationSeconds <= SILENT_LIMITS.maxDurationSeconds, '每段停留时间须为1—60秒');
      const s = { id: sid, text: displayText, media: segment.media, durationSeconds };
      assert(typeof s.media === 'string' && UUID.test(s.media), '画面素材必须引用已上传的assetId');
      for (const key of ['visualDescription', 'screenText']) if (segment[key] !== undefined) s[key] = text(segment[key], 2000, key, true);
      return s;
    });
    assert(segments.reduce((sum, s) => sum + s.durationSeconds, 0) <= SILENT_LIMITS.maxJobDurationSeconds + 1e-8, '单条视频总时长不能超过600秒');
    const value = { id, title: text(job.title || id, 200, '标题'), width, height, motion, textStyle, segments };
    if (job.contentGenerationId !== undefined) { assert(typeof job.contentGenerationId === 'string' && UUID.test(job.contentGenerationId), '生成来源ID不正确'); value.contentGenerationId = job.contentGenerationId; value.contentEdited=job.contentEdited===true; }
    if (job.originalText !== undefined) value.originalText = text(job.originalText, 60000, '原稿', true);
    if(value.contentGenerationId){
      const canonical=v=>typeof v==='string'?v.replace(/\s/gu,''):'';
      const body=canonical(value.originalText);
      assert(Array.from(body).length>=150&&Array.from(body).length<=250,'GEO完整文案需为150—250字');
      assert(body===canonical(segments.map(s=>s.text).join('')),'分屏文字必须完整承载当前GEO文案');
    }
    if (job.source != null) {
      assert(typeof job.source === 'object' && !Array.isArray(job.source), '稿件来源不正确');
      value.source = { runId: text(job.source.runId, 100, '来源任务ID'), artifactId: text(job.source.artifactId, 100, '来源稿件ID'), contentVersion: job.source.contentVersion };
      assert(Number.isInteger(value.source.contentVersion) && value.source.contentVersion >= 1, '来源正文版本不正确');
    }
    return value;
  });
  return result;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function matchesType(data, type) {
  if (type === 'image/png') return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/jpeg') return data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255;
  if (type === 'image/webp') return data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  if (type === 'video/mp4' || type === 'video/quicktime') return data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp';
  return data.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
}
function errorInfo(error) {
  const aliases = { ABORT_ERR: 'CANCELLED', ABORTED: 'CANCELLED', MEDIA_ERROR: 'MEDIA_INVALID', ENOENT: 'MEDIA_MISSING',
    TEXT_LAYOUT_INVALID: 'INVALID_INPUT', TEXT_LAYOUT_TOO_LONG: 'TEXT_TOO_LONG', RENDER_INVALID: 'ADAPTER_PROTOCOL', MEDIA_PROCESS_FAILED: 'RENDER_FAILED',
    ENGINE_INTERRUPTED: 'INTERRUPTED', ENGINE_PROTOCOL: 'ADAPTER_PROTOCOL', ENGINE_INTERNAL: 'ENGINE_FAILURE', PROCESS_TIMEOUT: 'RENDER_FAILED' };
  const supplied = error?.errorCode || error?.code;
  const localCodes = ['INVALID_INPUT', 'DURATION_INVALID', 'FONT_MISSING', 'MEDIA_TOOLS_MISSING', 'ENGINE_START_FAILED', 'ENGINE_BUSY', 'ENGINE_FAILURE', 'MEDIA_MISSING', 'MEDIA_INVALID', 'MEDIA_CHANGED', 'RENDER_FAILED', 'CANCELLED', 'STORE_UNAVAILABLE', 'ADAPTER_PROTOCOL', 'AUDIO_TRACK_PRESENT', 'MODE_UNSUPPORTED', 'TEXT_TOO_LONG', 'ENGINE_NOT_CONNECTED'];
  const remoteError = /^(AUTH|QUOTA|BILLING_|TTS_|UNAUTHORIZED|INSUFFICIENT_QUOTA)/.test(supplied || '');
  const code = aliases[supplied] || (localCodes.includes(supplied) ? supplied : remoteError ? 'ADAPTER_PROTOCOL' : error?.name === 'AbortError' ? 'CANCELLED' : 'RENDER_FAILED');
  return { code, message: ERRORS[code], fatal: error?.haltBatch === true || ['STORE_UNAVAILABLE', 'ADAPTER_PROTOCOL', 'AUDIO_TRACK_PRESENT', 'MODE_UNSUPPORTED', 'ENGINE_NOT_CONNECTED', 'FONT_MISSING', 'MEDIA_TOOLS_MISSING', 'ENGINE_START_FAILED', 'ENGINE_BUSY', 'ENGINE_FAILURE', 'INTERRUPTED', 'CANCELLED'].includes(code) };
}
module.exports = { MAX_UPLOAD, MAX_JSON, TYPES, UUID, SILENT_LIMITS, ERRORS, fault, normalizeBatch, digest, matchesType, errorInfo };
