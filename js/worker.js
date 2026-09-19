// 协作 Worker：
//   IndexedDB 持久化 + BroadcastChannel 同步 + 因果缓冲 + 时间轴回放索引
// 主线程只发送编辑意图、接收渲染状态，不做任何合并计算。

import {
  Doc,
  newSiteId,
  charId,
  opBaseId,
  isReady,
  canonicalOrder,
} from './crdt.js';
import {
  openDB,
  putOp,
  putOpsBulk,
  getAllOps,
  countOps,
  getMeta,
  setMeta,
} from './idb.js';
import { buildSeedOps } from './seed.js';

const CHANNEL_NAME = 'crdt-doc-v1';
const SEED_LOCK = 'crdt-doc-seed-v1';
const SNAPSHOT_EVERY = 500;
const SPEED_DELAYS = [400, 140, 40, 8]; // 1x / 4x / 16x / 64x
const SPEED_BATCH = [1, 1, 2, 8];

let db = null;
let live = null;
let channel = null;
let allOps = []; // 规范顺序的全部操作（时间轴）
const pending = []; // 因果未满足的操作
const knownIds = new Set(); // 已知操作 baseId，去重
const peers = new Map(); // site -> 最后 hello 时间
let stateScheduled = false;
let forceEmit = false;

// ---------- 工具 ----------

function shortSite(site) {
  return site.slice(0, 4);
}

function describeOp(op) {
  const who = shortSite(op.site);
  if (op.kind === 'ins') return `插入 ${Array.from(op.text).length} 字 @${who}`;
  if (op.kind === 'del') return `删除 ${op.targets.length} 字 @${who}`;
  if (op.kind === 'bold') return `加粗 ${op.targets.length} 字 @${who}`;
  return `取消加粗 ${op.targets.length} 字 @${who}`;
}

function scheduleState() {
  if (stateScheduled) return;
  stateScheduled = true;
  setTimeout(() => {
    stateScheduled = false;
    emitState();
  }, 16);
}

function emitState() {
  const rendered = live.render();
  const msg = {
    type: 'state',
    text: rendered.text,
    ids: rendered.ids,
    runs: rendered.runs,
    site: live.site,
    opCount: allOps.length,
    chars: rendered.ids.length,
    peers: [...peers.keys()].filter((s) => s !== live.site).length,
    ts: Date.now(),
  };
  forceEmit = false;
  self.postMessage(msg);
}

// ---------- 操作入库与合并 ----------

// 已应用操作的规范顺序插入：二分查找位置。
// 实时操作几乎总在末尾（O(log n) + 偶尔 O(n) 搬移），休眠后批量补传也不会退化。
function insertInOrder(op) {
  let lo = 0;
  let hi = allOps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (canonicalOrder(allOps[mid], op) < 0) lo = mid + 1;
    else hi = mid;
  }
  allOps.splice(lo, 0, op);
}

function drainPending() {
  if (pending.length === 0) return;
  // 因果缓冲的正确性要点：
  // 不能按规范序（lamp）排序冲刷——规范序会把“依赖尚未到达”的操作排到
  // “另一个站点已经就绪”的操作前面，造成假死锁。每轮只需要在缓冲里
  // 找到任意一个依赖已满足的操作应用即可；RGA 保证与应用顺序无关地收敛。
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let i = 0; i < pending.length; i++) {
      if (isReady(pending[i], live.vclock)) {
        const [op] = pending.splice(i, 1);
        live.apply(op);
        insertInOrder(op);
        progressed = true;
        break;
      }
    }
  }
}

function ingestPersistedOp(op) {
  // 调用前已写入 IndexedDB
  if (live.hasApplied(op)) return;
  if (!isReady(op, live.vclock)) {
    pending.push(op);
    return;
  }
  live.apply(op);
  insertInOrder(op);
  drainPending();
  scheduleState();
}

async function receiveRemote(ops) {
  const fresh = [];
  for (const op of ops) {
    const id = opBaseId(op);
    if (knownIds.has(id) || live.hasApplied(op)) continue;
    knownIds.add(id);
    fresh.push({ ...op, id });
  }
  if (!fresh.length) return;
  await putOpsBulk(db, fresh); // 收到的操作：先写 IndexedDB，再合并
  for (const row of fresh) ingestPersistedOp(row);
}

