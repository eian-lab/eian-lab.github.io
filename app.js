import { readStoredZip, validatePackage, formatTime, offlineSupport, nextAfterEnd, parseRuby } from './core.js';
import { allLessons, getFile, saveLesson } from './storage.js';

const $ = id => document.getElementById(id);
const audio = $('audio');
const BASE = new URL('./', import.meta.url);
const APP_VERSION = '3.0.1';
const REQUIRED_SHELL = [3, 0, 1];
const INSTALL_URL = 'https://eian-lab.github.io/';
const JA_SIZES = [['较小', 17], ['标准', 20], ['较大', 23], ['很大', 26], ['特大', 30]];
const TILE_STOPS = ['#f7b6ce', '#d7c6f4', '#b6d3ff', '#a8e6df'];
const POPOVER = typeof HTMLElement.prototype.showPopover === 'function';
const state = { lessons: [], lesson: null, track: 0, mode: 'lesson', bilingual: true, scope: 'lesson', wordIndex: null, panel: 'text', furigana: true, jaSize: 1, segment: null, seeking: false, shellReady: false, importing: false, totalLessons: 25 };
let registration, lastSave = 0, selectionVersion = 0, sentenceTimer, metadataHandler, noticeTimer;
let lineButtons = [], groupButtons = [], wordButtons = [];
let npKey = '', npRows = [], npCurrent = -1, barKey = '', barNodes = [];
let leavingLesson = false, libraryScroll = 0;
let vocabularySources = new Map(), mediaLoadVersion = 0, playbackWanted = false;
let openingLesson = 0, vocabularyLoading = null;
let lastController = navigator.serviceWorker?.controller || null, updateRequested = false, reloadStarted = false, updateWaitTimer;
function preference(key, value) {
  try { if (value !== undefined) localStorage.setItem(key, JSON.stringify(value)); else return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function icon(name, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', `#i-${name}`); svg.append(use); return svg;
}
function setIcon(button, name) { button.querySelector('use')?.setAttribute('href', `#i-${name}`); }
function text(tag, value, className) {
  const element = document.createElement(tag); element.textContent = value;
  if (className) element.className = className;
  return element;
}
// Japanese text with optional per-kanji furigana. Short phrases (split at full-width spaces and
// after 。、？！) never wrap inside, so a line never breaks between お and 花見.
function japanese(tag, value, ruby, className) {
  const element = text(tag, '', className); element.lang = 'ja';
  const parsed = typeof ruby === 'string' ? parseRuby(ruby) : null;
  const usable = parsed && parsed.map(segment => segment.text).join('') === value;
  if (usable) element.classList.add('has-ruby');
  const phrases = []; let phrase = [];
  const flush = gap => { if (phrase.length) phrases.push(phrase); phrase = []; if (gap) phrases.push(gap); };
  for (const segment of usable ? parsed : [{ text: value }]) {
    if (segment.reading) { phrase.push(segment); continue; }
    let buffer = '';
    for (const character of segment.text) {
      if (character === '　') { if (buffer) phrase.push({ text: buffer }); buffer = ''; flush('　'); continue; }
      buffer += character;
      if ('。、？！'.includes(character)) { phrase.push({ text: buffer }); buffer = ''; flush(); }
    }
    if (buffer) phrase.push({ text: buffer });
  }
  flush();
  for (const item of phrases) {
    if (typeof item === 'string') { element.append(item); continue; }
    const length = item.reduce((sum, segment) => sum + segment.text.length, 0);
    const holder = length <= 10 ? text('span', '', 'phrase') : document.createDocumentFragment();
    for (const segment of item) {
      if (!segment.reading) { holder.append(segment.text); continue; }
      const node = document.createElement('ruby'); node.append(segment.text, text('rt', segment.reading)); holder.append(node);
    }
    element.append(holder);
  }
  return element;
}
function rubyReading(ruby) {
  const segments = typeof ruby === 'string' ? parseRuby(ruby) : null;
  return segments ? segments.map(segment => segment.reading || segment.text).join('') : null;
}
function tileColor(number) {
  const t = state.totalLessons > 1 ? Math.max(0, Math.min(1, (number - 1) / (state.totalLessons - 1))) : 0;
  const span = TILE_STOPS.length - 1, index = Math.min(Math.floor(t * span), span - 1), u = t * span - index;
  const a = TILE_STOPS[index], b = TILE_STOPS[index + 1], channel = (hex, at) => parseInt(hex.slice(at, at + 2), 16);
  return `rgb(${[1, 3, 5].map(at => Math.round(channel(a, at) + (channel(b, at) - channel(a, at)) * u)).join(', ')})`;
}

// Sheets and top-layer messages
const SHEETS = ['now-playing', 'display-sheet', 'settings-sheet', 'help-dialog'];
function closeSheets() { for (const id of SHEETS) if ($(id).open) $(id).close(); }
function openSheet(id) { const dialog = $(id); if (!dialog.open) dialog.showModal(); return dialog; }
function layer(element, show) {
  element.hidden = !show;
  if (!POPOVER) return;
  try {
    if (element.matches(':popover-open')) element.hidePopover();
    if (show) element.showPopover();
  } catch { /* Fixed positioning still shows the message. */ }
}
function error(message) {
  closeSheets();
  $('error-message').textContent = message; layer($('error-box'), true);
}
function hideError() { if (!$('error-box').hidden) layer($('error-box'), false); }
function notice(message, sticky = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message; layer($('notice'), !!message);
  if (message && !sticky) noticeTimer = setTimeout(() => layer($('notice'), false), 4200);
}

// Player updates (unchanged flow from 2.8, new labels)
function updateIsBusy() { return state.importing || (!audio.paused && !audio.ended); }
function refreshUpdatePrompt() {
  if (!state.updatePending) return;
  $('update-box').hidden = false;
  const busy = updateIsBusy();
  $('update-message').textContent = state.updateRequired ? '当前离线播放器需要更新。请打开“检查更新 / 修复安装”，课程会保留在本机。' : state.importing ? '新版播放器已就绪。课程导入完成后，可以更新。' : busy ? '新版播放器已就绪。暂停播放后，可以更新。' : '更新会保留这台设备上的课程。';
  $('apply-update').disabled = busy || updateRequested;
  $('apply-update').textContent = updateRequested ? '更新中…' : '更新';
}
function markUpdateAvailable() { state.updatePending = true; refreshUpdatePrompt(); }
function reloadPlayerOnce() {
  if (reloadStarted || updateIsBusy()) return;
  reloadStarted = true; clearTimeout(updateWaitTimer); location.reload();
}
function applyPlayerUpdate() {
  if (updateRequested || updateIsBusy()) { refreshUpdatePrompt(); return; }
  if (state.updateRequired && !registration?.waiting) { location.assign(new URL('update/', BASE).href); return; }
  updateRequested = true; refreshUpdatePrompt();
  if (registration?.waiting) {
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    updateWaitTimer = setTimeout(() => {
      updateRequested = false; refreshUpdatePrompt();
      $('update-message').textContent = '更新还未完成。请打开“检查更新 / 修复安装”继续，课程会保留在本机。';
    }, 10000);
  } else reloadPlayerOnce();
}
navigator.serviceWorker?.addEventListener('controllerchange', () => {
  const controller = navigator.serviceWorker.controller;
  if (!controller || controller === lastController) return;
  const wasControlled = !!lastController; lastController = controller;
  if (!wasControlled) return; // First installation gaining control is not an update.
  clearTimeout(updateWaitTimer); markUpdateAvailable();
  if (updateRequested && !updateIsBusy()) reloadPlayerOnce();
  else { updateRequested = false; refreshUpdatePrompt(); }
});
function watchPlayerUpdate(reg) {
  if (reg.waiting) markUpdateAvailable();
  const observe = () => {
    const worker = reg.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && reg.active) markUpdateAvailable();
    });
  };
  reg.addEventListener('updatefound', observe); observe();
}
function standalone() { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
function browserSupport() {
  return offlineSupport({ secure: window.isSecureContext, hasServiceWorker: typeof navigator.serviceWorker?.register === 'function', framed: window.top !== window.self });
}
function showSetup(problem) {
  state.setup = problem; state.shellReady = false;
  $('setup-title').textContent = problem.title; $('setup-message').textContent = problem.message;
  $('browser-setup').hidden = false; hideError();
  renderLibrary();
}
function requestImport() {
  closeSheets();
  if (state.setup) {
    $('browser-setup').scrollIntoView({ block: 'start', behavior: 'instant' });
    $('copy-install-url').focus();
    return;
  }
  $('package-file').click();
}
async function copyInstallUrl() {
  try {
    await navigator.clipboard.writeText(INSTALL_URL);
    $('copy-status').textContent = '已复制。请切换到 Safari，把网址粘贴到地址栏打开。';
    $('copy-install-url').textContent = '已复制';
    notice('安装网址已复制，请在 Safari 打开。');
  } catch {
    closeSheets();
    $('browser-setup').hidden = false;
    $('install-url').focus(); $('install-url').select();
    $('copy-status').textContent = '未能自动复制，请长按已选中的网址，选择“复制”，再到 Safari 粘贴打开。';
  }
}

const GROUPS = ['patterns', 'examples', 'conversation'];
const GROUP_NAMES = { patterns: '文型', examples: '例文', conversation: '会话' };
function vocabularyWords() { return state.lesson?.vocabulary?.words || []; }
function selectedWord() { return state.scope === 'vocabulary' && Number.isInteger(state.wordIndex) ? vocabularyWords()[state.wordIndex] : null; }
function wordAudio(word) { return word && state.lesson?.vocabulary?.audio?.find(item => item.id === word.audioId); }
function playbackResource() { return state.scope === 'vocabulary' ? wordAudio(selectedWord()) : state.lesson?.tracks[state.track]; }
function distinctReading(word) {
  return typeof word.reading === 'string' && word.reading.trim() && word.reading.trim().normalize('NFKC') !== word.ja.trim().normalize('NFKC');
}
function wordAccessibleLabel(word, playable) {
  const parts = [word.ja];
  if (distinctReading(word)) parts.push(word.reading);
  if (state.bilingual && word.zh) parts.push(word.zh);
  parts.push(playable ? '播放单词原声' : '暂无录音，不能播放');
  return parts.join('，');
}
function playableWord(index) {
  const word = vocabularyWords()[index];
  return !!word && word.unrecorded !== true && !!wordAudio(word) && Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start;
}
function adjacentWord(delta) {
  for (let index = state.wordIndex + delta; index >= 0 && index < vocabularyWords().length; index += delta) if (playableWord(index)) return index;
  return null;
}
function currentLesson(lesson) {
  return lesson?.schemaVersion === 2 && lesson.tracks?.length === 3 && lesson.tracks.every((track, index) =>
    track.type === GROUPS[index] && Array.isArray(track.lines) && track.lines.length > 0 &&
    track.lines.every(line => typeof line.ja === 'string' && Number.isFinite(line.start) && Number.isFinite(line.end) && line.end > line.start));
}
function totalDuration(lesson) { return lesson.tracks.reduce((sum, track) => sum + track.duration, 0); }
function groupName(track) { return GROUP_NAMES[track.type] || track.title; }
function lessonTitle(lesson) { return lesson.subtitle || lesson.title; }
function lessonSummary(lesson) {
  const sentences = lesson.tracks.reduce((sum, track) => sum + track.lines.length, 0), words = lesson.vocabulary?.words?.length;
  return `${sentences} 句${words ? ` · ${words} 词` : ''} · ${formatTime(totalDuration(lesson))}`;
}
function rangesLabel(numbers) {
  const parts = [];
  for (let index = 0; index < numbers.length; index++) {
    let end = index;
    while (end + 1 < numbers.length && numbers[end + 1] === numbers[end] + 1) end++;
    parts.push(end > index ? `${numbers[index]}～${numbers[end]}` : String(numbers[index]));
    index = end;
  }
  return `第 ${parts.join('、')} 课`;
}

// Library
function recentLesson() {
  const id = preference('recentLesson') || preference('lastLesson');
  return state.lessons.find(lesson => lesson.id === id && currentLesson(lesson)) || null;
}
function renderLibrary() {
  const list = $('lesson-list'); list.replaceChildren();
  const known = state.lessons.filter(lesson => lesson.number >= 1 && lesson.number <= state.totalLessons);
  const imported = known.filter(currentLesson), setup = !!state.setup;
  const recent = recentLesson();
  $('welcome').hidden = setup || known.length > 0;
  $('welcome-install').hidden = standalone();
  $('course-head').hidden = setup || !known.length; list.hidden = setup || !known.length;
  $('course-count').textContent = `第二版 · 已导入 ${imported.length} 课，共 ${state.totalLessons} 课`;
  for (const lesson of [...known].sort((a, b) => a.number - b.number)) {
    const available = currentLesson(lesson);
    const row = text('button', '', `lesson-row row${available ? '' : ' legacy'}`); row.type = 'button';
    const tile = text('span', String(lesson.number), `tile${available && lesson === recent ? ' tile-grad' : ''}`); tile.setAttribute('aria-hidden', 'true');
    if (available && lesson !== recent) tile.style.background = tileColor(lesson.number);
    const details = text('span', '', 'row-text');
    details.append(available ? japanese('strong', lessonTitle(lesson), null) : text('strong', `第 ${lesson.number} 课`));
    details.append(text('small', available ? lessonSummary(lesson) : '需更新 · 请导入新版文型、例文、会话课程包'));
    row.append(tile, details, icon('chevron', 'chevron'));
    row.setAttribute('aria-label', `第 ${lesson.number} 课，${available ? lessonTitle(lesson) : '需要更新'}${lesson === recent ? '，上次学到这里' : ''}`);
    if (available) row.addEventListener('click', () => openLesson(lesson));
    else row.addEventListener('click', () => {
      notice('本机保存的是旧版问题音频包。请导入新版文型、例文、会话课程包，原有内容不会作为新版播放。');
      requestImport();
    });
    list.append(row);
  }
  const missing = [];
  for (let number = 1; number <= state.totalLessons; number++) if (!known.some(lesson => lesson.number === number)) missing.push(number);
  $('pending').hidden = setup || !known.length || !missing.length;
  if (missing.length) {
    $('pending-title').textContent = rangesLabel(missing); $('pending-detail').textContent = `共 ${missing.length} 课`;
    $('pending-tile').textContent = missing.length > 1 ? `${missing[0]}+` : String(missing[0]);
  }
  renderContinue();
  updateOfflineLabel();
}
function renderContinue() {
  const lesson = recentLesson();
  $('continue-card').hidden = !lesson || !!state.setup;
  if (!lesson) return;
  const saved = preference(`position:v2:${lesson.id}`);
  const track = lesson.tracks[Number.isInteger(saved?.track) && saved.track >= 0 && saved.track < 3 ? saved.track : 0];
  $('continue-tile').textContent = String(lesson.number);
  $('continue-eyebrow').textContent = `继续学习 · 第 ${lesson.number} 课`;
  $('continue-title').textContent = lessonTitle(lesson);
  $('continue-detail').textContent = Number.isFinite(saved?.time) && saved.time > 0 ? `${groupName(track)} · 停在 ${formatTime(saved.time)}` : '从文型开始';
  const playing = state.lesson === lesson && !audio.paused && !audio.ended && state.scope !== 'vocabulary';
  setIcon($('continue-play'), playing ? 'pause' : 'play');
  $('continue-play').setAttribute('aria-label', playing ? '暂停' : `继续播放第 ${lesson.number} 课`);
}
async function continuePlayback() {
  const lesson = recentLesson();
  if (!lesson) return;
  if (state.lesson === lesson && state.scope !== 'vocabulary') { togglePlayback(); return; }
  try {
    if (state.lesson !== lesson && !await prepareLesson(lesson)) return;
    if (state.scope === 'vocabulary') showStudyPanel('text');
    playAudio();
  } catch (reason) { error(reason.message); }
}
function showLibrary() {
  leavingLesson = false;
  openingLesson++;
  $('library-view').hidden = false; $('lesson-view').hidden = true;
  history.replaceState({ view: 'library' }, '', BASE.pathname); preference('lastLesson', null);
  renderContinue(); updateNowPlaying();
  window.scrollTo({ top: libraryScroll, behavior: 'instant' });
}
function backToLibrary() {
  if ($('lesson-view').hidden || leavingLesson) return;
  if (history.state?.view !== 'lesson') { showLibrary(); return; }
  leavingLesson = true;
  history.back();
}
window.addEventListener('popstate', () => {
  leavingLesson = false;
  const lesson = state.lessons.find(item => item.id === location.hash.slice(1));
  if (lesson) void openLesson(lesson);
  else showLibrary();
});

// Lesson loading
async function readLessonFiles(lesson, resources) {
  const vocabulary = new Map();
  for (const resource of resources) {
    const file = await getFile(lesson.id, resource.src);
    if (!file?.blob?.size) throw new Error(`第 ${lesson.number} 课找不到音频文件：${resource.src}。请重新导入这课的课程包。`);
    if (lesson.vocabulary?.audio?.includes(resource)) vocabulary.set(resource.src, { blob: file.blob, url: null });
  }
  return vocabulary;
}
function activateLesson(lesson, sources) {
  savePosition(); audio.pause(); clearSelection(); releaseVocabularySources();
  vocabularySources = sources; vocabularyLoading = null;
  state.lesson = lesson; state.panel = null; npKey = ''; barKey = '';
  $('lesson-kicker').textContent = `第 ${lesson.number} 课`;
  $('lesson-title').textContent = lessonTitle(lesson);
  $('lesson-meta').textContent = `${lesson.tracks.map(track => `${groupName(track)} ${track.lines.length}`).join(' · ')} · 共 ${formatTime(totalDuration(lesson))}`;
  renderSections(); renderVocabulary();
}
function rememberOpenLesson(lesson) {
  preference('lastLesson', lesson.id); preference('recentLesson', lesson.id);
  if (history.state?.view === 'lesson') {
    history.replaceState({ view: 'lesson' }, '', `#${lesson.id}`);
  } else {
    history.replaceState({ view: 'library' }, '', BASE.pathname);
    history.pushState({ view: 'lesson' }, '', `#${lesson.id}`);
  }
}
// Loads a lesson into the player without leaving the current screen (mini player, continue card).
async function prepareLesson(lesson) {
  if (state.lesson === lesson) return true;
  pausePlayback();
  const request = ++openingLesson;
  let sources;
  try { sources = await readLessonFiles(lesson, [...lesson.tracks, ...(lesson.vocabulary?.audio || [])]); }
  catch (reason) { if (request === openingLesson) throw reason; return false; }
  if (request !== openingLesson) return false;
  activateLesson(lesson, sources);
  const saved = preference(`position:v2:${lesson.id}`);
  selectTrack(saved && Number.isInteger(saved.track) && saved.track >= 0 && saved.track < 3 ? saved.track : 0,
    false, Number.isFinite(saved?.time) ? saved.time : 0, false, { scope: 'lesson' });
  const savedPanel = preference(`panel:${lesson.id}`);
  showStudyPanel(savedPanel === 'vocabulary' ? 'vocabulary' : 'text', false);
  preference('recentLesson', lesson.id);
  return true;
}
async function openLesson(lesson) {
  if (!currentLesson(lesson)) {
    showLibrary();
    notice('此课需要更新。请导入包含完整文型、例文、会话的新版课程包。');
    return;
  }
  try {
    if (state.lesson !== lesson) { if (!await prepareLesson(lesson)) return; }
    else updateIndicators();
    if (!$('library-view').hidden) libraryScroll = window.scrollY;
    $('library-view').hidden = true; $('lesson-view').hidden = false;
    updateOfflineLabel(); rememberOpenLesson(lesson);
    window.scrollTo({ top: 0, behavior: 'instant' });
    updateNowPlaying();
  } catch (reason) { error(reason.message); }
}

// Lesson rendering
function renderVocabulary() {
  const list = $('vocabulary-list'); list.replaceChildren(); wordButtons = [];
  const words = vocabularyWords();
  const recorded = words.filter((_, index) => playableWord(index)).length;
  $('vocabulary-count').textContent = !words.length ? '' : recorded === words.length ? `${words.length} 个单词 ·` : `${words.length} 个单词 · ${recorded} 个可点读 ·`;
  $('vocabulary-hint').textContent = !words.length ? '导入新版课程包后，可以在这里点词听原声。' : recorded === words.length ? '轻点一行，只听这个词的原声' : '轻点一行听原声，标注“暂无录音”的词不能点读';
  $('vocabulary-update').hidden = words.length > 0 && recorded > 0;
  list.hidden = !words.length;
  $('vocabulary-update-message').textContent = words.length ? '当前词表暂无可点读录音。请选择包含单词原声的新版课程包。' : '这个课程包还没有单词点读。重新选择含单词的课程包，即可保留课文并加入词表。';
  words.forEach((word, index) => {
    const row = text('button', '', 'word-row'); row.type = 'button'; row.dataset.wordIndex = String(index);
    const playable = playableWord(index); row.disabled = !playable;
    row.setAttribute('aria-label', wordAccessibleLabel(word, playable));
    const content = text('span', '', 'word-content');
    content.append(japanese('span', word.ja, word.ruby, 'word-ja'));
    // The separate reading line stays only when the furigana does not already spell out the whole reading.
    const covered = rubyReading(word.ruby)?.normalize('NFKC') === word.reading?.trim().normalize('NFKC');
    if (distinctReading(word) && !covered) { const reading = text('span', word.reading, 'word-reading'); reading.lang = 'ja'; content.append(reading); }
    if (word.zh) content.append(text('span', word.zh, 'word-zh'));
    row.append(content, playable ? icon('speaker', 'now-icon') : text('span', '暂无录音', 'word-status'));
    row.addEventListener('click', () => selectWord(index)); list.append(row); wordButtons.push({ row, index });
  });
}
function restoreTextSelection() {
  if (!state.lesson) return;
  const saved = preference(`position:v2:${state.lesson.id}`);
  selectTrack(Number.isInteger(saved?.track) && saved.track >= 0 && saved.track < 3 ? saved.track : state.track,
    false, Number.isFinite(saved?.time) ? saved.time : 0, false, { scope: 'group' });
}
async function prepareVocabularyPanel() {
  const lesson = state.lesson, resources = lesson.vocabulary?.audio || [];
  if (resources.every(resource => vocabularySources.has(resource.src))) return;
  for (const { row } of wordButtons) row.disabled = true;
  $('vocabulary-hint').textContent = '正在读取本机单词录音…';
  if (vocabularyLoading) return;
  const loading = readLessonFiles(lesson, resources);
  vocabularyLoading = loading;
  try {
    const sources = await loading;
    if (state.lesson !== lesson || vocabularyLoading !== loading) return;
    vocabularySources = sources;
    renderVocabulary();
  } catch (reason) {
    if (state.lesson === lesson && state.panel === 'vocabulary' && vocabularyLoading === loading) error(reason.message);
  } finally {
    if (vocabularyLoading === loading) vocabularyLoading = null;
  }
}
function showStudyPanel(panel, remember = true) {
  if (!state.lesson) return;
  if (panel === 'text' && state.scope === 'vocabulary') restoreTextSelection();
  else if (panel === 'vocabulary' && state.panel !== 'vocabulary') {
    savePosition(); audio.pause(); clearSelection(); state.scope = 'vocabulary';
    if (state.mode === 'repeat') setMode('lesson');
    audio.removeAttribute('src'); audio.load();
    $('play').disabled = true; $('previous').disabled = true; $('next').disabled = true;
    if ('mediaSession' in navigator) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; }
  }
  state.panel = panel;
  $('text-panel').hidden = panel !== 'text'; $('vocabulary-panel').hidden = panel !== 'vocabulary';
  for (const [id, value] of [['show-text', 'text'], ['show-vocabulary', 'vocabulary']]) $(id).setAttribute('aria-pressed', String(panel === value));
  if (remember) preference(`panel:${state.lesson.id}`, panel);
  if (panel === 'vocabulary') void prepareVocabularyPanel();
  updatePlayback(); updateProgress();
}
function selectWord(index) {
  if (!currentLesson(state.lesson) || !playableWord(index)) return;
  savePosition(); audio.pause(); clearSelection();
  const word = vocabularyWords()[index], resource = wordAudio(word), version = selectionVersion;
  state.wordIndex = index; state.scope = 'vocabulary';
  state.segment = { start: word.start, end: word.end, wordIndex: index, kind: 'vocabulary', version, finishing: false };
  loadAudioSelection(resource, word.start, version); audio.loop = false;
  $('play').disabled = false;
  $('previous').disabled = adjacentWord(-1) === null; $('next').disabled = adjacentWord(1) === null;
  $('previous').setAttribute('aria-label', '上一个有录音的单词'); $('next').setAttribute('aria-label', '下一个有录音的单词');
  updateIndicators(); updateProgress(); updateMetadata(); playAudio();
}
function renderSections() {
  const container = $('learning-sections'); container.replaceChildren(); lineButtons = []; groupButtons = [];
  state.lesson.tracks.forEach((track, index) => {
    const section = text('section', '', 'learning-group'); section.id = `group-${track.type}`;
    section.setAttribute('aria-labelledby', `group-title-${track.type}`);
    const heading = text('div', '', 'group-head');
    const title = text('h2', groupName(track)); title.id = `group-title-${track.type}`;
    const play = text('button', '', 'group-play'); play.type = 'button'; play.append(icon('play'));
    play.setAttribute('aria-label', `连播${groupName(track)}`);
    play.addEventListener('click', () => {
      if (state.scope === 'group' && state.track === index && !state.segment && !audio.paused && !audio.ended) pausePlayback();
      else selectTrack(index, true, 0, true, { scope: 'group' });
    });
    groupButtons.push(play);
    heading.append(title, text('span', `${track.lines.length} 句 · ${formatTime(track.duration)}`, 'group-meta'), play);
    const numbered = track.type !== 'conversation';
    const lines = text('div', '', `card list sentence-list${numbered ? ' numbered' : ''}`);
    let pair = 0;
    track.lines.forEach((line, lineIndex) => {
      const follows = track.type === 'examples' && lineIndex > 0 && line.speaker === '回答';
      if (!follows) pair++;
      const button = text('button', '', 'sentence-row'); button.type = 'button';
      if (track.type === 'examples') button.classList.add(follows ? 'pair-follow' : 'pair-start');
      button.dataset.track = String(index); button.dataset.line = String(lineIndex);
      button.setAttribute('aria-label', `播放${groupName(track)}第 ${lineIndex + 1} 句：${line.ja}${state.bilingual && line.zh ? `，${line.zh}` : ''}`);
      const content = text('span', '', 'sentence-content');
      if (line.speaker) { const speaker = text('span', line.speaker, 'speaker'); if (track.type === 'conversation') speaker.lang = 'ja'; content.append(speaker); }
      content.append(japanese('span', line.ja, line.ruby, 'ja'));
      if (typeof line.zh === 'string' && line.zh.trim()) content.append(text('span', line.zh, 'zh'));
      if (typeof line.note === 'string' && line.note.trim()) {
        const note = text('span', '', 'line-note'); note.append(text('b', '说明'), text('span', line.note)); content.append(note);
      }
      if (numbered) button.append(text('span', track.type === 'patterns' ? String(lineIndex + 1) : follows ? '' : String(pair), 'sentence-mark'));
      button.append(content, icon('speaker', 'now-icon'));
      button.addEventListener('click', () => selectTrack(index, true, line.start, true, { scope: 'sentence', lineIndex }));
      lines.append(button); lineButtons.push({ button, line, index, lineIndex });
    });
    section.append(heading, lines);
    if (index === 0) section.append(text('p', '轻点任意一句，只播这一句。', 'footnote'));
    container.append(section);
  });
}

