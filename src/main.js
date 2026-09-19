import { getEditorOffsets, setEditorOffsets } from './dom-selection.js';

const $ = (selector) => document.querySelector(selector);

const editor = $('#editor');
const peerId = $('#peerId');
const statusPill = $('#statusPill');
const boldButton = $('#boldButton');
const sampleButton = $('#sampleButton');
const syncButton = $('#syncButton');
const liveToggle = $('#liveToggle');
const historyButton = $('#historyButton');
const firstButton = $('#firstButton');
const prevButton = $('#prevButton');
const playButton = $('#playButton');
const nextButton = $('#nextButton');
const liveButton = $('#liveButton');
const timeline = $('#timeline');
const speedSelect = $('#speedSelect');
const timelinePosition = $('#timelinePosition');
const timelineMode = $('#timelineMode');
const docStats = $('#docStats');
const operationDetail = $('#operationDetail');
const fpsStats = $('#fpsStats');

const client = crypto.randomUUID();
peerId.textContent = `本标签页 Client：${client.slice(0, 8)}（数据存于同源 IndexedDB）`;

const worker = new Worker('./worker/main.js', { type: 'module' });

let liveDoc = emptyDoc();
let displayedDoc = liveDoc;
let historyMode = false;
let playing = false;
let ready = false;
let composing = false;
let activeBold = false;
let renderQueued = false;
let renderSource = 'live';
let pendingReplay = null;
let pendingTimelineMeta = null;
let requestSeq = 0;
const pendingRequests = new Map();
let compositionAnchors = null;

function emptyDoc() {
  return {
    text: '',
    bold: new Uint8Array(0),
    lamports: new Uint32Array(0),
    seqs: new Uint32Array(0),
    parts: new Uint32Array(0),
    clients: [],
    clientCodes: new Uint32Array(0),
  };
}

function idString(doc, index) {
  return `${doc.lamports[index]}:${doc.seqs[index]}:${doc.clients[doc.clientCodes[index]]}:${doc.parts[index]}`;
}

function idIndex(doc) {
  const map = new Map();
  for (let i = 0; i < doc.text.length; i += 1) map.set(idString(doc, i), i);
  return map;
}

function indexOfId(doc, id) {
  if (!id) return -1;
  if (!doc._idIndex) {
    Object.defineProperty(doc, '_idIndex', { value: idIndex(doc), enumerable: false });
  }
  return doc._idIndex.get(id) ?? -1;
}

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function renderDoc(doc) {
  const paragraphs = doc.text.split('\n');
  let globalOffset = 0;
  const html = paragraphs.map((paragraph) => {
    if (!paragraph) return '<p><br></p>';
    let result = '';
    let boldRun = null;
    let runText = '';
    const flush = () => {
      const safe = escapeHtml(runText);
      result += boldRun ? `<strong>${safe}</strong>` : safe;
      runText = '';
    };
    for (let i = 0; i < paragraph.length; i += 1) {
      const isBold = doc.bold[globalOffset + i] === 1;
      if (boldRun === null) boldRun = isBold;
      if (isBold !== boldRun) {
        flush();
        boldRun = isBold;
      }
      runText += paragraph[i];
    }
    flush();
    globalOffset += paragraph.length + 1;
    return `<p>${result}</p>`;
  }).join('');

  editor.innerHTML = html;
}

function queueRender(source = 'live') {
  renderSource = source;
  if (renderQueued) return;
  renderQueued = true;
  const requestedSource = source;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderSource = requestedSource === 'replay' ? 'replay' : 'live';
    const oldDoc = displayedDoc;
    const offsets = !historyMode && !composing ? getEditorOffsets(editor) : null;
    const anchors = offsets && {
      start: offsets.start > 0 ? idString(oldDoc, offsets.start - 1) : null,
      end: offsets.end > 0 ? idString(oldDoc, offsets.end - 1) : null,
    };

    displayedDoc = renderSource === 'replay' && pendingReplay ? pendingReplay.doc : liveDoc;
    editor.contentEditable = String(!historyMode);
    renderDoc(displayedDoc);

    if (renderSource === 'live' && !historyMode && !composing && anchors) {
      const startIndex = anchors.start ? indexOfId(displayedDoc, anchors.start) + 1 : 0;
      const endIndex = anchors.end ? indexOfId(displayedDoc, anchors.end) + 1 : 0;
      setEditorOffsets(editor, startIndex, endIndex || startIndex);
    }

    const request = Array.from(pendingRequests.values()).at(-1);
    if (request && renderSource === 'live') {
      pendingRequests.delete(request.requestId);
      const startIndex = request.anchor ? indexOfId(displayedDoc, request.anchor) + 1 : 0;
      let endIndex = startIndex;
      if (request.kind === 'insert' && request.length) endIndex = startIndex + request.length;
      if (request.kind === 'delete') endIndex = startIndex;
      setEditorOffsets(editor, startIndex, endIndex);
      editor.focus();
    }
  });
}

