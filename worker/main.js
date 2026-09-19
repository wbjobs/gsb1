import {
  applyOperation,
  createCRDT,
  idAt,
  makeInsertOperation,
  makeRangeOperation,
  nodeKey,
  parseNodeId,
  snapshot,
} from '../src/crdt.js';
import { ReplayEngine } from '../src/replay.js';
import { getAllOperations, putOperation, putOperations } from './idb.js';

const CHANNEL_NAME = 'serverless-crdt-doc-v1';
const channel = new BroadcastChannel(CHANNEL_NAME);

const live = createCRDT();
const replay = new ReplayEngine();
let operations = [];
let replayScheduled = false;
let historyMode = false;
let playing = false;
let playTimer = 0;
let playSpeed = 20;
let ready = false;
let currentDocSnapshot = null;

const queue = {
  chain: Promise.resolve(),
  add(task) {
    const run = this.chain.then(() => task());
    this.chain = run.then(() => {}, () => {});
    return run;
  },
};

function transferableBuffers(doc) {
  return [doc.bold.buffer, doc.lamports.buffer, doc.seqs.buffer, doc.parts.buffer, doc.clientCodes.buffer];
}

function postDoc() {
  const doc = snapshot(live);
  currentDocSnapshot = doc;
  const opCount = operations.length;
  const chars = doc.text.length;
  const pending = live.pending.length;
  postMessage({
    type: 'snapshot',
    doc,
    opCount,
    chars,
    pending,
    liveVersion: opCount,
  }, transferableBuffers(doc));
}

function scheduleReplayIndex() {
  if (replayScheduled) return;
  replayScheduled = true;
  setTimeout(() => {
    replayScheduled = false;
    replay.update(operations);
    if (historyMode) postReplay(replay.version);
    else postTimelineMeta();
  }, 150);
}

function postTimelineMeta() {
  postMessage({
    type: 'timelineMeta',
    total: operations.length,
    historyMode,
    playing,
  });
}

function postReplay(version) {
  const value = replay.seek(version);
  const buffers = transferableBuffers(value.doc);
  postMessage({
    type: 'replaySnapshot',
    ...value,
    playing,
  }, buffers);
}

function applyCommittedOperation(op) {
  if (applyOperation(live, op) === 'applied') return true;
  return live.applied.has(op.opId);
}

function flushPendingOperations() {
  const pending = live.pending.slice();
  for (const op of pending) applyOperation(live, op);
}

async function commitOperations(incoming, { broadcast = false, source = null } = {}) {
  const fresh = [];
  const seen = new Set(operations.map((op) => op.opId));
  for (const op of incoming) {
    if (!op || typeof op.client !== 'string' || !Number.isInteger(op.seq) || seen.has(op.opId)) continue;
    seen.add(op.opId);
    fresh.push(op);
  }
  if (!fresh.length) return [];

  await putOperations(fresh);
  operations.push(...fresh);
  operations.sort((a, b) => a.client === b.client ? a.seq - b.seq : a.client < b.client ? -1 : 1);
  for (const op of fresh) applyCommittedOperation(op);
  flushPendingOperations();

  if (broadcast) {
    for (const op of fresh) {
      channel.postMessage({
        kind: 'operation',
        op,
        from: source,
      });
    }
  }
  return fresh;
}

function commitLocalOperation(op) {
  return queue.add(async () => {
    if (live.applied.has(op.opId)) return op;
    await putOperation(op);
    if (!operations.some((item) => item.opId === op.opId)) operations.push(op);
    applyCommittedOperation(op);
    flushPendingOperations();
    channel.postMessage({ kind: 'operation', op, from: op.client });
    return op;
  });
}

function resolveAnchor(anchor, fallbackOffset = null) {
  if (!anchor) return 'ROOT';
  const parsed = parseNodeId(anchor);
  return live.nodes.has(nodeKey(parsed)) ? anchor : 'ROOT';
}