// Display settings
function setFurigana(enabled) {
  state.furigana = enabled; document.body.classList.toggle('furigana-off', !enabled);
  $('furigana').setAttribute('aria-checked', String(enabled));
  preference('furigana', enabled);
}
function setBilingual(enabled) {
  state.bilingual = enabled; document.body.classList.toggle('japanese-only', !enabled);
  $('bilingual').setAttribute('aria-checked', String(enabled));
  for (const { row, index } of wordButtons) row.setAttribute('aria-label', wordAccessibleLabel(vocabularyWords()[index], playableWord(index)));
  for (const { button, line, index, lineIndex } of lineButtons) button.setAttribute('aria-label', `播放${groupName(state.lesson.tracks[index])}第 ${lineIndex + 1} 句：${line.ja}${enabled && line.zh ? `，${line.zh}` : ''}`);
  preference('bilingual', enabled); preference('vocabularyBilingual', enabled);
}
function buildSizeSteps() {
  const track = $('size-steps'); track.replaceChildren(text('span', '', 'size-fill'));
  JA_SIZES.forEach(([name], index) => {
    const step = text('button', '', 'size-step'); step.type = 'button';
    step.setAttribute('aria-label', `日文字号：${name}`); step.append(text('span', ''));
    step.addEventListener('click', () => setJaSize(index)); track.append(step);
  });
}
function setJaSize(index) {
  state.jaSize = Number.isInteger(index) && index >= 0 && index < JA_SIZES.length ? index : 1;
  const [name, points] = JA_SIZES[state.jaSize];
  document.documentElement.style.setProperty('--ja-size', `${(points / 17).toFixed(3)}rem`);
  $('size-name').textContent = `${name} · ${points} pt`;
  $('size-steps').style.setProperty('--fill', `${state.jaSize * 20}%`);
  [...$('size-steps').querySelectorAll('.size-step')].forEach((step, at) => {
    step.setAttribute('aria-pressed', String(at === state.jaSize)); step.classList.toggle('passed', at < state.jaSize);
  });
  preference('jaSize', state.jaSize);
}