function send(message) {
  worker.postMessage(message);
}

function captureSelection(offsetAdjust = 0) {
  const offsets = getEditorOffsets(editor) || { start: 0, end: 0 };
  const start = Math.max(0, offsets.start + offsetAdjust);
  const end = Math.max(start, offsets.end + offsetAdjust);
  return {
    start,
    end,
  };
}

function nextRequestId() {
  requestSeq += 1;
  return `req-${requestSeq}`;
}

function rememberSelection(requestId, kind, startOffset, length = 0) {
  const anchor = startOffset > 0 ? idString(liveDoc, startOffset - 1) : null;
  pendingRequests.set(requestId, { requestId, kind, startOffset, length, anchor });
}

function sendInsert(text, startOffset, bold = activeBold, remember = true) {
  const requestId = nextRequestId();
  if (remember) rememberSelection(requestId, 'insert', startOffset, Array.from(text).length);
  send({ type: 'insert', requestId, client, text, startOffset, bold });
}

function sendReplace(text, selection, bold = false) {
  const requestId = nextRequestId();
  rememberSelection(requestId, 'insert', selection.start, Array.from(text).length);
  send({
    type: 'replace',
    requestId,
    client,
    text,
    startOffset: selection.start,
    endOffset: selection.end,
    bold,
  });
}

function sendDelete(selection) {
  if (selection.end <= selection.start) return;
  const requestId = nextRequestId();
  rememberSelection(requestId, 'delete', selection.start, 0);
  send({ type: 'delete', requestId, client, startOffset: selection.start, endOffset: selection.end });
}

function sendBold(selection, bold) {
  if (selection.end <= selection.start) return;
  const requestId = nextRequestId();
  rememberSelection(requestId, 'bold', selection.start, 0);
  send({ type: 'bold', requestId, client, startOffset: selection.start, endOffset: selection.end, bold });
}

editor.addEventListener('beforeinput', (event) => {
  if (!ready || historyMode || composing) return;
  const inputType = event.inputType;

  if (inputType === 'insertText' || inputType === 'insertParagraph') {
    event.preventDefault();
    const selection = captureSelection();
    const text = inputType === 'insertParagraph' ? '\n' : event.data || '';
    sendReplace(text, selection, activeBold && text !== '\n');
    activeBold = false;
    return;
  }

  if (inputType === 'insertFromPaste' || inputType === 'insertFromDrop' || inputType === 'insertReplacementText') {
    event.preventDefault();
    const text = (event.dataTransfer?.getData('text/plain') || event.data || '').replace(/\r\n?/g, '\n');
    const selection = captureSelection();
    sendReplace(text.slice(0, 200000), selection, false);
    return;
  }

  if (inputType === 'deleteContentBackward' || inputType === 'deleteContentForward' || inputType === 'deleteByCut') {
    event.preventDefault();
    const currentOffsets = getEditorOffsets(editor);
    const collapsed = currentOffsets && currentOffsets.start === currentOffsets.end;
    const adjustment = inputType === 'deleteContentBackward' && collapsed ? -1 : 0;
    const selection = captureSelection(adjustment);
    sendDelete(selection);
    return;
  }

  if (inputType === 'insertLineBreak') {
    event.preventDefault();
    const selection = captureSelection();
    sendReplace('\n', selection, false);
    return;
  }

  if (inputType.startsWith('history')) event.preventDefault();
});

editor.addEventListener('compositionstart', () => {
  composing = true;
  compositionAnchors = captureSelection();
});

editor.addEventListener('compositionend', (event) => {
  const text = String(event.data || '');
  const selection = compositionAnchors || captureSelection();
  composing = false;
  compositionAnchors = null;
  if (text) {
    sendReplace(text, selection, activeBold);
  } else {
    queueRender();
  }
});

editor.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
    event.preventDefault();
    const selection = captureSelection();
    if (selection.end > selection.start) {
      let allBold = true;
      for (let i = selection.start; i < selection.end; i += 1) {
        if (liveDoc.bold[i] !== 1) { allBold = false; break; }
      }
      sendBold(selection, !allBold);
    } else {
      activeBold = !activeBold;
      boldButton.classList.toggle('active', activeBold);
    }
  }
});

boldButton.addEventListener('mousedown', (event) => event.preventDefault());
boldButton.addEventListener('click', () => {
  const selection = captureSelection();
  if (selection.end > selection.start) {
    let allBold = true;
    for (let i = selection.start; i < selection.end; i += 1) {
      if (liveDoc.bold[i] !== 1) { allBold = false; break; }
    }
    sendBold(selection, !allBold);
  } else {
    activeBold = !activeBold;
    boldButton.classList.toggle('active', activeBold);
  }
});

sampleButton.addEventListener('click', () => {
  if (liveDoc.text.length > 0) return;
  send({ type: 'sample', requestId: nextRequestId(), client });
});

