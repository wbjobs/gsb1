// 主线程：只负责输入、选区、DOM 渲染与时间轴 UI。
// 所有冲突合并、因果处理、回放索引都在 Worker 中完成。

const editor = document.getElementById('editor');
const boldBtn = document.getElementById('boldBtn');
const replayBtn = document.getElementById('replayBtn');
const autoBtn = document.getElementById('autoBtn');
const statsEl = document.getElementById('stats');
const fpsEl = document.getElementById('fps');
const modeBadge = document.getElementById('modeBadge');

const replaybar = document.getElementById('replaybar');
const timeline = document.getElementById('timeline');
const playBtn = document.getElementById('playBtn');
const stepBackBtn = document.getElementById('stepBackBtn');
const stepFwdBtn = document.getElementById('stepFwdBtn');
const speedSelect = document.getElementById('speedSelect');
const replayIndexEl = document.getElementById('replayIndex');
const replayTotalEl = document.getElementById('replayTotal');
const replayDescEl = document.getElementById('replayDesc');
const exitReplayBtn = document.getElementById('exitReplayBtn');

const worker = new Worker('js/worker.js', { type: 'module' });

let liveView = { text: '', ids: [], runs: [] };
let replayView = null;
let pendingCaret = null; // {anchorId, headId} 或 null（选区折叠到文档末尾）
let composing = false;
let mySite = '';
let awaitingAck = false; // 本地意图尚未被权威状态确认
let needsFlush = false;  // 等待期间又有新输入

// ---------- Worker 消息 ----------

worker.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'ready') {
    mySite = msg.site;
  } else if (msg.type === 'state') {
    liveView = { text: msg.text, ids: msg.ids, runs: msg.runs };
    if (replayView) {
      stats(msg);
      return; // 回放模式下不覆盖编辑区
    }
    const wasAwaiting = awaitingAck;
    awaitingAck = false;
    if (!composing) {
      if (wasAwaiting && needsFlush) {
        // 权威状态回来，但用户在等待期间继续输入：保留 DOM 中尚未同步的文字，
        // 先渲染新视图再还原输入文本，随后基于最新权威视图重新差分
        const queuedText = editor.textContent;
        renderView(liveView, null);
        editor.textContent = queuedText;
        needsFlush = false;
        pendingCaret = null;
        flushInput();
      } else {
        renderView(liveView, pendingCaret);
        pendingCaret = null;
      }
    }
    stats(msg);
  } else if (msg.type === 'replay-state') {
    replayView = {
      text: msg.text, ids: msg.ids, runs: msg.runs,
      index: msg.index, total: msg.total, description: msg.description, ts: msg.ts,
    };
    renderView(replayView, null);
    timeline.max = String(msg.total);
    timeline.value = String(msg.index);
    replayIndexEl.textContent = msg.index;
    replayTotalEl.textContent = msg.total;
    replayDescEl.textContent = msg.description;
    if (msg.index >= msg.total) replayPlaying = false;
    playBtn.textContent = replayPlaying ? '⏸' : '▶';
  } else if (msg.type === 'local-applied') {
    if (pendingCaret === 'inserted' && msg.charIds && msg.charIds.length) {
      const last = msg.charIds[msg.charIds.length - 1];
      pendingCaret = { anchorId: last, headId: last };
    }
  } else if (msg.type === 'error' || msg.type === 'fatal') {
    console.error(msg.message);
    statsEl.textContent = '错误：' + msg.message;
  }
};

function stats(msg) {
  statsEl.textContent =
    `站点 ${(msg.site || '').slice(0, 6)} · 字符 ${msg.chars} · 操作 ${msg.opCount} · 在线标签页 ${msg.peers + 1}`;
}

// ---------- DOM 渲染（纯展示，唯一的“真相”来自 Worker） ----------