// Now Playing, mini player and indicators
function currentLineIndex(track, settled = false) {
  if (state.segment && Number.isInteger(state.segment.lineIndex)) return state.segment.lineIndex;
  const time = audio.currentTime || 0;
  const inside = track.lines.findIndex(line => time >= line.start && time < line.end);
  if (inside >= 0 || !settled) return inside;
  let last = -1; track.lines.forEach((line, index) => { if (line.start <= time) last = index; });
  return last;
}
function nowLabels() {
  const lesson = state.lesson;
  if (state.scope === 'vocabulary') {
    const word = selectedWord(), words = vocabularyWords();
    return { head: `第 ${lesson.number} 课 · 单词`, title: word?.ja || '单词点读', count: word ? `单词 ${state.wordIndex + 1} / ${words.length}` : '', mini: word ? `第 ${lesson.number} 课 · 单词` : '', media: word?.ja || '单词点读' };
  }
  const track = lesson.tracks[state.track], at = currentLineIndex(track, true), line = track.lines[at];
  const position = at >= 0 ? `${at + 1}/${track.lines.length}` : `${track.lines.length} 句`;
  return {
    head: `第 ${lesson.number} 课 · ${groupName(track)}`,
    title: line?.ja || groupName(track),
    count: at >= 0 ? `第 ${at + 1} / ${track.lines.length} 句` : `${groupName(track)} · ${state.track + 1} / 3`,
    mini: `第 ${lesson.number} 课 · ${groupName(track)} ${position}${state.segment ? ' · 单句' : ''}`,
    media: state.segment ? `${groupName(track)} · 第 ${state.segment.lineIndex + 1} 句` : groupName(track)
  };
}
function renderNowPlaying() {
  if (!state.lesson) return;
  const vocabulary = state.scope === 'vocabulary';
  const key = `${state.lesson.id}|${vocabulary ? 'words' : state.track}`;
  if (key === npKey) return;
  npKey = key; npCurrent = -1; npRows = [];
  const box = $('np-lyrics'); box.replaceChildren();
  if (vocabulary) {
    vocabularyWords().forEach((word, index) => {
      const row = text('button', '', 'np-line'); row.type = 'button'; row.disabled = !playableWord(index);
      row.setAttribute('aria-label', wordAccessibleLabel(word, playableWord(index)));
      row.append(japanese('span', word.ja, word.ruby, 'ja'));
      if (word.zh) row.append(text('span', word.zh, 'zh'));
      row.addEventListener('click', () => selectWord(index));
      box.append(row); npRows.push(row);
    });
    return;
  }
  const track = state.lesson.tracks[state.track];
  box.append(text('p', groupName(track), 'np-section'));
  track.lines.forEach((line, index) => {
    const row = text('button', '', 'np-line'); row.type = 'button';
    row.setAttribute('aria-label', `从这句播放：${line.ja}${state.bilingual && line.zh ? `，${line.zh}` : ''}`);
    if (line.speaker) { const speaker = text('span', line.speaker, 'speaker'); if (track.type === 'conversation') speaker.lang = 'ja'; row.append(speaker); }
    row.append(japanese('span', line.ja, line.ruby, 'ja'));
    if (line.zh) row.append(text('span', line.zh, 'zh'));
    row.addEventListener('click', () => jumpToLine(index));
    box.append(row); npRows.push(row);
  });
}
function scrollLyrics(behavior) {
  const row = npRows[npCurrent], box = $('np-lyrics');
  if (!row || !$('now-playing').open) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  box.scrollTo({ top: Math.max(0, row.offsetTop - box.clientHeight * 0.28), behavior: reduce ? 'auto' : behavior });
}
function renderBars() {
  const vocabulary = state.scope === 'vocabulary', track = state.lesson.tracks[state.track];
  const key = `${npKey}|${state.segment ? `s${state.segment.start}` : 'all'}`;
  if (key === barKey) return;
  barKey = key; const bars = $('np-bars'); bars.replaceChildren();
  const spans = vocabulary || state.segment ? [1] : track.lines.map(line => Math.max(0.3, line.end - line.start));
  barNodes = spans.map(weight => { const bar = text('span', ''); bar.style.flexGrow = String(weight); bars.append(bar); return bar; });
}
function updateBars() {
  if (!barNodes.length || !state.lesson) return;
  const time = audio.currentTime || 0;
  if (state.scope === 'vocabulary' || state.segment) {
    const start = state.segment?.start || 0, end = state.segment?.end || audio.duration || 1;
    barNodes[0].style.setProperty('--fill', `${Math.max(0, Math.min(100, 100 * (time - start) / Math.max(0.01, end - start)))}%`);
    return;
  }
  state.lesson.tracks[state.track].lines.forEach((line, index) => {
    barNodes[index]?.style.setProperty('--fill', `${Math.max(0, Math.min(100, 100 * (time - line.start) / (line.end - line.start)))}%`);
  });
}
function updateNowPlaying() {
  const lesson = state.lesson, active = !!lesson && (state.scope !== 'vocabulary' || !!selectedWord());
  $('mini-player').hidden = !active || $('now-playing').open;
  if (!lesson) return;
  renderNowPlaying(); renderBars(); updateBars();
  const labels = nowLabels();
  $('now-title').textContent = labels.head; $('now-detail').textContent = lessonTitle(lesson);
  $('track-count').textContent = labels.count;
  $('mini-tile').textContent = String(lesson.number);
  $('mini-title').textContent = labels.title; $('mini-subtitle').textContent = labels.mini;
  $('mini-next').disabled = $('next').disabled;
  $('mini-next').setAttribute('aria-label', $('next').getAttribute('aria-label') || '下一组');
  const current = state.scope === 'vocabulary' ? (Number.isInteger(state.wordIndex) ? state.wordIndex : -1) : currentLineIndex(lesson.tracks[state.track], true);
  if (current !== npCurrent) {
    npRows[npCurrent]?.classList.remove('current'); npRows[npCurrent]?.removeAttribute('aria-current');
    npCurrent = current;
    npRows[current]?.classList.add('current'); npRows[current]?.setAttribute('aria-current', 'true');
    scrollLyrics('smooth');
  }
}
function openNowPlaying() {
  if (!state.lesson) return;
  renderNowPlaying(); updateNowPlaying();
  openSheet('now-playing'); $('mini-player').hidden = true;
  requestAnimationFrame(() => scrollLyrics('auto'));
}
function jumpToLine(lineIndex) {
  if (!currentLesson(state.lesson) || state.scope === 'vocabulary') return;
  const line = state.lesson.tracks[state.track].lines[lineIndex];
  if (!line) return;
  if (state.segment || !Number.isFinite(audio.duration)) {
    selectTrack(state.track, true, line.start, true, { scope: state.scope === 'lesson' ? 'lesson' : 'group' });
    return;
  }
  seekTo(line.start);
  if (audio.paused || audio.ended) playAudio();
}
function updateIndicators() {
  if (!state.lesson) return;
  updateModeHint();
  const playing = !audio.paused && !audio.ended;
  for (const { button, line, index, lineIndex } of lineButtons) {
    const selected = state.scope !== 'vocabulary' && index === state.track && (state.segment ? state.segment.lineIndex === lineIndex : audio.currentTime >= line.start && audio.currentTime < line.end);
    button.classList.toggle('current-sentence', selected);
    if (selected) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
  }
  groupButtons.forEach((button, index) => {
    const active = state.scope !== 'vocabulary' && index === state.track && playing && !state.segment;
    button.classList.toggle('active', active); setIcon(button, active ? 'pause' : 'play');
    button.setAttribute('aria-label', active ? `暂停${groupName(state.lesson.tracks[index])}` : `连播${groupName(state.lesson.tracks[index])}`);
  });
  for (const { row, index } of wordButtons) {
    const active = state.scope === 'vocabulary' && state.wordIndex === index;
    row.classList.toggle('current-sentence', active);
    if (active) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
  }
  $('play-all').classList.toggle('active', state.scope === 'lesson' && state.mode === 'lesson' && playing);
  updateNowPlaying();
}

