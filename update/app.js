// Keep this script's stable path: v1's navigation fallback loads ./app.js here.
// Use the module URL, not location.href: both /update/ and /update/index.html
// must operate on the single root worker and the existing origin's course store.
const root = new URL('../', import.meta.url);
const installPage = new URL('update/', root);
const REQUIRED_VERSION = [3, 0, 1];
const RELEASE_LABEL = '点读版 3.0';
let running = false;

document.title = `更新日语随身听 · ${RELEASE_LABEL}`;
const manifest = document.querySelector('link[rel="manifest"]');
if (manifest) manifest.href = new URL('manifest.webmanifest', root).href;
const main = document.createElement('main');
main.innerHTML = `<p class="release">${RELEASE_LABEL}</p><h1>更新日语随身听</h1>
  <p id="status" role="status" aria-live="polite">正在检查播放器…</p>
  <a class="open-player" hidden>进入${RELEASE_LABEL}</a>
  <button type="button" hidden>重新检查</button>
  <p class="address" hidden></p>
  <p class="hint">本次只更新播放器，已导入的课程保留在这台设备上。</p>
  <p class="hint">若从主屏幕使用，更新后请回到原图标，确认显示“${RELEASE_LABEL}”。Safari 与主屏幕 App 可能分别保存课程。</p>`;
document.body.replaceChildren(main);
const status = main.querySelector('#status');
const openPlayer = main.querySelector('.open-player');
const retry = main.querySelector('button');
const address = main.querySelector('.address');
openPlayer.href = root.href;
openPlayer.addEventListener('click', event => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  location.replace(root.href);
});
retry.addEventListener('click', startUpdate);

function installedShell(worker) {
  if (!worker) return Promise.resolve(null);
  return new Promise(resolve => {
    const channel = new MessageChannel();
    let finished = false;
    const finish = value => {
      if (finished) return;
      finished = true; clearTimeout(timer); channel.port1.close(); resolve(value);
    };
    const timer = setTimeout(() => finish(null), 1200);
    channel.port1.onmessage = event => finish(event.data);
    try { worker.postMessage({ type: 'SHELL_STATUS' }, [channel.port2]); } catch { finish(null); }
  });
}
function hasRequiredUpdate(shell) {
  if (shell?.complete !== true) return false;
  const match = /^minna-shell-v(\d+)\.(\d+)(?:\.(\d+))?$/.exec(shell.version || '');
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
  for (let i = 0; i < REQUIRED_VERSION.length; i++) {
    if (actual[i] > REQUIRED_VERSION[i]) return true;
    if (actual[i] < REQUIRED_VERSION[i]) return false;
  }
  return true;
}
async function ensureUpdated(attempt) {
  const workers = navigator.serviceWorker;
  const registration = await workers.register(new URL('sw.js', root), {
    type: 'module', scope: root.pathname, updateViaCache: 'none'
  });
  // Always check the published script before accepting an already-installed shell.
  // A 2.1 worker used to report success here before the 2.2 check even ran.
  let updateFailed = false;
  try { await registration.update(); } catch { updateFailed = true; }
  while (!attempt.expired) {
    registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
    const controller = workers.controller;
    const shell = await installedShell(controller);
    if (attempt.expired) break;
    if (controller === workers.controller && hasRequiredUpdate(shell)) return { shell, updateFailed };
    if (updateFailed) throw new Error('更新检查未能连接，请确认已联网后重新检查。');
    status.textContent = `正在下载${RELEASE_LABEL}播放器，请保持联网。`;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('更新尚未完成，请稍后重新检查。');
}
async function startUpdate() {
  if (running) return;
  if (!window.isSecureContext || !navigator.serviceWorker?.register) {
    status.textContent = '请复制下方网址，用 iPhone 的 Safari 打开，再更新播放器。';
    address.textContent = installPage.href; address.hidden = false; return;
  }
  running = true; retry.hidden = true; openPlayer.hidden = true; address.hidden = true;
  status.textContent = '正在检查播放器更新…';
  const attempt = { expired: false }; let timer;
  try {
    const result = await Promise.race([ensureUpdated(attempt), new Promise((_, reject) => {
      timer = setTimeout(() => { attempt.expired = true; reject(new Error('更新检查超时。请确认已联网后重新检查。')); }, 30000);
    })]);
    status.textContent = result.updateFailed ? `${RELEASE_LABEL} 已在本机就绪，但本次未能检查线上更新。可以先进入播放器，联网后再检查。` : `${RELEASE_LABEL} 已就绪。打开已有课程，点选或左右滑动就能切换文型、例文、会话。`;
    openPlayer.hidden = false;
  } catch (reason) {
    status.textContent = reason.message || '更新尚未完成，请联网后重新检查。';
    retry.hidden = false; address.textContent = `更新网址：${installPage.href}`; address.hidden = false;
  } finally { attempt.expired = true; clearTimeout(timer); running = false; }
}
startUpdate();