function resolveInsertAnchor(anchor, startOffset) {
  if (anchor) {
    const parsed = parseNodeId(anchor);
    if (live.nodes.has(nodeKey(parsed))) return anchor;
  }
  if (Number.isInteger(startOffset) && startOffset > 0) {
    const doc = snapshot(live);
    const id = idAt(doc, startOffset - 1);
    if (id) return nodeKey(id);
  }
  return 'ROOT';
}

function getVisibleContext() {
  const doc = snapshot(live);
  const nodeIds = new Map();
  for (let offset = 0; offset < doc.text.length; offset += 1) {
    nodeIds.set(offset, nodeKey(idAt(doc, offset)));
  }
  return { doc, nodeIds };
}

function resolveRangeTargets(context, startOffset, endOffset, includeNewline = false) {
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) return [];
  const targets = [];
  for (let offset = startOffset; offset < endOffset && offset < context.doc.text.length; offset += 1) {
    if (!includeNewline && context.doc.text[offset] === '\n') continue;
    const id = context.nodeIds.get(offset);
    if (id) targets.push(id);
  }
  return targets;
}

function anchorBefore(context, startOffset) {
  if (!Number.isInteger(startOffset) || startOffset <= 0) return 'ROOT';
  return context.nodeIds.get(startOffset - 1) || 'ROOT';
}

async function handleInsert(request) {
  const text = String(request.text || '');
  if (!text || text.length > 200000) throw new Error('Invalid insert text');
  const leftId = resolveInsertAnchor(request.leftId, request.startOffset);
  const op = makeInsertOperation(live, request.client, leftId, text, request.bold);
  await commitLocalOperation(op);
  if (!historyMode) postDoc();
  scheduleReplayIndex();
  postMessage({
    type: 'applied',
    requestId: request.requestId,
    op,
    insertedLength: Array.from(text).length,
  });
}

async function handleReplace(request) {
  const context = getVisibleContext();
  const created = [];
  const validTargets = request.ids?.length
    ? request.ids.filter((anchor) => live.nodes.has(nodeKey(parseNodeId(anchor))))
    : resolveRangeTargets(context, request.startOffset, request.endOffset, true);
  if (validTargets.length) {
    created.push(makeRangeOperation(live, request.client, 'delete', validTargets, false));
  }
  const text = String(request.text || '');
  if (text) {
    const leftId = anchorBefore(context, request.startOffset);
    const insertState = created[0] ? {
      ...live,
      vclock: { ...live.vclock, [request.client]: (live.vclock[request.client] || 0) + 1 },
      lamport: live.lamport + 1,
    } : live;
    created.push(created[0]
      ? makeInsertOperation(insertState, request.client, leftId, text, request.bold)
      : makeInsertOperation(live, request.client, leftId, text, request.bold));
  }
  await commitOperations(created, { broadcast: true, source: request.client });
  if (!historyMode) postDoc();
  scheduleReplayIndex();
  postMessage({
    type: 'applied',
    requestId: request.requestId,
    insertedLength: Array.from(text).length,
  });
}

function makeSampleOperations(client) {
  const template = createCRDT();
  const chunks = Array.from({ length: 100 }, (_, index) => (
    `第${String(index + 1).padStart(3, '0')}片：${'这是用于验证一万字以上长文档性能、跨标签合并、刷新恢复与时间轴回放的中文内容。'.repeat(3)}\n`
  ));
  const operationsToCreate = [];
  let parentId = 'ROOT';
  chunks.forEach((text, index) => {
    const op = makeInsertOperation(template, client, parentId, index === 0 ? `长文档验收样例。\n${text}` : text, false, index + 1);
    operationsToCreate.push(op);
    applyOperation(template, op);
    const chars = Array.from(op.text);
    parentId = nodeKey([op.lamport, op.seq, op.client, chars.length - 1]);
  });
  return operationsToCreate;
}

async function handleSample(request) {
  if (snapshot(live).text.length > 0) return;
  const sampleOperations = makeSampleOperations(request.client);
  await commitOperations(sampleOperations, { broadcast: true, source: request.client });
  if (!historyMode) postDoc();
  scheduleReplayIndex();
}