// Playback engine (logic carried over from 2.8)
function clearSelection() {
  selectionVersion++; clearTimeout(sentenceTimer); sentenceTimer = undefined;
  if (metadataHandler) audio.removeEventListener('loadedmetadata', metadataHandler);
  metadataHandler = undefined; state.segment = null; state.wordIndex = null; state.seeking = false; playbackWanted = false;
}
function releaseVocabularySources() {
  for (const source of vocabularySources.values()) if (source.url) URL.revokeObjectURL(source.url);
  vocabularySources.clear();
}
function retryVocabularyBlob() {
  const resource = playbackResource(), cached = resource && vocabularySources.get(resource.src);
  if (state.scope !== 'vocabulary' || !selectedWord() || !cached?.blob?.size || cached.url || ![2, 3, 4].includes(audio.error?.code)) return false;
  const nativeSource = new URL(`__local/${state.lesson.id}/${resource.src}`, BASE).href;
  if (audio.getAttribute('src') !== nativeSource) return false;
  // Keep this synchronous: the Blob was already verified/read when opening the lesson.
  // A stale IDB promise must never start another word or undo a user pause.
  try { cached.url = URL.createObjectURL(cached.blob); } catch { return false; }
  const version = selectionVersion, resume = playbackWanted;
  const start = Math.max(state.segment.start, Math.min(audio.currentTime || state.segment.start, state.segment.end));
  loadAudioSelection(resource, start, version);
  if (resume && version === selectionVersion && playbackWanted) playAudio();
  return true;
}
function loadAudioSelection(track, start, version) {
  const source = state.scope === 'vocabulary' && vocabularySources.get(track.src)?.url || new URL(`__local/${state.lesson.id}/${track.src}`, BASE).href;
  mediaLoadVersion++;
  const applyStart = () => {
    if (version !== selectionVersion || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    const target = Math.max(0, Math.min(start, Math.max(0, audio.duration - 0.01)));
    if (state.segment && (state.segment.start >= audio.duration || state.segment.end > audio.duration + 0.3)) {
      audio.pause(); error(`${track.src} 的单句时间超出音频长度，请重新导入经核对的课程包。`); return;
    }
    try { audio.currentTime = target; } catch { error(`无法定位音频：${track.src}。请等待载入后重试。`); }
    updateProgress(); armSentenceStop();
  };
  if (audio.currentSrc === source && audio.readyState >= 1) applyStart();
  else {
    if (metadataHandler) audio.removeEventListener('loadedmetadata', metadataHandler);
    audio.src = source;
    metadataHandler = () => {
      if (version !== selectionVersion || audio.currentSrc !== source) return;
      audio.removeEventListener('loadedmetadata', metadataHandler); metadataHandler = undefined; applyStart();
    };
    audio.addEventListener('loadedmetadata', metadataHandler); audio.load();
    // Set the default start before play while preserving the original user gesture; metadata rechecks it.
    try { audio.currentTime = Math.max(0, start); } catch { /* Some engines wait for metadata. */ }
  }
}
function selectTrack(index, play = false, start = 0, savePrevious = true, options = {}) {
  if (!currentLesson(state.lesson) || !Number.isInteger(index) || index < 0 || index >= state.lesson.tracks.length) return;
  if (savePrevious) savePosition();
  audio.pause(); clearSelection();
  const version = selectionVersion, track = state.lesson.tracks[index];
  state.track = index; state.scope = options.scope || 'group';
  if (state.mode === 'repeat' && state.scope !== 'lesson') setMode('lesson');
  if (state.scope === 'sentence') {
    const line = track.lines[options.lineIndex];
    if (!line) return;
    state.segment = { start: line.start, end: line.end, lineIndex: options.lineIndex, version, finishing: false };
    start = line.start;
  }
  loadAudioSelection(track, start, version);
  audio.loop = state.scope !== 'vocabulary' && state.mode === 'single' && !state.segment;
  $('play').disabled = false;
  updateGroupNavigation();
  $('previous').setAttribute('aria-label', '上一组音频'); $('next').setAttribute('aria-label', '下一组音频');
  if (state.panel === 'vocabulary') showStudyPanel('text');
  updateIndicators(); updateProgress(); updateMetadata();
  if (play) playAudio();
}
function startLesson(mode) {
  if (!currentLesson(state.lesson)) return;
  setMode(mode);
  selectTrack(0, true, 0, true, { scope: 'lesson' });
}
function playAudio() {
  if (!currentLesson(state.lesson) || state.scope === 'vocabulary' && !selectedWord()) return;
  openingLesson++;
  if (!navigator.serviceWorker?.controller) { error('本机离线播放器尚未就绪，请联网重新打开 App 后再播放。'); return; }
  if (state.segment && audio.readyState >= 1 && (audio.currentTime >= state.segment.end - 0.01 || audio.currentTime < state.segment.start)) audio.currentTime = state.segment.start;
  else if (audio.ended) audio.currentTime = 0;
  playbackWanted = true; claimPlaybackSession();
  const version = selectionVersion, loadVersion = mediaLoadVersion; hideError(); notice('');
  audio.play()?.catch(reason => {
    if (version !== selectionVersion || loadVersion !== mediaLoadVersion || !playbackWanted || reason.name === 'AbortError') return;
    if (retryVocabularyBlob()) return;
    playbackWanted = false;
    error(reason.name === 'NotAllowedError' ? '手机暂停了自动播放。请回到播放器，点一下播放键继续。' : `第 ${state.lesson.number} 课无法播放音频文件：${playbackResource()?.src || '未指定文件'}。请重新导入这课的课程包后重试。`);
    updatePlayback();
  });
}
// iOS keeps lock-screen controls longer for a declared playback session; unsupported browsers ignore it.
function claimPlaybackSession() { try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch { /* Optional API. */ } }
function pausePlayback() { openingLesson++; playbackWanted = false; audio.pause(); }
function togglePlayback() { if (audio.paused || audio.ended) playAudio(); else pausePlayback(); }
function setMode(mode) {
  state.mode = ['single', 'repeat'].includes(mode) ? mode : 'lesson'; audio.loop = state.scope !== 'vocabulary' && state.mode === 'single' && !state.segment;
  for (const button of document.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
  preference('mode', state.mode); updateGroupNavigation(); updateIndicators(); updateModeHint();
}
// 整课循环 always restarts from 文型 0:00, exactly like the button on the lesson page.
function chooseMode(mode) { if (mode === 'repeat') startLesson('repeat'); else setMode(mode); }
function updateModeHint() {
  let message = '当前内容播完停止。';
  if (state.scope === 'vocabulary') message = '单词每次只播一遍。选「整课循环」会从本课文型开始连播。';
  else if (state.mode === 'repeat') message = '本课会话结束后播放下一课，末课回到已导入的第一课。再选一次从当前课开头播放。';
  else if (state.mode === 'single') message = state.segment ? '反复播放选中的这一句。' : '反复播放选中的这一组。';
  else if (state.scope === 'lesson') message = '文型 → 例文 → 会话，播完停止。';
  for (const hint of document.querySelectorAll('[data-mode-hint]')) if (hint.textContent !== message) hint.textContent = message;
}
function finishSentence(version = selectionVersion) {
  const segment = state.segment;
  if (!segment || segment.version !== version || version !== selectionVersion || segment.finishing) return;
  segment.finishing = true; clearTimeout(sentenceTimer);
  if (state.mode === 'single' && segment.kind !== 'vocabulary') {
    audio.currentTime = segment.start; segment.finishing = false;
    if (audio.paused || audio.ended) playAudio(); else armSentenceStop();
  } else {
    pausePlayback(); audio.currentTime = Math.min(segment.end, Number.isFinite(audio.duration) ? audio.duration : segment.end);
    segment.finishing = false; updatePlayback(); updateProgress();
  }
}
function armSentenceStop() {
  clearTimeout(sentenceTimer); sentenceTimer = undefined;
  const segment = state.segment;
  if (!segment || audio.paused || audio.ended || audio.readyState < 1 || segment.finishing || state.seeking) return;
  const remaining = segment.end - audio.currentTime;
  if (remaining <= 0.008) { finishSentence(segment.version); return; }
  sentenceTimer = setTimeout(() => {
    if (segment.version !== selectionVersion || audio.paused || state.segment !== segment) return;
    if (audio.currentTime >= segment.end - 0.025) finishSentence(segment.version); else armSentenceStop();
  }, Math.max(10, remaining * 1000 / (audio.playbackRate || 1)));
}
function updatePlayback() {
  const playing = !audio.paused && !audio.ended;
  for (const id of ['play', 'mini-play']) { setIcon($(id), playing ? 'pause' : 'play'); $(id).setAttribute('aria-label', playing ? '暂停' : '播放'); }
  $('mini-play').disabled = $('play').disabled;
  updateIndicators(); armSentenceStop(); refreshUpdatePrompt(); renderContinue();
  if ('mediaSession' in navigator) { navigator.mediaSession.playbackState = state.lesson && (state.scope !== 'vocabulary' || selectedWord()) ? playing ? 'playing' : 'paused' : 'none'; updateMediaPosition(); }
}
function updateProgress() {
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : playbackResource()?.duration || 0;
  const start = state.segment?.start || 0, end = state.segment?.end || duration;
  const position = Math.max(start, Math.min(audio.currentTime || 0, end));
  if (!state.seeking) {
    $('seek').min = String(start); $('seek').max = String(end || 1); $('seek').value = String(position);
    $('elapsed').textContent = formatTime(state.scope === 'vocabulary' ? position - start : position);
  }
  $('duration').textContent = `-${formatTime(Math.max(0, end - position))}`;
  $('seek').setAttribute('aria-valuetext', `${formatTime(state.scope === 'vocabulary' ? position - start : position)}，共 ${formatTime(state.scope === 'vocabulary' ? end - start : end)}`);
  updateIndicators(); updateMediaPosition();
  if (Date.now() - lastSave > 5000) savePosition();
}
function savePosition() {
  if (currentLesson(state.lesson) && state.scope !== 'vocabulary') { preference(`position:v2:${state.lesson.id}`, { track: state.track, time: audio.currentTime || 0 }); lastSave = Date.now(); }
}
function updateMetadata() {
  if (!('mediaSession' in navigator) || !('MediaMetadata' in window) || !state.lesson) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: nowLabels().media,
    artist: `第 ${state.lesson.number} 课 · 大家的日本语`, album: state.scope === 'vocabulary' ? `第 ${state.lesson.number} 课 · 单词` : lessonTitle(state.lesson),
    artwork: [{ src: new URL('icons/icon-512.png', BASE).href, sizes: '512x512', type: 'image/png' }] });
}
function updateMediaPosition() {
  if (!navigator.mediaSession?.setPositionState || !Number.isFinite(audio.duration) || !audio.duration) return;
  const start = state.scope === 'vocabulary' ? state.segment?.start || 0 : 0;
  const duration = state.scope === 'vocabulary' && state.segment ? state.segment.end - start : audio.duration;
  try { navigator.mediaSession.setPositionState({ duration, playbackRate: 1, position: Math.max(0, Math.min((audio.currentTime || 0) - start, duration)) }); } catch { /* Unsupported action must not disable playback. */ }
}
function seekTo(position) {
  if (!Number.isFinite(position) || !Number.isFinite(audio.duration)) return;
  const min = state.segment?.start || 0, max = state.segment?.end || audio.duration;
  audio.currentTime = Math.max(min, Math.min(position, max)); updateProgress(); armSentenceStop();
}
function updateGroupNavigation() {
  if (!state.lesson || state.scope === 'vocabulary') return;
  const wraps = state.mode === 'repeat' && state.scope === 'lesson';
  $('previous').disabled = !wraps && state.track === 0;
  $('next').disabled = !wraps && state.track === state.lesson.tracks.length - 1;
}
function moveGroup(delta) {
  if (state.scope === 'vocabulary') { if (selectedWord()) { const next = adjacentWord(delta); if (next !== null) selectWord(next); } return; }
  if (!state.lesson) return;
  const index = state.track + delta;
  if (index >= 0 && index < state.lesson.tracks.length) {
    selectTrack(index, true, 0, true, { scope: state.scope === 'lesson' ? 'lesson' : 'group' });
    return;
  }
  if (state.mode !== 'repeat' || state.scope !== 'lesson') return;
  const courses = state.lessons.filter(currentLesson); // allLessons returns these in lesson-number order.
  const here = courses.findIndex(lesson => lesson.id === state.lesson.id);
  if (here < 0) return;
  const target = courses[(here + delta + courses.length) % courses.length];
  const changed = target.id !== state.lesson.id;
  if (changed) {
    activateLesson(target, new Map());
    preference('recentLesson', target.id);
    if (!$('lesson-view').hidden) rememberOpenLesson(target);
  }
  selectTrack(delta > 0 ? 0 : target.tracks.length - 1, true, 0, !changed, { scope: 'lesson' });
  if (changed) { showStudyPanel('text', false); renderLibrary(); }
}
function installMediaActions() {
  if (!('mediaSession' in navigator)) return;
  const handlers = { play: playAudio, pause: pausePlayback, previoustrack: () => moveGroup(-1), nexttrack: () => moveGroup(1),
    seekto: details => seekTo(details.seekTime + (state.scope === 'vocabulary' ? state.segment?.start || 0 : 0)), seekbackward: details => seekTo(audio.currentTime - (details.seekOffset || 10)),
    seekforward: details => seekTo(audio.currentTime + (details.seekOffset || 10)), stop: () => { pausePlayback(); seekTo(state.segment?.start || 0); } };
  for (const [action, callback] of Object.entries(handlers)) { try { navigator.mediaSession.setActionHandler(action, callback); } catch { /* Per-action support varies. */ } }
}

