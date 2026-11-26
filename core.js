// Package and playback rules shared by the page, service worker and Node tests.
const MAX_PACKAGE = 100 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function safePath(path) {
  return /^(data\/[a-z0-9-]+\.json|audio\/[a-zA-Z0-9_-]+\.(mp3|m4a))$/.test(path);
}
export const SCHEMA_VERSION = 2;
// Optional furigana: "{本|ほん}を　{読|よ}みます。" — each {base|reading} puts the kana reading over its kanji.
const RUBY_SEGMENT = /\{([^{}|]+)\|([^{}|]+)\}/g;
const RUBY_READING = /^[ぁ-ゖゝゞァ-ヺーヽヾ]+$/;
export function parseRuby(text) {
  if (typeof text !== 'string' || !text || text.length > 6000) return null;
  const segments = []; let last = 0;
  for (const match of text.matchAll(RUBY_SEGMENT)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index) });
    if (!RUBY_READING.test(match[2])) return null;
    segments.push({ text: match[1], reading: match[2] }); last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments.some(segment => !segment.reading && /[{}|]/.test(segment.text)) ? null : segments;
}
export function rubyMatches(ruby, japanese) {
  const segments = parseRuby(ruby);
  return Boolean(segments) && segments.map(segment => segment.text).join('') === japanese;
}
export const TRACK_TYPES = ['patterns', 'examples', 'conversation'];
export function mediaType(path) {
  if (/\.mp3$/.test(path)) return 'audio/mpeg';
  if (/\.m4a$/.test(path)) return 'audio/mp4';
  if (/\.json$/.test(path)) return 'application/json';
  throw new Error(`不支持的课程文件类型：${path}`);
}
function audioContainer(bytes) {
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp') return 'audio/mp4';
  if (bytes.length >= 3 && String.fromCharCode(...bytes.subarray(0, 3)) === 'ID3') return 'audio/mpeg';
  if (bytes.length >= 4 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x18) !== 0x08 && (bytes[1] & 0x06) && (bytes[2] & 0x0c) !== 0x0c) return 'audio/mpeg';
  return null;
}
export function readStoredZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 22 || bytes.byteLength > MAX_PACKAGE) throw new Error('课程包不是有效的 ZIP，或大小超过 100 MB。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  if (end < 0) throw new Error('找不到 ZIP 文件目录，请重新选择完整课程包。');
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || count < 2 || count > 128 || start + size !== end) throw new Error('不支持此 ZIP 目录格式。');
  let cursor = start; const files = new Map();
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('ZIP 文件目录已损坏。');
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true), compressed = view.getUint32(cursor + 20, true), length = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true);
    const offset = view.getUint32(cursor + 42, true);
    if (cursor + 46 + nameLength + extra + comment > end || offset + 30 > start) throw new Error('ZIP 文件长度不完整。');
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (!safePath(name)) throw new Error(`课程包包含不支持的路径：${name}`);
    if (files.has(name)) throw new Error(`课程包包含重复文件：${name}`);
    if ((flags & 1) || method !== 0 || compressed !== length || view.getUint16(offset + 8, true) !== 0) throw new Error(`请使用未压缩的课程包（ZIP_STORED）：${name}`);
    if (view.getUint32(offset, true) !== 0x04034b50) throw new Error(`ZIP 文件头已损坏：${name}`);
    const localName = view.getUint16(offset + 26, true), localExtra = view.getUint16(offset + 28, true);
    const dataOffset = offset + 30 + localName + localExtra;
    if (dataOffset + length > start || decoder.decode(bytes.subarray(offset + 30, offset + 30 + localName)) !== name) throw new Error(`ZIP 文件长度或路径不一致：${name}`);
    const content = new Uint8Array(bytes.subarray(dataOffset, dataOffset + length));
    if (crc32(content) !== crc) throw new Error(`${name} 校验失败，请重新传输课程包。`);
    files.set(name, content);
    cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== end) throw new Error('ZIP 文件目录长度不一致。');
  return files;
}
export function validateLesson(lesson) {
  if (lesson?.schemaVersion === 1) throw new Error('这是旧版课程包。请导入新版句子课程包，才能按句跟读。');
  if (!lesson || lesson.schemaVersion !== SCHEMA_VERSION || !Number.isInteger(lesson.number) || lesson.number < 1 || lesson.number > 25 || lesson.id !== `lesson-${String(lesson.number).padStart(2, '0')}`) throw new Error('课程编号或数据版本不正确，请选择新版句子课程包。');
  if (typeof lesson.title !== 'string' || !lesson.title.trim() || lesson.title.length > 100 || !Array.isArray(lesson.tracks) || lesson.tracks.length !== TRACK_TYPES.length) throw new Error('新版课程需要文型、例文、会话三个部分。');
  const used = new Set(), ids = new Set();
  for (const [index, track] of lesson.tracks.entries()) {
    if (!track || track.type !== TRACK_TYPES[index]) throw new Error('课程顺序必须是文型、例文、会话，不能包含问题音频。');
    if (typeof track.src !== 'string' || !safePath(track.src) || !track.src.startsWith('audio/')) throw new Error(`音频路径不正确：${track.src || '未提供文件名'}`);
    if (used.has(track.src)) throw new Error(`曲目引用了重复文件：${track.src}`);
    used.add(track.src);
    if (typeof track.id !== 'string' || !track.id.trim() || ids.has(track.id) || typeof track.title !== 'string' || !track.title.trim() || !/^[a-f0-9]{64}$/i.test(track.sha256) || !Number.isFinite(track.duration) || track.duration <= 0) throw new Error(`曲目资料不完整：${track.src}`);
    ids.add(track.id);
    if (!Array.isArray(track.lines) || !track.lines.length || track.lines.length > 1000) throw new Error(`缺少逐句文本：${track.title}`);
    let previous;
    for (const line of track.lines) {
      if (!line || typeof line.ja !== 'string' || !line.ja.trim() || line.ja.length > 3000 || (line.zh !== undefined && (typeof line.zh !== 'string' || line.zh.length > 3000)) || (line.speaker !== undefined && (typeof line.speaker !== 'string' || line.speaker.length > 100))) throw new Error(`逐句日语或译文不正确：${track.title}`);
      if (line.ruby !== undefined && !rubyMatches(line.ruby, line.ja)) throw new Error(`假名注音与日语原文不一致：${track.title}「${line.ja}」`);
      if (!Number.isFinite(line.start) || !Number.isFinite(line.end) || line.start < 0 || line.start >= line.end || line.end > track.duration) throw new Error(`句子时间范围不正确：${track.title}`);
      // Boundary timestamps can differ by a few milliseconds; speech-sized overlaps are invalid.
      if (previous && (line.start < previous.start || line.start < previous.end - 0.03)) throw new Error(`句子时间存在重叠或顺序错误：${track.title}`);
      previous = line;
    }
  }
  if (lesson.vocabulary !== undefined) validateVocabulary(lesson.vocabulary, used);
  return lesson;
}
function validateVocabulary(vocabulary, usedPaths) {
  if (!vocabulary || !Array.isArray(vocabulary.audio) || vocabulary.audio.length > 120 ||
      !Array.isArray(vocabulary.words) || !vocabulary.words.length || vocabulary.words.length > 2000) {
    throw new Error('词汇音源或词条列表不完整。');
  }
  const recordings = new Map();
  for (const audio of vocabulary.audio) {
    if (!audio || typeof audio.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(audio.id) || recordings.has(audio.id)) {
      throw new Error('词汇音源名称缺失、不正确或重复。');
    }
    if (typeof audio.src !== 'string' || !safePath(audio.src) || !audio.src.startsWith('audio/')) {
      throw new Error(`词汇音频路径不正确：${audio.src || '未提供文件名'}`);
    }
    if (usedPaths.has(audio.src)) throw new Error(`词汇音源引用了重复文件：${audio.src}`);
    if (typeof audio.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(audio.sha256) || !Number.isFinite(audio.duration) || audio.duration <= 0) {
      throw new Error(`词汇音源资料不完整：${audio.src}`);
    }
    usedPaths.add(audio.src);
    recordings.set(audio.id, audio);
  }
  const words = new Set();
  for (const word of vocabulary.words) {
    if (!word || typeof word.ja !== 'string' || !word.ja.trim() || word.ja.length > 3000 ||
        typeof word.zh !== 'string' || !word.zh.trim() || word.zh.length > 3000 ||
        (word.reading !== undefined && (typeof word.reading !== 'string' || word.reading.length > 3000)) ||
        (word.unrecorded !== undefined && typeof word.unrecorded !== 'boolean')) {
      throw new Error('词汇日语、读音、中文或录音标记不正确。');
    }
    if (word.ruby !== undefined && !rubyMatches(word.ruby, word.ja)) throw new Error(`假名注音与日语原文不一致：${word.ja}`);
    const key = JSON.stringify([word.ja.trim(), (word.reading || '').trim(), word.zh.trim()]);
    if (words.has(key)) throw new Error(`词汇条目重复：${word.ja}`);
    words.add(key);
    if (word.unrecorded === true) {
      if (['audioId', 'src', 'start', 'end'].some(field => Object.hasOwn(word, field))) throw new Error(`未录音词汇不能带音源或时间：${word.ja}`);
      continue;
    }
    const audio = recordings.get(word.audioId);
    if (!audio) throw new Error(`词汇缺少有效音源：${word.ja}`);
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.start >= word.end || word.end > audio.duration) throw new Error(`词汇时间范围不正确：${word.ja}`);
  }
}
export async function validatePackage(files) {
  const jsonFiles = [...files.keys()].filter(path => path.startsWith('data/'));
  if (jsonFiles.length !== 1) throw new Error('每个课程包需要且只能包含一个 data/lesson-XX.json。');
  let parsed;
  try { parsed = JSON.parse(decoder.decode(files.get(jsonFiles[0]))); } catch { throw new Error(`课程 JSON 无法读取：${jsonFiles[0]}`); }
  const lesson = validateLesson(parsed);
  if (jsonFiles[0] !== `data/${lesson.id}.json`) throw new Error(`课程数据文件名应为 data/${lesson.id}.json。`);
  const audio = [...lesson.tracks, ...(lesson.vocabulary?.audio || [])];
  const expected = new Set([jsonFiles[0], ...audio.map(track => track.src)]);
  for (const track of audio) {
    const bytes = files.get(track.src);
    if (!bytes?.length) throw new Error(`找不到音频文件：${track.src}`);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    if (hash !== track.sha256.toLowerCase()) throw new Error(`音频 SHA-256 不一致：${track.src}。请重新导入原始课程包。`);
    if (audioContainer(bytes) !== mediaType(track.src)) throw new Error(`音频实际格式与文件扩展名不一致：${track.src}。请导入原始新版课程包。`);
  }
  for (const name of files.keys()) if (!expected.has(name)) throw new Error(`课程包包含未引用的文件：${name}`);
  return lesson;
}
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !Number.isSafeInteger(size) || size <= 0 || (!match[1] && !match[2])) return false;
  if ([match[1], match[2]].some(value => value && !Number.isSafeInteger(Number(value)))) return false;
  let start, end;
  if (!match[1]) { const suffix = Number(match[2]); if (!suffix) return false; start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return false;
  return { start, end };
}
export function nextAfterEnd(index, count, mode) {
  if (mode === 'single') return index;
  if (index + 1 < count) return index + 1;
  return mode === 'repeat' && count > 0 ? 0 : null;
}
export function formatTime(seconds) {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

export function offlineSupport({ secure, hasServiceWorker, framed }) {
  if (!secure && framed) return { code: 'embedded', title: '请在 Safari 中安装', message: '当前嵌入页面不能使用离线安装。请复制安装网址，在 Safari 中打开。' };
  if (!secure) return { code: 'https', title: '请打开正式安装网址', message: '当前页面不是安全连接，离线安装需要 HTTPS。请复制下方正式网址，在 Safari 中打开。' };
  if (!hasServiceWorker) return { code: 'browser', title: '请在 Safari 中安装', message: '当前浏览器没有提供离线播放所需的功能。请复制安装网址，在 Safari 中打开后添加到主屏幕。' };
  return null;
}