function renderView(view, caret) {
  const { text, runs } = view;
  editor.textContent = '';
  const frag = document.createDocumentFragment();
  if (runs.length === 0) {
    frag.appendChild(document.createTextNode(text));
  } else {
    let pos = 0;
    for (const [start, end] of runs) {
      if (start > pos) frag.appendChild(document.createTextNode(text.slice(pos, start)));
      const b = document.createElement('b');
      b.textContent = text.slice(start, end);
      frag.appendChild(b);
      pos = end;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
  }
  editor.appendChild(frag);
  if (caret) restoreCaret(view, caret);
}

// 把（字符 id / 文档偏移）映射到 DOM 节点与偏移
function pointAtOffset(offset) {
  let remaining = offset;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const len = node.data.length;
    if (remaining <= len) return { node, offset: remaining };
    remaining -= len;
    node = walker.nextNode();
  }
  return { node: editor, offset: editor.childNodes.length };
}

function offsetFromPoint(node, offset) {
  let total = 0;
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let cur = walker.nextNode();
  while (cur) {
    if (cur === node) return total + offset;
    total += cur.data.length;
    cur = walker.nextNode();
  }
  return total;
}

function selectionOffsets() {
  const sel = window.getSelection();
  if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return null;
  const range = sel.getRangeAt(0);
  const start = offsetFromPoint(range.startContainer, range.startOffset);
  const end = sel.isCollapsed
    ? start
    : offsetFromPoint(range.endContainer, range.endOffset);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function restoreCaret(view, caret) {
  let anchorOff = -1;
  let headOff = -1;
  if (caret === 'end') {
    anchorOff = headOff = view.ids.length;
  } else {
    anchorOff = view.ids.indexOf(caret.anchorId);
    headOff = caret.headId ? view.ids.indexOf(caret.headId) : anchorOff;
    if (anchorOff === -1) {
      // 锚点字符被删除：退回到记录的旧偏移（再找不到就折叠到末尾）
      anchorOff = Math.min(caret.fallback ?? view.ids.length, view.ids.length);
    }
    if (headOff === -1) headOff = anchorOff;
  }
  const a = pointAtOffset(anchorOff);
  const h = pointAtOffset(headOff);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(h.node, h.offset);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// ---------- 输入：与上一帧纯文本做差分，翻译成 CRDT 意图 ----------

editor.addEventListener('compositionstart', () => { composing = true; });
editor.addEventListener('compositionend', () => {
  composing = false;
  flushInput();
});
editor.addEventListener('input', () => {
  if (!composing) flushInput();
});

function flushInput() {
  if (replayView) return;
  if (awaitingAck) {
    // 上一批意图还未得到权威状态确认：暂不基于过期视图差分，
    // 保留 DOM（用户输入不丢），等状态回来后基于最新视图重新计算
    needsFlush = true;
    return;
  }
  const oldText = liveView.text;
  const oldIds = liveView.ids;
  const newText = editor.textContent;
  if (newText === oldText) return;

  const sel = selectionOffsets() || { start: newText.length, end: newText.length };

  let prefix = 0;
  const maxCommon = Math.min(oldText.length, newText.length);
  while (prefix < maxCommon && oldText[prefix] === newText[prefix]) prefix++;
  let oldSuffix = oldText.length;
  let newSuffix = newText.length;
  while (
    oldSuffix > prefix && newSuffix > prefix &&
    oldText[oldSuffix - 1] === newText[newSuffix - 1]
  ) {
    oldSuffix--;
    newSuffix--;
  }

  const removedIds = oldIds.slice(prefix, oldSuffix);
  const inserted = newText.slice(prefix, newSuffix);

  // 锚点 = 被删区间前一个仍存在的字符；折叠时让光标落在新文本后
  const anchorId = prefix > 0 ? oldIds[prefix - 1] : -1;

  awaitingAck = true;
  needsFlush = false;
  if (removedIds.length) {
    pendingCaret = null; // 跟随插入操作恢复，或在仅删除时折叠到锚点后
    worker.postMessage({ type: 'delete', ids: removedIds });
  }
  if (inserted.length) {
    pendingCaret = 'inserted';
    worker.postMessage({ type: 'insert', after: anchorId, text: inserted });
  } else if (!removedIds.length) {
    return;
  } else if (anchorId === -1) {
    pendingCaret = 'end';
  } else {
    pendingCaret = { anchorId, headId: anchorId, fallback: prefix };
  }
}

// ---------- 加粗 ----------

function toggleBold() {
  if (replayView) return;
  const sel = selectionOffsets();
  if (!sel || sel.start === sel.end) return;
  const ids = liveView.ids.slice(sel.start, sel.end);
  if (!ids.length) return;
  // 选区全部为加粗则取消加粗，否则加粗
  const allBold = liveView.runs.some(([s, e]) => s <= sel.start && sel.end <= e);
  worker.postMessage({ type: 'format', ids, on: !allBold });
}

boldBtn.addEventListener('click', toggleBold);
editor.addEventListener('keydown', (ev) => {
  if (ev.key === 'b' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    toggleBold();
  }
});

// 阻止浏览器把粘贴/拖放变成富文本，交给 input 差分统一处理
editor.addEventListener('paste', (ev) => ev.preventDefault());
editor.addEventListener('drop', (ev) => ev.preventDefault());

// ---------- 时间轴回放 ----------

let replayPlaying = false;

function enterReplay() {
  replayView = null;
  replayPlaying = false;
  replaybar.hidden = false;
  editor.contentEditable = 'false';
  modeBadge.textContent = '回放';
  modeBadge.classList.add('replay');
  replayBtn.disabled = true;
  worker.postMessage({ type: 'replay-enter' });
}

function exitReplay() {
  replayView = null;
  replayPlaying = false;
  replaybar.hidden = true;
  editor.contentEditable = 'true';
  modeBadge.textContent = '实时';
  modeBadge.classList.remove('replay');
  replayBtn.disabled = false;
  pendingCaret = 'end';
  worker.postMessage({ type: 'replay-exit' });
}

replayBtn.addEventListener('click', enterReplay);
exitReplayBtn.addEventListener('click', exitReplay);
playBtn.addEventListener('click', () => {
  if (replayPlaying) {
    replayPlaying = false;
    worker.postMessage({ type: 'replay-pause' });
  } else {
    replayPlaying = true;
    playBtn.textContent = '⏸';
    worker.postMessage({ type: 'replay-play', speed: Number(speedSelect.value) });
  }
});
stepBackBtn.addEventListener('click', () => worker.postMessage({ type: 'replay-step', dir: -1 }));
stepFwdBtn.addEventListener('click', () => worker.postMessage({ type: 'replay-step', dir: 1 }));
let seekTimer = 0;
timeline.addEventListener('input', () => {
  const index = Number(timeline.value);
  replayIndexEl.textContent = index;
  clearTimeout(seekTimer);
  seekTimer = setTimeout(() => worker.postMessage({ type: 'replay-seek', index }), 30);
});

// ---------- 自动编辑演示（模拟持续并发，便于单标签页验收回放/性能） ----------

let autoTimer = 0;
const AUTO_WORDS = ['协作', '合并', '时间轴', '墓碑', '广播', '向量时钟', '一致性', '快照', '锚点', '回放'];
autoBtn.addEventListener('click', () => {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = 0;
    autoBtn.textContent = '▶ 自动编辑';
    return;
  }
  autoBtn.textContent = '■ 停止自动';
  autoTimer = setInterval(() => {
    if (replayView || liveView.ids.length === 0) return;
    const idx = Math.floor(Math.random() * liveView.ids.length);
    const word = AUTO_WORDS[Math.floor(Math.random() * AUTO_WORDS.length)];
    worker.postMessage({ type: 'insert', after: liveView.ids[idx], text: word });
  }, 120);
});

// ---------- FPS 监测 ----------

let frames = 0;
let lastFpsTime = performance.now();
function fpsLoop(now) {
  frames++;
  if (now - lastFpsTime >= 500) {
    const fps = Math.round((frames * 1000) / (now - lastFpsTime));
    fpsEl.textContent = `FPS ${fps}`;
    fpsEl.style.color = fps >= 55 ? '#00b42a' : fps >= 30 ? '#ff7d00' : '#f53f3f';
    frames = 0;
    lastFpsTime = now;
  }
  requestAnimationFrame(fpsLoop);
}
requestAnimationFrame(fpsLoop);

// 标签页重新可见时主动握手，加速断网/休眠恢复
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) worker.postMessage({ type: 'hello' });
});
window.addEventListener('online', () => worker.postMessage({ type: 'hello' }));