// Offline shell, storage and import
function updateOfflineLabel() {
  const count = state.lessons.filter(currentLesson).length;
  if (state.setup) { $('library-status').textContent = '请先在 Safari 添加到主屏幕，再导入课程'; $('offline-status').textContent = '尚未安装'; return; }
  $('library-status').textContent = state.shellReady ? count ? `${count} 课已存本机 · 已可离线使用` : '播放器已可离线使用 · 等待导入课程' : '播放器尚未完整缓存，请保持联网';
  $('offline-status').textContent = state.shellReady ? count ? `${count} 课可离线使用` : '等待导入课程' : '缓存中，请保持联网';
}
function showStorageState(persisted, saved = false) {
  $('storage-state').textContent = persisted ? '已持久保留' : '可能被系统清理';
  $('storage-note').textContent = persisted ? '本机存储已获得持久保留权限。请仍保留课程包备份。' : saved ? '课程已保存。系统仍可能清理存储，请保留课程包备份。' : '请保留原课程包备份。系统清理网站数据后，需要重新导入。';
}
function shellStatus() {
  return new Promise(resolve => {
    const controller = navigator.serviceWorker?.controller;
    if (!controller) return resolve(false);
    const channel = new MessageChannel(); const timeout = setTimeout(() => resolve(false), 3500);
    channel.port1.onmessage = event => {
      clearTimeout(timeout); channel.port1.close();
      const match = /^minna-shell-v(\d+)\.(\d+)(?:\.(\d+))?$/.exec(event.data.version || '');
      const actual = match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : [0, 0, 0];
      const current = actual[0] > REQUIRED_SHELL[0] || actual[0] === REQUIRED_SHELL[0] && (actual[1] > REQUIRED_SHELL[1] || actual[1] === REQUIRED_SHELL[1] && actual[2] >= REQUIRED_SHELL[2]);
      state.updateRequired = !current;
      if (!current) markUpdateAvailable();
      resolve(event.data.complete === true && current);
    };
    controller.postMessage({ type: 'SHELL_STATUS' }, [channel.port2]);
  });
}
async function prepareOffline() {
  const problem = browserSupport();
  if (problem) { showSetup(problem); return false; }
  try {
    registration = await navigator.serviceWorker.register(new URL('sw.js', BASE), { type: 'module', scope: BASE.pathname, updateViaCache: 'none' });
  } catch (reason) {
    if (reason.name === 'SecurityError' || reason.name === 'NotAllowedError') {
      showSetup({ code: 'blocked', title: '请在 Safari 中安装', message: '当前窗口阻止了离线安装。请复制安装网址，在 Safari 中打开；不要在应用内预览窗口中导入课程。' });
      return false;
    }
    throw reason;
  }
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise(resolve => {
    const change = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', change); resolve(); };
    const timer = setTimeout(change, 7000); navigator.serviceWorker.addEventListener('controllerchange', change);
  });
  state.shellReady = await shellStatus(); updateOfflineLabel();
  watchPlayerUpdate(registration);
  showStorageState(await navigator.storage?.persisted?.());
  return state.shellReady;
}
async function importFile(file) {
  if (!file || state.importing) return;
  if (file.size > 100 * 1024 * 1024) { error('课程包超过 100 MB，请选择单课课程包。'); return; }
  closeSheets();
  state.importing = true; refreshUpdatePrompt(); hideError();
  for (const button of document.querySelectorAll('.import-trigger')) button.disabled = true;
  try {
    if (!state.shellReady) { await prepareOffline(); if (state.setup) { requestImport(); return; } if (!state.shellReady) throw new Error('播放器还未完成离线安装。请保持联网，稍后重新导入。'); }
    notice('正在读取课程包…', true);
    const files = readStoredZip(await file.arrayBuffer());
    notice('正在核对原声音频，内容不会上传…', true);
    const lesson = await validatePackage(files);
    notice('正在保存到这台设备…', true);
    if (state.lesson?.id === lesson.id) { savePosition(); audio.pause(); clearSelection(); audio.removeAttribute('src'); audio.load(); releaseVocabularySources(); state.lesson = null; npKey = ''; barKey = ''; }
    await saveLesson(lesson, files);
    for (const track of [...lesson.tracks, ...(lesson.vocabulary?.audio || [])]) if (!(await getFile(lesson.id, track.src))?.blob?.size) throw new Error(`音频未完整保存：${track.src}`);
    state.lessons = await allLessons(); preference('recentLesson', lesson.id); renderLibrary();
    try { showStorageState(await navigator.storage?.persist?.(), true); } catch { /* Saving succeeded even if persistence request is unavailable. */ }
    notice(`第 ${lesson.number} 课已导入，${lesson.vocabulary?.words?.length ? '单词与课文' : '文型、例文、会话'}已可离线播放。`);
    await openLesson(state.lessons.find(saved => saved.id === lesson.id));
  } catch (reason) {
    notice('');
    error(reason.name === 'QuotaExceededError' ? '手机可用存储不足，课程未完整保存。请腾出空间后重新导入。' : reason.message || '导入失败，请重新选择完整课程包。');
  } finally {
    state.importing = false; refreshUpdatePrompt(); $('package-file').value = '';
    for (const button of document.querySelectorAll('.import-trigger')) button.disabled = false;
  }
}