async function commitLocal(op) {
  const id = opBaseId(op);
  await putOp(db, { ...op, id }); // 本地操作：先写 IndexedDB，再广播
  knownIds.add(id);
  live.apply(op);
  insertInOrder(op);
  drainPending();
  channel.postMessage({ t: 'op', site: live.site, op });
  scheduleState();
}

// ---------- 广播通道 ----------

function setupChannel() {
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = async (ev) => {
    const msg = ev.data;
    if (!msg || msg.site === live.site) return;
    peers.set(msg.site, Date.now());
    if (msg.t === 'op') {
      await receiveRemote([msg.op]).catch((e) => console.error(e));
    } else if (msg.t === 'hello') {
      sendMissingTo(msg.vclock || {});
    } else if (msg.t === 'sync') {
      await receiveRemote(msg.ops || []).catch((e) => console.error(e));
    }
  };

  setInterval(sendHello, 2500);
  setInterval(prunePeers, 3000);
  self.addEventListener('online', sendHello);
  setTimeout(sendHello, 300);
}

function prunePeers() {
  const now = Date.now();
  for (const [site, t] of peers) {
    if (now - t > 7000) peers.delete(site);
  }
  scheduleState();
}

function sendHello() {
  if (!channel || !live) return;
  channel.postMessage({ t: 'hello', site: live.site, vclock: live.vclock });
}

function sendMissingTo(peerVclock) {
  const missing = allOps.filter((op) => (peerVclock[op.site] || 0) < op.seq);
  if (!missing.length) return;
  const CHUNK = 200;
  for (let i = 0; i < missing.length; i += CHUNK) {
    channel.postMessage({
      t: 'sync',
      site: live.site,
      ops: missing.slice(i, i + CHUNK),
    });
  }
}

// ---------- 时间轴回放（独立临时文档 + 快照索引） ----------

const replay = {
  active: false,
  ops: [],
  doc: null,
  index: 0,
  snapshots: new Map(),
  playing: false,
  speed: 0,
  timer: 0,
};

function replaySnapshotKey(index) {
  return Math.floor(index / SNAPSHOT_EVERY) * SNAPSHOT_EVERY;
}

function rebuildReplayTo(target) {
  target = Math.max(0, Math.min(target, replay.ops.length));
  if (replay.index > target) {
    // 回跳：选择不超过目标位置的最近快照
    let key = replaySnapshotKey(target);
    while (key > 0 && !replay.snapshots.has(key)) key -= SNAPSHOT_EVERY;
    if (replay.snapshots.has(key)) {
      replay.doc = Doc.fromJSON(replay.snapshots.get(key));
    } else {
      replay.doc = new Doc(live.site);
    }
    replay.index = key;
  }
  while (replay.index < target) {
    // 每个操作在这份临时文档上只向前应用一次；
    // Doc.applied 集合再兜底，绝不重复应用。
    replay.doc.apply(replay.ops[replay.index]);
    replay.index++;
    if (replay.index % SNAPSHOT_EVERY === 0 && !replay.snapshots.has(replay.index)) {
      replay.snapshots.set(replay.index, replay.doc.toJSON());
    }
  }
}

function emitReplay() {
  const applied = replay.index > 0 ? replay.ops[replay.index - 1] : null;
  const rendered = replay.doc.render();
  self.postMessage({
    type: 'replay-state',
    index: replay.index,
    total: replay.ops.length,
    text: rendered.text,
    ids: rendered.ids,
    runs: rendered.runs,
    description: applied ? describeOp(applied) : '空白文档',
    ts: applied ? applied.ts : 0,
  });
}

function replayTick() {
  if (!replay.active || !replay.playing) return;
  const batch = SPEED_BATCH[replay.speed];
  const next = Math.min(replay.index + batch, replay.ops.length);
  rebuildReplayTo(next);
  emitReplay();
  if (replay.index >= replay.ops.length) {
    replay.playing = false;
    return;
  }
  replay.timer = setTimeout(replayTick, SPEED_DELAYS[replay.speed]);
}

