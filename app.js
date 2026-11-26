import { readStoredZip, validatePackage, formatTime, offlineSupport, nextAfterEnd, parseRuby } from './core.js';
import { allLessons, getFile, saveLesson } from './storage.js';

const $ = id => document.getElementById(id);
const audio = $('audio');
const BASE = new URL('./', import.meta.url);
const REQUIRED_SHELL = [2, 8, 0];
const INSTALL_URL = 'https://eian-lab.github.io/';
const state = { lessons: [], lesson: null, track: 0, mode: 'lesson', bilingual: true, scope: 'lesson', wordIndex: null, panel: 'text', vocabularyBilingual: true, furigana: true, segment: null, seeking: false, shellReady: false, importing: false, totalLessons: 25 };
let registration, lastSave = 0, selectionVersion = 0, sentenceTimer, metadataHandler;
let lineButtons = [], groupButtons = [], trackRows = [], wordButtons = [];
let readingGroup = 0;
let leavingLesson = false;
let vocabularySources = new Map(), mediaLoadVersion = 0, playbackWanted = false;
let openingLesson = 0, vocabularyLoading = null;
let lastController = navigator.serviceWorker?.controller || null, updateRequested = false, reloadStarted = false, updateWaitTimer;
function preference(key, value) {
  try { if (value !== undefined) localStorage.setItem(key, JSON.stringify(value)); else return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', `#i-${name}`); svg.append(use); return svg;
}
function text(tag, value, className) {
  const element = document.createElement(tag); element.textContent = value;
  if (className) element.className = className;
  return element;
}
// Japanese text with optional per-kanji furigana; falls back to plain text when the package has none.
function japanese(tag, value, ruby, className) {
  const element = text(tag, '', className); element.lang = 'ja';
  const segments = typeof ruby === 'string' ? parseRuby(ruby) : null;
  if (!segments || segments.map(segment => segment.text).join('') !== value) { element.textContent = value; return element; }
  for (const segment of segments) {
    if (!segment.reading) { element.append(segment.text); continue; }
    const node = document.createElement('ruby'); node.append(segment.text, text('rt', segment.reading)); element.append(node);
  }
  element.classList.add('has-ruby');
  return element;
}
function rubyReading(ruby) {
  const segments = typeof ruby === 'string' ? parseRuby(ruby) : null;
  return segments ? segments.map(segment => segment.reading || segment.text).join('') : null;
}
function error(message) {
  if ($('help-dialog').open) $('help-dialog').close();
  $('error-message').textContent = message; $('error-box').hidden = false;
  $('error-box').scrollIntoView({ block: 'start', behavior: 'instant' });
}
function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
function updateIsBusy() { return state.importing || (!audio.paused && !audio.ended); }
function refreshUpdatePrompt() {
  if (!state.updatePending) return;
  $('update-box').hidden = false;
  const busy = updateIsBusy();
  $('update-message').textContent = state.updateRequired ? '当前离线播放器需要更新。请打开“检查更新 / 修复安装”，课程会保留在本机。' : state.importing ? '新版播放器已就绪。课程导入完成后，可以更新。' : busy ? '新版播放器已就绪。暂停播放后，可以更新。' : '新版播放器已就绪。更新会保留这台设备上的课程。';
  $('apply-update').disabled = busy || updateRequested;
  $('apply-update').textContent = updateRequested ? '正在更新…' : '更新播放器';
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
      $('update-message').textContent = '更新还未完成。请打开“检查播放器更新 / 修复安装”继续，课程会保留在本机。';
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
  $('browser-setup').hidden = false; $('error-box').hidden = true;
  renderLibrary();
}
function requestImport() {
  if (state.setup) {
    if ($('help-dialog').open) $('help-dialog').close();
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
    notice('安装网址已复制，请在 Safari 打开。');
  } catch {
    if ($('help-dialog').open) $('help-dialog').close();
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
  if (state.vocabularyBilingual && word.zh) parts.push(word.zh);
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
function renderLibrary() {
  const list = $('lesson-list'); list.replaceChildren();
  const imported = state.lessons.filter(currentLesson);
  $('welcome-card').hidden = imported.length > 0 || !!state.setup;
  $('import-more').hidden = !state.lessons.length;
  for (let number = 1; number <= state.totalLessons; number++) {
    const lesson = state.lessons.find(item => item.number === number);
    const available = currentLesson(lesson), legacy = !!lesson && !available;
    const row = document.createElement('button');
    row.className = `lesson-row ${available || legacy || number === 1 ? 'available' : 'pending'}`;
    row.append(text('span', String(number).padStart(2, '0'), 'lesson-number'));
    const details = text('span', '', 'row-text'); details.append(text('strong', `第 ${number} 课`));
    if (available) details.append(text('small', lesson.vocabulary?.words?.length ? '单词 · 文型 · 例文 · 会话' : '文型 · 例文 · 会话 · 单词待更新'));
    else if (legacy) details.append(text('small', '请导入新版文型、例文、会话课程包'));
    else if (number === 1) details.append(text('small', '导入一次，随时点开听'));
    row.append(details, text('span', available ? '已导入' : legacy ? '需更新' : number === 1 ? '待导入' : '待添加', 'row-end'));
    if (available || legacy || number === 1) row.append(icon('chevron'));
    row.disabled = !available && !legacy && number !== 1;
    if (available) row.addEventListener('click', () => openLesson(lesson));
    else if (legacy || number === 1) row.addEventListener('click', () => {
      if (legacy) notice('本机保存的是旧版问题音频包。请导入新版文型、例文、会话课程包，原有内容不会作为新版播放。');
      requestImport();
    });
    list.append(row);
  }
  updateOfflineLabel();
}
function showLibrary() {
  leavingLesson = false;
  openingLesson++;
  $('library-view').hidden = false; $('lesson-view').hidden = true;
  $('back-button').hidden = true; $('brand').hidden = false;
  $('lesson-kicker').hidden = true; document.querySelector('.topbar').classList.remove('lesson-open');
  $('mini-player').hidden = !state.lesson || (state.scope === 'vocabulary' && !selectedWord());
  history.replaceState({ view: 'library' }, '', BASE.pathname); preference('lastLesson', null);
  window.scrollTo({ top: 0, behavior: 'instant' });
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
  state.lesson = lesson; state.panel = null;
  readingGroup = 0;
  $('lesson-kicker').textContent = `第 ${lesson.number} 课`;
  $('lesson-title').textContent = lesson.subtitle || lesson.title;
  $('track-total').textContent = `原声共 ${formatTime(totalDuration(lesson))}`;
  renderTracks(); renderSections(); renderVocabulary();
}
function rememberOpenLesson(lesson) {
  preference('lastLesson', lesson.id);
  if (history.state?.view === 'lesson') {
    history.replaceState({ view: 'lesson' }, '', `#${lesson.id}`);
  } else {
    history.replaceState({ view: 'library' }, '', BASE.pathname);
    history.pushState({ view: 'lesson' }, '', `#${lesson.id}`);
  }
}
async function openLesson(lesson) {
  if (!currentLesson(lesson)) {
    showLibrary();
    notice('此课需要更新。请导入包含完整文型、例文、会话的新版课程包。');
    return;
  }
  const changed = state.lesson !== lesson;
  if (changed) pausePlayback();
  const request = ++openingLesson;
  try {
    if (changed) {
      const sources = await readLessonFiles(lesson, [...lesson.tracks, ...(lesson.vocabulary?.audio || [])]);
      if (request !== openingLesson) return;
      activateLesson(lesson, sources);
    }
    $('library-view').hidden = true; $('lesson-view').hidden = false;
    $('brand').hidden = true; $('back-button').hidden = false; $('mini-player').hidden = true;
    $('lesson-kicker').hidden = false; document.querySelector('.topbar').classList.add('lesson-open');
    if (changed) {
      const saved = preference(`position:v2:${lesson.id}`);
      selectTrack(saved && Number.isInteger(saved.track) && saved.track >= 0 && saved.track < 3 ? saved.track : 0,
        false, Number.isFinite(saved?.time) ? saved.time : 0, false, { scope: 'lesson' });
      const savedPanel = preference(`panel:${lesson.id}`);
      showStudyPanel(savedPanel === 'vocabulary' ? 'vocabulary' : 'text');
    } else updateIndicators();
    updateOfflineLabel(); rememberOpenLesson(lesson);
    window.scrollTo({ top: 0, behavior: 'instant' });
  } catch (reason) { if (request === openingLesson) error(reason.message); }
}
function renderVocabulary() {
  const list = $('vocabulary-list'); list.replaceChildren(); wordButtons = [];
  const words = vocabularyWords();
  const recorded = words.filter((_, index) => playableWord(index)).length;
  $('vocabulary-count').textContent = !words.length ? '' : recorded === words.length ? `${words.length} 个词条` : `${words.length} 个词条 · ${recorded} 个可点读`;
  $('vocabulary-hint').textContent = !words.length ? '导入新版课程包后，可以在这里点词听原声。' : recorded === words.length ? '点一行，只听这个词的官方原声。' : '点一行，只听这个词。标注“暂无录音”的词暂不能点读。';
  $('vocabulary-update').hidden = words.length > 0 && recorded > 0;
  $('vocabulary-update-message').textContent = words.length ? '当前词表暂无可点读录音。请选择包含单词原声的新版课程包。' : '这个课程包还没有单词点读。重新选择含单词的第 1 课课程包，即可保留课文并加入词表。';
  words.forEach((word, index) => {
    const row = text('button', '', 'sentence-row vocabulary-row'); row.type = 'button'; row.dataset.wordIndex = String(index);
    const playable = playableWord(index); row.disabled = !playable;
    row.setAttribute('aria-label', wordAccessibleLabel(word, playable));
    const marker = text('span', String(index + 1).padStart(2, '0'), 'sentence-mark');
    const content = text('span', '', 'sentence-content');
    content.append(japanese('span', word.ja, word.ruby, 'word-ja'));
    // The separate reading line stays only when the furigana does not already spell out the whole reading.
    const covered = rubyReading(word.ruby)?.normalize('NFKC') === word.reading?.trim().normalize('NFKC');
    if (distinctReading(word) && !covered) { const reading = text('span', word.reading, 'word-reading'); reading.lang = 'ja'; content.append(reading); }
    if (word.zh) content.append(text('span', word.zh, 'word-zh'));
    row.append(marker, content);
    if (playable) row.append(icon('play')); else row.append(text('span', '暂无录音', 'word-status'));
    row.addEventListener('click', () => selectWord(index)); list.append(row); wordButtons.push({ row, index });
  });
  setVocabularyBilingual(state.vocabularyBilingual);
}
function setVocabularyBilingual(enabled) {
  state.vocabularyBilingual = enabled;
  $('vocabulary-list').classList.toggle('vocabulary-japanese-only', !enabled);
  for (const [id, selected] of [['vocab-japanese-only', !enabled], ['vocab-bilingual', enabled]]) {
    $(id).classList.toggle('selected', selected); $(id).setAttribute('aria-pressed', String(selected));
  }
  for (const { row, index } of wordButtons) row.setAttribute('aria-label', wordAccessibleLabel(vocabularyWords()[index], playableWord(index)));
  preference('vocabularyBilingual', enabled);
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
    $('now-title').textContent = '单词点读'; $('now-detail').textContent = '点下面的单词，听这一词的原声'; $('track-count').textContent = '';
    $('play').disabled = true; $('previous').disabled = true; $('next').disabled = true;
    if ('mediaSession' in navigator) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; }
  }
  state.panel = panel;
  $('text-panel').hidden = panel !== 'text'; $('vocabulary-panel').hidden = panel !== 'vocabulary';
  for (const id of ['play-all', 'mode-lesson', 'mode-single']) $(id).hidden = panel === 'vocabulary';
  for (const [id, value] of [['show-text', 'text'], ['show-vocabulary', 'vocabulary']]) {
    $(id).classList.toggle('selected', panel === value); $(id).setAttribute('aria-pressed', String(panel === value));
  }
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
  $('play').disabled = false; $('now-title').textContent = word.ja;
  $('now-detail').textContent = `${distinctReading(word) ? `${word.reading} · ` : ''}单词原声 · ${formatTime(word.end - word.start)}`;
  $('track-count').textContent = `单词 ${index + 1} / ${vocabularyWords().length}`;
  $('previous').disabled = adjacentWord(-1) === null; $('next').disabled = adjacentWord(1) === null;
  $('previous').setAttribute('aria-label', '上一个有录音的单词'); $('next').setAttribute('aria-label', '下一个有录音的单词');
  $('mini-title').textContent = word.ja; $('mini-subtitle').textContent = `第 ${state.lesson.number} 课 · 单词点读`;
  updateIndicators(); updateProgress(); updateMetadata(); playAudio();
}
function renderSections() {
  const container = $('learning-sections'); container.replaceChildren(); lineButtons = []; groupButtons = [];
  state.lesson.tracks.forEach((track, index) => {
    const section = text('section', '', 'learning-group'); section.id = `group-${track.type}`;
    section.setAttribute('role', 'tabpanel'); section.setAttribute('aria-labelledby', `tab-${track.type}`);
    section.hidden = index !== readingGroup;
    const heading = text('div', '', 'group-heading');
    const title = text('div', '', 'group-title');
    title.append(text('h2', groupName(track)), text('p', `${track.lines.length} 句 · ${formatTime(track.duration)}`, 'section-caption'));
    const play = text('button', '', 'group-play'); play.type = 'button';
    play.append(icon('play'), text('span', `播放${groupName(track)}`));
    play.setAttribute('aria-label', `播放完整${groupName(track)}`);
    play.addEventListener('click', () => selectTrack(index, true, 0, true, { scope: 'group' }));
    groupButtons.push(play); heading.append(title, play); section.append(heading);
    const lines = text('div', '', 'sentence-list');
    track.lines.forEach((line, lineIndex) => {
      const button = text('button', '', 'sentence-row'); button.type = 'button';
      button.dataset.track = String(index); button.dataset.line = String(lineIndex);
      button.setAttribute('aria-label', `播放${groupName(track)}第 ${lineIndex + 1} 句：${line.ja}`);
      const marker = text('span', String(lineIndex + 1).padStart(2, '0'), 'sentence-mark');
      const content = text('span', '', 'sentence-content');
      if (line.speaker) content.append(text('span', line.speaker, 'speaker'));
      content.append(japanese('span', line.ja, line.ruby, 'ja'));
      if (typeof line.zh === 'string' && line.zh.trim()) content.append(text('span', line.zh, 'zh'));
      if (typeof line.note === 'string' && line.note.trim()) content.append(text('span', line.note, 'line-note zh'));
      button.append(marker, content, icon('play'));
      button.addEventListener('click', () => selectTrack(index, true, line.start, true, { scope: 'sentence', lineIndex }));
      lines.append(button); lineButtons.push({ button, line, index, lineIndex });
    });
    section.append(lines); container.append(section);
  });
  setBilingual(state.bilingual);
}
function setFurigana(enabled) {
  state.furigana = enabled; document.body.classList.toggle('furigana-off', !enabled);
  for (const id of ['furigana', 'vocab-furigana']) {
    $(id).classList.toggle('selected', enabled); $(id).setAttribute('aria-pressed', String(enabled));
  }
  preference('furigana', enabled);
}
function setBilingual(enabled) {
  state.bilingual = enabled; $('learning-sections').classList.toggle('japanese-only', !enabled);
  for (const [id, selected] of [['japanese-only', !enabled], ['bilingual', enabled]]) {
    $(id).classList.toggle('selected', selected); $(id).setAttribute('aria-pressed', String(selected));
  }
  preference('bilingual', enabled);
}
function renderTracks() {
  $('track-list').replaceChildren(); trackRows = [];
  state.lesson.tracks.forEach((track, index) => {
    const row = text('button', '', 'section-jump'); row.type = 'button';
    row.id = `tab-${track.type}`; row.setAttribute('role', 'tab');
    row.setAttribute('aria-controls', `group-${track.type}`);
    const mark = text('span', String(index + 1).padStart(2, '0'), 'track-mark');
    row.append(mark, text('strong', groupName(track)));
    row.addEventListener('click', () => showReadingGroup(index));
    trackRows.push({ row, mark, track, index }); $('track-list').append(row);
  });
}
function showReadingGroup(index, revealTabs = false) {
  if (!trackRows[index]) return;
  readingGroup = index;
  for (const entry of trackRows) {
    const selected = entry.index === index;
    entry.row.classList.toggle('selected', selected);
    entry.row.setAttribute('aria-selected', String(selected));
    entry.row.tabIndex = selected ? 0 : -1;
    $(`group-${entry.track.type}`).hidden = !selected;
  }
  const tabs = $('track-list');
  if (revealTabs && tabs.getBoundingClientRect().top < 0) tabs.scrollIntoView({ block: 'start', behavior: 'instant' });
}
$('track-list').addEventListener('keydown', event => {
  const tab = event.target.closest('[role="tab"]');
  if (!tab) return;
  const count = trackRows.length;
  const destinations = {
    ArrowLeft: (readingGroup + count - 1) % count,
    ArrowRight: (readingGroup + 1) % count,
    Home: 0, End: count - 1
  };
  if (!Object.hasOwn(destinations, event.key)) return;
  event.preventDefault();
  showReadingGroup(destinations[event.key]);
  trackRows[readingGroup].row.focus();
});

// The system can claim an edge swipe itself; browser Back has the same destination.
let swipe = null;
document.addEventListener('touchstart', event => {
  swipe = null;
  if (event.touches.length !== 1 || $('lesson-view').hidden || $('help-dialog').open ||
      event.target.closest('input, textarea, select, dialog, .error-box, #update-box')) return;
  const point = event.touches[0];
  const back = point.clientX <= 32 || !!event.target.closest('.player-card');
  if (!back && !event.target.closest('#text-panel')) return;
  swipe = { x: point.clientX, y: point.clientY, id: point.identifier, back, lesson: state.lesson };
}, { passive: true });
document.addEventListener('touchmove', event => {
  if (!swipe || event.touches.length !== 1) { swipe = null; return; }
  const point = event.touches[0];
  const dx = point.clientX - swipe.x, dy = Math.abs(point.clientY - swipe.y);
  if (dy > 12 && dy >= Math.abs(dx)) { swipe = null; return; }
  if (Math.abs(dx) > 14 && Math.abs(dx) > dy * 1.5 && (!swipe.back || dx > 0) && event.cancelable) event.preventDefault();
}, { passive: false });
document.addEventListener('touchcancel', () => { swipe = null; }, { passive: true });
document.addEventListener('touchend', event => {
  const start = swipe;
  swipe = null;
  if (!start || start.lesson !== state.lesson || $('lesson-view').hidden) return;
  const point = Array.from(event.changedTouches).find(touch => touch.identifier === start.id);
  if (!point) return;
  const dx = point.clientX - start.x, dy = point.clientY - start.y;
  if (Math.abs(dx) < 44 || Math.abs(dx) <= Math.abs(dy) * 1.5 || (start.back && dx < 0)) return;
  if (event.cancelable) event.preventDefault();
  if (start.back) backToLibrary();
  else showReadingGroup(Math.max(0, Math.min(trackRows.length - 1, readingGroup + (dx < 0 ? 1 : -1))), true);
}, { passive: false });
function updateIndicators() {
  if (!state.lesson) return;
  updateModeHint();
  const playing = !audio.paused && !audio.ended;
  for (const { row, mark, track, index } of trackRows) {
    const active = state.scope !== 'vocabulary' && index === state.track; row.classList.toggle('active', active);
    if (active) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
    row.setAttribute('aria-label', `查看${groupName(track)}课文${active ? '，当前音频' : ''}`);
    mark.replaceChildren(active ? icon(playing ? 'pause' : 'play') : text('span', String(index + 1).padStart(2, '0')));
  }
  for (const { button, line, index, lineIndex } of lineButtons) {
    const selected = state.scope !== 'vocabulary' && index === state.track && (state.segment ? state.segment.lineIndex === lineIndex : audio.currentTime >= line.start && audio.currentTime < line.end);
    button.classList.toggle('current-sentence', selected);
    if (selected) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
  }
  groupButtons.forEach((button, index) => {
    button.classList.toggle('active', state.scope !== 'vocabulary' && index === state.track && playing && !state.segment);
    button.lastElementChild.textContent = state.scope !== 'vocabulary' && index === state.track && playing && !state.segment ? '正在播放' : `播放${groupName(state.lesson.tracks[index])}`;
  });
  for (const { row, index } of wordButtons) {
    const active = state.scope === 'vocabulary' && state.wordIndex === index;
    row.classList.toggle('current-sentence', active);
    if (active) row.setAttribute('aria-current', 'true'); else row.removeAttribute('aria-current');
  }
  $('play-all').classList.toggle('active', state.scope === 'lesson' && state.mode === 'lesson' && playing);
}
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
  showReadingGroup(index);
  if (state.mode === 'repeat' && state.scope !== 'lesson') setMode('lesson');
  if (state.scope === 'sentence') {
    const line = track.lines[options.lineIndex];
    if (!line) return;
    state.segment = { start: line.start, end: line.end, lineIndex: options.lineIndex, version, finishing: false };
    start = line.start;
  }
  loadAudioSelection(track, start, version);
  audio.loop = state.scope !== 'vocabulary' && state.mode === 'single' && !state.segment;
  $('now-title').textContent = state.segment ? `${groupName(track)} · 第 ${state.segment.lineIndex + 1} 句` : groupName(track);
  $('now-detail').textContent = state.segment ? `单句原声 · ${formatTime(state.segment.start)}—${formatTime(state.segment.end)}` : `${track.lines.length} 句 · ${formatTime(track.duration)} · 完整原声`;
  $('track-count').textContent = `${index + 1} / 3`;
  $('play').disabled = false;
  updateGroupNavigation();
  $('previous').setAttribute('aria-label', '上一组音频'); $('next').setAttribute('aria-label', '下一组音频');
  $('mini-title').textContent = $('now-title').textContent; $('mini-subtitle').textContent = `第 ${state.lesson.number} 课 · ${state.lesson.subtitle || state.lesson.title}`;
  updateIndicators(); updateProgress(); updateMetadata();
  if (state.panel === 'vocabulary') showStudyPanel('text');
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
  playbackWanted = true;
  const version = selectionVersion, loadVersion = mediaLoadVersion; $('error-box').hidden = true; notice('');
  audio.play()?.catch(reason => {
    if (version !== selectionVersion || loadVersion !== mediaLoadVersion || !playbackWanted || reason.name === 'AbortError') return;
    if (retryVocabularyBlob()) return;
    playbackWanted = false;
    error(reason.name === 'NotAllowedError' ? '手机暂停了自动播放。请回到播放器，点一下播放键继续。' : `第 ${state.lesson.number} 课无法播放音频文件：${playbackResource()?.src || '未指定文件'}。请重新导入这课的课程包后重试。`);
    updatePlayback();
  });
}
function pausePlayback() { openingLesson++; playbackWanted = false; audio.pause(); }
function togglePlayback() { if (audio.paused || audio.ended) playAudio(); else pausePlayback(); }
function setMode(mode) {
  state.mode = ['single', 'repeat'].includes(mode) ? mode : 'lesson'; audio.loop = state.scope !== 'vocabulary' && state.mode === 'single' && !state.segment;
  for (const [id, value] of [['mode-lesson', 'lesson'], ['mode-single', 'single'], ['mode-repeat', 'repeat']]) {
    $(id).classList.toggle('selected', state.mode === value); $(id).setAttribute('aria-pressed', String(state.mode === value));
  }
  preference('mode', state.mode); updateGroupNavigation(); updateIndicators();
}
function updateModeHint() {
  let message = '当前内容播完停止。';
  if (state.scope === 'vocabulary') message = '点「整课循环」，从本课文型开始，按课号连续播放。';
  else if (state.mode === 'repeat') message = '本课会话结束后播放下一课，末课回到已导入的第一课。再点从当前课开头播放。';
  else if (state.mode === 'single') message = state.segment ? '反复播放选中的这一句。' : '反复播放选中的这一组。';
  else if (state.scope === 'lesson') message = '文型 → 例文 → 会话，播完停止。';
  const hint = $('playback-mode-hint');
  if (hint.textContent !== message) hint.textContent = message;
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
  $('play-icon').setAttribute('href', playing ? '#i-pause' : '#i-play'); $('mini-play-icon').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('play').setAttribute('aria-label', playing ? '暂停' : '播放'); $('mini-play').setAttribute('aria-label', playing ? '暂停' : '播放');
  updateIndicators(); armSentenceStop(); refreshUpdatePrompt();
  if ('mediaSession' in navigator) { navigator.mediaSession.playbackState = state.lesson && (state.scope !== 'vocabulary' || selectedWord()) ? playing ? 'playing' : 'paused' : 'none'; updateMediaPosition(); }
}
function updateProgress() {
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : playbackResource()?.duration || 0;
  const start = state.segment?.start || 0, end = state.segment?.end || duration;
  const position = Math.max(start, Math.min(audio.currentTime || 0, end));
  if (!state.seeking) {
    $('seek').min = String(start); $('seek').max = String(end || 1); $('seek').value = String(position);
    $('seek').style.setProperty('--played', `${end > start ? 100 * (position - start) / (end - start) : 0}%`);
    $('elapsed').textContent = formatTime(state.scope === 'vocabulary' ? position - start : position);
  }
  $('duration').textContent = formatTime(state.scope === 'vocabulary' ? end - start : end);
  $('seek').setAttribute('aria-valuetext', `${formatTime(state.scope === 'vocabulary' ? position - start : position)}，共 ${formatTime(state.scope === 'vocabulary' ? end - start : end)}`);
  updateIndicators(); updateMediaPosition();
  if (Date.now() - lastSave > 5000) savePosition();
}
function savePosition() {
  if (currentLesson(state.lesson) && state.scope !== 'vocabulary') { preference(`position:v2:${state.lesson.id}`, { track: state.track, time: audio.currentTime || 0 }); lastSave = Date.now(); }
}
function updateMetadata() {
  if (!('mediaSession' in navigator) || !('MediaMetadata' in window) || !state.lesson) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: $('now-title').textContent,
    artist: `第 ${state.lesson.number} 课 · 大家的日本语`, album: state.scope === 'vocabulary' ? `第 ${state.lesson.number} 课 · 单词` : state.lesson.subtitle || state.lesson.title,
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
    if (!$('lesson-view').hidden) rememberOpenLesson(target);
  }
  selectTrack(delta > 0 ? 0 : target.tracks.length - 1, true, 0, !changed, { scope: 'lesson' });
  if (changed) showStudyPanel('text', false);
}
function installMediaActions() {
  if (!('mediaSession' in navigator)) return;
  const handlers = { play: playAudio, pause: pausePlayback, previoustrack: () => moveGroup(-1), nexttrack: () => moveGroup(1),
    seekto: details => seekTo(details.seekTime + (state.scope === 'vocabulary' ? state.segment?.start || 0 : 0)), seekbackward: details => seekTo(audio.currentTime - (details.seekOffset || 10)),
    seekforward: details => seekTo(audio.currentTime + (details.seekOffset || 10)), stop: () => { pausePlayback(); seekTo(state.segment?.start || 0); } };
  for (const [action, callback] of Object.entries(handlers)) { try { navigator.mediaSession.setActionHandler(action, callback); } catch { /* Per-action support varies. */ } }
}
function updateOfflineLabel() {
  if (state.setup) { $('library-status').textContent = '请先在 Safari 添加到主屏幕，再导入课程'; return; }
  $('library-status').textContent = state.shellReady ? state.lessons.filter(currentLesson).length ? `${state.lessons.filter(currentLesson).length} 课已存本机 · 已可离线使用` : '播放器已可离线使用 · 等待导入课程' : '播放器尚未完整缓存，请保持联网';
  $('lesson-status').lastElementChild.textContent = state.shellReady ? '已可离线使用' : '播放器缓存中';
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
  const persisted = await navigator.storage?.persisted?.();
  $('storage-note').textContent = persisted ? '本机存储已获得持久保留权限。请仍保留课程包备份。' : '请保留原课程包备份。系统清理网站数据后，需要重新导入。';
  return state.shellReady;
}
async function importFile(file) {
  if (!file || state.importing) return;
  if (file.size > 100 * 1024 * 1024) { error('课程包超过 100 MB，请选择单课课程包。'); return; }
  state.importing = true; refreshUpdatePrompt(); $('error-box').hidden = true;
  for (const button of document.querySelectorAll('.import-trigger')) button.disabled = true;
  try {
    if (!state.shellReady) { await prepareOffline(); if (state.setup) { requestImport(); return; } if (!state.shellReady) throw new Error('播放器还未完成离线安装。请保持联网，稍后重新导入。'); }
    notice('正在读取课程包…');
    const files = readStoredZip(await file.arrayBuffer());
    notice('正在核对原声音频，内容不会上传…');
    const lesson = await validatePackage(files);
    notice('正在保存到这台设备…');
    if (state.lesson?.id === lesson.id) { savePosition(); audio.pause(); clearSelection(); audio.removeAttribute('src'); audio.load(); releaseVocabularySources(); state.lesson = null; }
    await saveLesson(lesson, files);
    for (const track of [...lesson.tracks, ...(lesson.vocabulary?.audio || [])]) if (!(await getFile(lesson.id, track.src))?.blob?.size) throw new Error(`音频未完整保存：${track.src}`);
    state.lessons = await allLessons(); renderLibrary();
    try { const result = await navigator.storage?.persist?.(); $('storage-note').textContent = result ? '本机存储已获得持久保留权限。请保留课程包备份。' : '课程已保存。系统仍可能清理存储，请保留课程包备份。'; } catch { /* Saving succeeded even if persistence request is unavailable. */ }
    if ($('help-dialog').open) $('help-dialog').close();
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
$('apply-update').addEventListener('click', applyPlayerUpdate);
$('play').addEventListener('click', togglePlayback); $('mini-play').addEventListener('click', togglePlayback);
$('play-all').addEventListener('click', () => startLesson('lesson'));
$('previous').addEventListener('click', () => moveGroup(-1)); $('next').addEventListener('click', () => moveGroup(1));
$('mode-lesson').addEventListener('click', () => setMode('lesson')); $('mode-single').addEventListener('click', () => setMode('single'));
$('mode-repeat').addEventListener('click', () => startLesson('repeat'));
$('show-text').addEventListener('click', () => showStudyPanel('text'));
$('show-vocabulary').addEventListener('click', () => showStudyPanel('vocabulary'));
$('vocab-japanese-only').addEventListener('click', () => setVocabularyBilingual(false));
$('vocab-bilingual').addEventListener('click', () => setVocabularyBilingual(true));
$('japanese-only').addEventListener('click', () => setBilingual(false)); $('bilingual').addEventListener('click', () => setBilingual(true));
for (const id of ['furigana', 'vocab-furigana']) $(id).addEventListener('click', () => setFurigana(!state.furigana));
$('back-button').addEventListener('click', backToLibrary); $('mini-open').addEventListener('click', () => state.lesson && openLesson(state.lesson));
$('help-button').addEventListener('click', () => $('help-dialog').showModal()); $('close-help').addEventListener('click', () => $('help-dialog').close());
$('dismiss-error').addEventListener('click', () => { $('error-box').hidden = true; });
for (const button of document.querySelectorAll('.import-trigger')) button.addEventListener('click', requestImport);
for (const button of document.querySelectorAll('[data-copy-install]')) button.addEventListener('click', copyInstallUrl);
$('install-url').value = INSTALL_URL;
$('package-file').addEventListener('change', event => importFile(event.target.files[0]));
$('seek').addEventListener('input', () => {
  state.seeking = true; clearTimeout(sentenceTimer);
  const value = Number($('seek').value), min = Number($('seek').min), max = Number($('seek').max);
  $('elapsed').textContent = formatTime(value); $('seek').style.setProperty('--played', `${max > min ? 100 * (value - min) / (max - min) : 0}%`);
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
  setMode(preference('mode')); state.bilingual = preference('bilingual') !== false; state.vocabularyBilingual = preference('vocabularyBilingual') !== false;
  setFurigana(preference('furigana') !== false);
  $('install-context').textContent = standalone() ? '你正在主屏幕 App 中。现在可以导入课程包。' : '建议先添加到主屏幕，再从主屏幕图标进入并导入课程，避免 Safari 与 App 的存储不同步。';
  installMediaActions();
  try {
    const problem = browserSupport(); if (problem) { showSetup(problem); return; }
    state.lessons = await allLessons();
    const catalog = await fetch(new URL('data/catalog.json', BASE)).then(response => { if (!response.ok) throw new Error(); return response.json(); }).catch(() => null);
    if (Number.isInteger(catalog?.lessonCount)) state.totalLessons = Math.max(1, Math.min(25, catalog.lessonCount));
    renderLibrary(); if (!await prepareOffline()) return;
    const requested = location.hash.slice(1) || preference('lastLesson');
    const selected = state.lessons.find(lesson => lesson.id === requested);
    if (selected) await openLesson(selected);
    else if (state.lessons.some(lesson => !currentLesson(lesson))) notice('已有旧版课程，请导入新版文型、例文、会话课程包。');
  } catch (reason) { renderLibrary(); error(reason.message || '播放器未准备好，请联网重新打开后重试。'); }
}
boot();