// Gestures: left-edge swipe returns to the course list; pulling Now Playing down closes it.
let swipe = null;
document.addEventListener('touchstart', event => {
  swipe = null;
  if (event.touches.length !== 1) return;
  const point = event.touches[0], np = $('now-playing');
  if (np.open && event.target.closest('.np-head, .np-grabber')) { swipe = { x: point.clientX, y: point.clientY, id: point.identifier, kind: 'close' }; return; }
  if ($('lesson-view').hidden || SHEETS.some(id => $(id).open) || point.clientX > 24) return;
  swipe = { x: point.clientX, y: point.clientY, id: point.identifier, kind: 'back', lesson: state.lesson };
}, { passive: true });
document.addEventListener('touchmove', event => {
  if (!swipe || event.touches.length !== 1) { swipe = null; return; }
  const point = event.touches[0], dx = point.clientX - swipe.x, dy = point.clientY - swipe.y;
  if (swipe.kind === 'back' && Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.5 && dx > 0 && event.cancelable) event.preventDefault();
}, { passive: false });
document.addEventListener('touchcancel', () => { swipe = null; }, { passive: true });
document.addEventListener('touchend', event => {
  const start = swipe; swipe = null;
  if (!start) return;
  const point = Array.from(event.changedTouches).find(touch => touch.identifier === start.id);
  if (!point) return;
  const dx = point.clientX - start.x, dy = point.clientY - start.y;
  if (start.kind === 'close') { if (dy > 80 && dy > Math.abs(dx) * 1.5) $('now-playing').close(); return; }
  if (start.lesson !== state.lesson || $('lesson-view').hidden || dx < 60 || dx <= Math.abs(dy) * 1.5) return;
  if (event.cancelable) event.preventDefault();
  backToLibrary();
}, { passive: false });