syncButton.addEventListener('click', () => send({ type: 'requestSync' }));

window.addEventListener('online', () => {
  statusPill.textContent = '在线 · 已请求同步';
  send({ type: 'requestSync' });
});
window.addEventListener('offline', () => {
  statusPill.textContent = '离线 · 本地写入仍可用';
  statusPill.classList.add('offline');
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && ready) send({ type: 'requestSync' });
});

function describeOperation(op) {
  if (!op) return '空文档：尚未应用任何操作。';
  const vclock = Object.entries(op.vclock || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key.slice(0, 6)}:${value}`)
    .join(', ');
  const target = op.kind === 'insert'
    ? `插入 ${Array.from(op.text).length} 字符`
    : `${op.kind === 'delete' ? '删除' : '加粗'} ${op.targets.length} 字符`;
  return `${target}<br>opId=${op.opId} · lamport=${op.lamport} · 因果向量={${vclock}}<br>parent=${op.parentId || '-'} · LWW bold=${String(op.bold)} · ts=${new Date(op.ts).toLocaleString()}`;
}

function updateTimelineUI() {
  const value = pendingReplay;
  if (value) {
    timeline.max = value.total;
    timeline.value = value.version;
    timelinePosition.textContent = `${value.version} / ${value.total} 次操作`;
    operationDetail.innerHTML = describeOperation(value.operation);
  } else if (pendingTimelineMeta) {
    timeline.max = pendingTimelineMeta.total;
    timeline.value = pendingTimelineMeta.total;
    timelinePosition.textContent = `${pendingTimelineMeta.total} / ${pendingTimelineMeta.total} 次操作`;
  }
  timelineMode.textContent = historyMode ? (playing ? '回放中' : '历史暂停') : '实时模式';
  playButton.textContent = playing ? '⏸' : '▶';
  statusPill.classList.toggle('history', historyMode);
  statusPill.classList.toggle('ready', ready && !historyMode);
  if (ready && !historyMode) statusPill.textContent = navigator.onLine ? '实时 · Worker 合并中' : '离线 · 本地持久化';
}

historyButton.addEventListener('click', () => {
  historyMode = true;
  liveToggle.checked = false;
  send({ type: 'replaySeek', version: Number(timeline.value || 0) });
});
firstButton.addEventListener('click', () => send({ type: 'replaySeek', version: 0 }));
prevButton.addEventListener('click', () => send({ type: 'replayStep', direction: -1 }));
nextButton.addEventListener('click', () => send({ type: 'replayStep', direction: 1 }));
liveButton.addEventListener('click', () => {
  historyMode = false;
  playing = false;
  liveToggle.checked = true;
  send({ type: 'exitHistory' });
});
playButton.addEventListener('click', () => {
  if (playing) send({ type: 'replayPause' });
  else send({ type: 'replayPlay', speed: Number(speedSelect.value) });
});
timeline.addEventListener('input', () => {
  historyMode = true;
  liveToggle.checked = false;
  send({ type: 'replaySeek', version: Number(timeline.value) });
});
speedSelect.addEventListener('change', () => {
  if (playing) send({ type: 'replayPlay', speed: Number(speedSelect.value) });
});
liveToggle.addEventListener('change', () => {
  if (liveToggle.checked) liveButton.click();
});

worker.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case 'ready':
      ready = true;
      statusPill.classList.add('ready');
      statusPill.textContent = '实时 · Worker 合并中';
      break;
    case 'snapshot':
      liveDoc = message.doc;
      docStats.textContent = `${message.chars} 字 · ${message.opCount} 操作 · 待依赖 ${message.pending}`;
      if (!historyMode || liveToggle.checked) queueRender('live');
      break;
    case 'timelineMeta':
      pendingTimelineMeta = message;
      updateTimelineUI();
      break;
    case 'replaySnapshot':
      pendingReplay = message;
      playing = Boolean(message.playing);
      historyMode = true;
      liveToggle.checked = false;
      queueRender('replay');
      updateTimelineUI();
      break;
    case 'applied': {
      pendingRequests.delete(message.requestId);
      break;
    }
  }
};

send({ type: 'init', client });

let fpsFrames = 0;
let fpsLastFrame = performance.now();
let fpsWindowStart = fpsLastFrame;
function measureFrame(now) {
  fpsFrames += 1;
  const frameMs = now - fpsLastFrame;
  fpsLastFrame = now;
  if (now - fpsWindowStart >= 500) {
    const fps = Math.round((fpsFrames * 1000) / (now - fpsWindowStart));
    fpsStats.textContent = `${fps} fps · ${frameMs.toFixed(1)} ms/帧`;
    fpsFrames = 0;
    fpsWindowStart = now;
  }
  requestAnimationFrame(measureFrame);
}
requestAnimationFrame(measureFrame);