async function handleRange(request) {
  const targets = request.ids?.length
    ? request.ids.filter((anchor) => live.nodes.has(nodeKey(parseNodeId(anchor))))
    : resolveRangeTargets(getVisibleContext(), request.startOffset, request.endOffset, request.kind === 'delete');
  if (!targets.length) {
    postMessage({ type: 'applied', requestId: request.requestId, op: null, noop: true });
    return;
  }
  const op = makeRangeOperation(live, request.client, request.kind, targets, request.bold);
  await commitLocalOperation(op);
  if (!historyMode) postDoc();
  scheduleReplayIndex();
  postMessage({ type: 'applied', requestId: request.requestId, op });
}

function missingForClock(clock) {
  return operations.filter((op) => op.seq > (clock?.[op.client] || 0));
}

function sendHello() {
  channel.postMessage({
    kind: 'hello',
    vclock: live.vclock,
    from: currentClient,
  });
}

let currentClient = null;

channel.onmessage = (event) => {
  if (!ready || !currentClient) return;
  const message = event.data;
  if (!message || message.from === currentClient) return;

  if (message.kind === 'hello') {
    const missing = missingForClock(message.vclock);
    if (missing.length) {
      queue.add(() => commitOperations(missing, { broadcast: false, source: currentClient }));
    }
    return;
  }

  if (message.kind === 'operation' && message.op) {
    queue.add(async () => {
      const committed = await commitOperations([message.op], { broadcast: false, source: message.from });
      if (committed.length) {
        if (!historyMode) postDoc();
        scheduleReplayIndex();
      }
    });
  }
};

function stopPlayback() {
  if (playTimer) clearInterval(playTimer);
  playTimer = 0;
  playing = false;
}

function startPlayback() {
  if (playing) return;
  if (replay.version >= replay.operations.length) replay.seek(0);
  playing = true;
  playTimer = setInterval(() => {
    if (replay.version >= replay.operations.length) {
      stopPlayback();
      postReplay(replay.version);
      return;
    }
    const next = Math.min(replay.version + Math.max(1, playSpeed), replay.operations.length);
    postReplay(next);
  }, 250);
}

onmessage = (event) => {
  const request = event.data;
  if (!request?.type) return;

  if (request.type === 'init') {
    currentClient = request.client;
    queue.add(async () => {
      const stored = await getAllOperations();
      await commitOperations(stored, { broadcast: false });
      replay.rebuild(operations);
      ready = true;
      postDoc();
      postTimelineMeta();
      sendHello();
      setInterval(sendHello, 5000);
      postMessage({ type: 'ready' });
    });
    return;
  }

  if (!ready) {
    postMessage({ type: 'notReady' });
    return;
  }

  switch (request.type) {
    case 'insert':
      queue.add(() => handleInsert(request));
      break;
    case 'replace':
      queue.add(() => handleReplace(request));
      break;
    case 'delete':
      queue.add(() => handleRange({ ...request, kind: 'delete' }));
      break;
    case 'bold':
      queue.add(() => handleRange({ ...request, kind: 'bold' }));
      break;
    case 'requestSync':
      sendHello();
      break;
    case 'sample':
      queue.add(() => handleSample(request));
      break;
    case 'replaySeek':
      historyMode = true;
      stopPlayback();
      postReplay(Number(request.version || 0));
      break;
    case 'replayPlay':
      historyMode = true;
      playSpeed = Number(request.speed || 20);
      startPlayback();
      postReplay(replay.version);
      break;
    case 'replayPause':
      stopPlayback();
      postReplay(replay.version);
      break;
    case 'replayStep':
      historyMode = true;
      stopPlayback();
      postReplay(request.direction < 0 ? replay.version - 1 : replay.version + 1);
      break;
    case 'exitHistory':
      historyMode = false;
      stopPlayback();
      postDoc();
      postTimelineMeta();
      break;
  }
};