// Wiring
$('apply-update').addEventListener('click', applyPlayerUpdate);
$('play').addEventListener('click', togglePlayback); $('mini-play').addEventListener('click', togglePlayback);
$('mini-next').addEventListener('click', () => moveGroup(1));
$('mini-open').addEventListener('click', openNowPlaying);
$('np-close').addEventListener('click', () => $('now-playing').close());
$('now-playing').addEventListener('close', updateNowPlaying);
$('play-all').addEventListener('click', () => startLesson('lesson'));
$('mode-repeat-start').addEventListener('click', () => startLesson('repeat'));
$('previous').addEventListener('click', () => moveGroup(-1)); $('next').addEventListener('click', () => moveGroup(1));
for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => chooseMode(button.dataset.mode));
for (const [id, panel] of [['show-text', 'text'], ['show-vocabulary', 'vocabulary']]) $(id).addEventListener('click', () => {
  if (state.panel !== panel) window.scrollTo({ top: 0, behavior: 'instant' });
  showStudyPanel(panel);
});
$('furigana').addEventListener('click', () => setFurigana(!state.furigana));
$('bilingual').addEventListener('click', () => setBilingual(!state.bilingual));
$('back-button').addEventListener('click', backToLibrary);
$('continue-open').addEventListener('click', () => { const lesson = recentLesson(); if (lesson) openLesson(lesson); });
$('continue-play').addEventListener('click', continuePlayback);
$('open-settings').addEventListener('click', () => openSheet('settings-sheet'));
for (const button of document.querySelectorAll('[data-open-display]')) button.addEventListener('click', () => openSheet('display-sheet'));
for (const button of document.querySelectorAll('[data-open-help]')) button.addEventListener('click', () => {
  if ($('settings-sheet').open) $('settings-sheet').close();
  openSheet('help-dialog');
  if (button.dataset.openHelp === 'media') $('help-media').scrollIntoView({ block: 'start', behavior: 'instant' });
});
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
for (const id of ['display-sheet', 'settings-sheet', 'help-dialog']) $(id).addEventListener('click', event => { if (event.target === $(id)) $(id).close(); });
$('dismiss-error').addEventListener('click', hideError);
for (const button of document.querySelectorAll('.import-trigger')) button.addEventListener('click', requestImport);
for (const button of document.querySelectorAll('[data-copy-install]')) button.addEventListener('click', copyInstallUrl);
$('install-url').value = INSTALL_URL;
$('app-version').textContent = APP_VERSION;
$('package-file').addEventListener('change', event => importFile(event.target.files[0]));
$('seek').addEventListener('input', () => {
  state.seeking = true; clearTimeout(sentenceTimer);
  const value = Number($('seek').value), min = Number($('seek').min);
  $('elapsed').textContent = formatTime(state.scope === 'vocabulary' ? value - min : value);
});
$('seek').addEventListener('change', () => { state.seeking = false; try { seekTo(Number($('seek').value)); } catch { error('暂时无法定位，请等待音频载入后重试。'); } savePosition(); });
for (const event of ['pointercancel', 'touchcancel', 'blur']) $('seek').addEventListener(event, () => { if (state.seeking) { state.seeking = false; updateProgress(); armSentenceStop(); } });
for (const event of ['play', 'pause', 'ended']) audio.addEventListener(event, updatePlayback);
for (const event of ['timeupdate', 'loadedmetadata', 'durationchange', 'seeked']) audio.addEventListener(event, () => {
  if (state.segment && !audio.paused && audio.currentTime >= state.segment.end - 0.008) finishSentence();
  updateProgress();
});
audio.addEventListener('playing', armSentenceStop); audio.addEventListener('seeked', armSentenceStop);
audio.addEventListener('pause', () => { if (audio.paused) clearTimeout(sentenceTimer); savePosition(); });
audio.addEventListener('ended', () => {
  if (!state.lesson || !audio.ended || !playbackWanted) return;
  if (state.segment) { finishSentence(); return; }
  if (state.scope === 'vocabulary') return;
  if (state.mode === 'single') { audio.currentTime = 0; playAudio(); return; }
  if (state.mode === 'repeat' && state.scope === 'lesson') { moveGroup(1); return; }
  const next = state.scope === 'lesson' ? nextAfterEnd(state.track, state.lesson.tracks.length, state.mode) : null;
  if (next !== null) selectTrack(next, true, 0, true, { scope: 'lesson' });
  else { playbackWanted = false; savePosition(); notice(state.scope === 'lesson' ? '文型、例文、会话已全部播放完。' : `${groupName(state.lesson.tracks[state.track])}已播放完。`); }
});
audio.addEventListener('error', () => {
  clearTimeout(sentenceTimer);
  if (retryVocabularyBlob()) return;
  if (state.lesson && audio.error && audio.getAttribute('src')) {
    playbackWanted = false;
    error(`第 ${state.lesson.number} 课无法读取或播放音频文件：${playbackResource()?.src || '未指定文件'}。请重新导入这课的课程包。`);
  }
});
window.addEventListener('pagehide', savePosition);
window.addEventListener('online', async () => { state.shellReady = await shellStatus(); updateOfflineLabel(); });
window.addEventListener('offline', updateOfflineLabel);
document.addEventListener('visibilitychange', () => { if (document.hidden) savePosition(); else { updatePlayback(); updateProgress(); } });
async function boot() {
  buildSizeSteps();
  setMode(preference('mode')); setBilingual(preference('bilingual') !== false && preference('vocabularyBilingual') !== false);
  setFurigana(preference('furigana') !== false); setJaSize(preference('jaSize') ?? 1);
  $('install-context').textContent = standalone() ? '你正在主屏幕 App 中。现在可以导入课程包。' : '建议先添加到主屏幕，再从主屏幕图标进入并导入课程，避免 Safari 与 App 的存储不同步。';
  installMediaActions(); claimPlaybackSession();
  try {
    const problem = browserSupport(); if (problem) { showSetup(problem); return; }
    state.lessons = await allLessons();
    const catalog = await fetch(new URL('data/catalog.json', BASE)).then(response => { if (!response.ok) throw new Error(); return response.json(); }).catch(() => null);
    if (Number.isInteger(catalog?.lessonCount)) state.totalLessons = Math.max(1, Math.min(25, catalog.lessonCount));
    renderLibrary(); if (!await prepareOffline()) return;
    const requested = location.hash.slice(1) || preference('lastLesson');
    const selected = state.lessons.find(lesson => lesson.id === requested);
    if (selected) await openLesson(selected);
    else {
      const recent = recentLesson();
      if (recent) await prepareLesson(recent).catch(() => false);
      updateNowPlaying();
      if (state.lessons.some(lesson => !currentLesson(lesson))) notice('已有旧版课程，请导入新版文型、例文、会话课程包。');
    }
  } catch (reason) { renderLibrary(); error(reason.message || '播放器未准备好，请联网重新打开后重试。'); }
}
boot();