function enterReplay() {
  clearTimeout(replay.timer);
  replay.active = true;
  replay.ops = allOps.slice().sort(canonicalOrder);
  replay.doc = new Doc(live.site);
  replay.index = 0;
  replay.snapshots = new Map();
  replay.playing = false;
  emitReplay();
}

function exitReplay() {
  clearTimeout(replay.timer);
  replay.active = false;
  replay.playing = false;
  replay.doc = null;
  replay.ops = [];
  replay.snapshots = new Map();
  forceEmit = true;
  emitState();
}

// ---------- 启动 ----------

async function bootstrap() {
  db = await openDB();

  let site = await getMeta(db, 'site');
  if (!site) {
    site = newSiteId();
    await setMeta(db, 'site', site);
  }
  live = new Doc(site);

  let stored = await getAllOps(db);
  if (stored.length === 0) {
    // 只有抢到锁的标签页播种，避免多个空库标签页同时播种重复内容
    await new Promise((resolve) => {
      if (!navigator.locks || !navigator.locks.request) return resolve();
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      try {
        const p = navigator.locks.request(SEED_LOCK, { ifAvailable: true }, async (lock) => {
          try {
            if (lock && (await countOps(db)) === 0) {
              const seeded = new Doc(site);
              const ops = buildSeedOps(seeded);
              await putOpsBulk(db, ops.map((op) => ({ ...op, id: opBaseId(op) })));
            }
          } finally {
            finish();
          }
        });
        if (p && p.catch) p.catch(finish);
      } catch {
        finish();
      }
    });
    stored = await getAllOps(db);
  }

  // 规范顺序重放全部历史：lamp 升序与 happens-before 一致，依赖操作必然先应用
  stored.sort(canonicalOrder);
  for (const op of stored) {
    knownIds.add(op.id || opBaseId(op));
    if (!isReady(op, live.vclock)) {
      pending.push(op);
      drainPending();
    } else {
      live.apply(op);
    }
  }
  allOps = stored.slice();

  setupChannel();
  forceEmit = true;
  emitState();
  self.postMessage({ type: 'ready', site, opCount: allOps.length });
}

// ---------- 主线程消息 ----------

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'insert') {
      if (replay.active) return;
      const op = live.createInsert(msg.after, msg.text);
      await commitLocal(op);
      const charIds = Array.from(op.text).map((_, ci) => charId(op, ci));
      self.postMessage({ type: 'local-applied', charIds });
    } else if (msg.type === 'delete') {
      if (replay.active) return;
      if (!msg.ids.length) return;
      const op = live.createDelete(msg.ids);
      await commitLocal(op);
    } else if (msg.type === 'format') {
      if (replay.active) return;
      if (!msg.ids.length) return;
      const op = live.createFormat(msg.ids, msg.on);
      if (op.kind === 'bold' || (op.marks && op.marks.length)) await commitLocal(op);
    } else if (msg.type === 'hello') {
      sendHello();
    } else if (msg.type === 'replay-enter') {
      enterReplay();
    } else if (msg.type === 'replay-exit') {
      exitReplay();
    } else if (msg.type === 'replay-play') {
      if (!replay.active) return;
      replay.speed = msg.speed || 0;
      if (!replay.playing && replay.index < replay.ops.length) {
        replay.playing = true;
        replayTick();
      }
    } else if (msg.type === 'replay-pause') {
      replay.playing = false;
      clearTimeout(replay.timer);
    } else if (msg.type === 'replay-step') {
      if (!replay.active) return;
      replay.playing = false;
      clearTimeout(replay.timer);
      rebuildReplayTo(replay.index + (msg.dir < 0 ? -1 : 1));
      emitReplay();
    } else if (msg.type === 'replay-seek') {
      if (!replay.active) return;
      replay.playing = false;
      clearTimeout(replay.timer);
      rebuildReplayTo(msg.index);
      emitReplay();
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};

bootstrap().catch((err) => {
  self.postMessage({ type: 'fatal', message: String((err && err.stack) || err) });
});
