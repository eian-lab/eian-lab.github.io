import { mediaType } from './core.js';
export const DB_NAME = 'minna-pocket-library';
export const DB_VERSION = 1;
let connection;
export function openLibrary() {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('lessons')) db.createObjectStore('lessons', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'key' });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); connection = undefined; };
      resolve(request.result);
    };
    request.onerror = () => { connection = undefined; reject(new Error('无法打开本机课程库。请检查 Safari 是否允许网站保存数据。')); };
    request.onblocked = () => reject(new Error('课程库正在被另一个窗口使用，请关闭其他窗口后重试。'));
  });
  return connection;
}
async function get(store, key) {
  const db = await openLibrary();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function allLessons() {
  const db = await openLibrary();
  return new Promise((resolve, reject) => {
    const request = db.transaction('lessons').objectStore('lessons').getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => a.number - b.number));
    request.onerror = () => reject(request.error);
  });
}
export const getLesson = id => get('lessons', id);
export const getFile = (id, path) => get('files', `${id}/${path}`);
export async function saveLesson(lesson, files) {
  const db = await openLibrary();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['lessons', 'files'], 'readwrite');
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error || new Error('课程保存未完成，原有课程未被修改。'));
    transaction.onerror = () => {};
    const fileStore = transaction.objectStore('files');
    const cursor = fileStore.openCursor(IDBKeyRange.bound(`${lesson.id}/`, `${lesson.id}/\uffff`));
    cursor.onsuccess = () => {
      if (cursor.result) { cursor.result.delete(); cursor.result.continue(); return; }
      try {
        transaction.objectStore('lessons').put({ ...lesson, importedAt: new Date().toISOString() });
        for (const [path, bytes] of files) fileStore.put({
          key: `${lesson.id}/${path}`, blob: new Blob([bytes], { type: mediaType(path) })
        });
      } catch { transaction.abort(); }
    };
  });
}
