// 集成测试：在 Node 中模拟多个“标签页”——每个标签页各自拥有独立的
// Doc、独立 IndexedDB（内存实现），通过内存版 BroadcastChannel 互联。
// 直接复用 js/worker.js 的核心协程逻辑（以函数形式驱动），验证：
//   1) 4 个标签页并发插入/删除/加粗后收敛
//   2) 操作先写 IndexedDB 再广播（读库回放能完整恢复）
//   3) 晚加入 / “断网恢复”的标签页通过 hello/sync 补齐缺失操作
//   4) 关闭标签页重开，从 IndexedDB 完整恢复日志与文档

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import { Doc, newSiteId, opBaseId, isReady, canonicalOrder } from '../js/crdt.js';

// ---------- 内存版 IndexedDB（ops/meta 两个表） ----------
class MemIDB {
  constructor() {
    this.ops = new Map();
    this.meta = new Map();
  }
  putOp(op) { this.ops.set(op.id, op); }
  putOpsBulk(ops) { for (const op of ops) this.ops.set(op.id, op); }
  getAllOps() { return [...this.ops.values()]; }
  countOps() { return this.ops.size; }
  getMeta(k) { return this.meta.get(k); }
  setMeta(k, v) { this.meta.set(k, v); }
}

// ---------- 内存版 BroadcastChannel ----------
const bus = [];
class MemChannel {
  constructor(name, tab) {
    this.name = name;
    this.tab = tab;
    this.onmessage = null;
    this.online = true;
    bus.push(this);
  }
  postMessage(msg) {
    if (!this.online) return;
    for (const ch of bus) {
      if (ch === this || ch.name !== this.name || !ch.online) continue;
      queueMicrotask(() => ch.onmessage && ch.onmessage({ data: structuredClone(msg) }));
    }
  }
  close() {
    const i = bus.indexOf(this);
    if (i >= 0) bus.splice(i, 1);
  }
}

// ---------- 模拟一个标签页（与 worker.js 的逻辑一一对应） ----------
class Tab {
  constructor(idb, { seed = false } = {}) {
    this.idb = idb;
    this.site = idb.getMeta('site') || (() => {
      const s = newSiteId();
      idb.setMeta('site', s);
      return s;
    })();
    this.doc = new Doc(this.site);
    this.allOps = [];
    this.pending = [];
    this.known = new Set();
    this.channel = new MemChannel('crdt-doc-v1', this);
    this.channel.onmessage = (ev) => this.onWire(ev.data);
    this._restore();
    if (seed && this.allOps.length === 0) {
      const seeded = new Doc(this.site);
      const { buildSeedOps } = await_unavailable();
      const ops = buildSeedOps(seeded);
      this.idb.putOpsBulk(ops.map((op) => ({ ...op, id: opBaseId(op) })));
      this._restore();
    }
  }

  _restore() {
    const stored = this.idb.getAllOps();
    stored.sort(canonicalOrder);
    this.doc = new Doc(this.site);
    this.allOps = [];
    this.pending = [];
    this.known = new Set();
    for (const op of stored) {
      this.known.add(op.id || opBaseId(op));
      if (isReady(op, this.doc.vclock)) this.doc.apply(op);
      else { this.pending.push(op); this._drain(); }
      this.allOps.push(op);
    }
    this.allOps.sort(canonicalOrder);
  }

  _drain() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < this.pending.length; i++) {
        if (isReady(this.pending[i], this.doc.vclock)) {
          const [op] = this.pending.splice(i, 1);
          this.doc.apply(op);
          this._insert(op);
          progressed = true;
          break;
        }
      }
    }
  }

  _insert(op) {
    let lo = 0; let hi = this.allOps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (canonicalOrder(this.allOps[mid], op) < 0) lo = mid + 1;
      else hi = mid;
    }
    this.allOps.splice(lo, 0, op);
  }

  async settle() {
    await new Promise((r) => setTimeout(r, 10));
  }

  // 本地编辑：先写 IndexedDB，再广播
  localInsert(after, text) {
    const op = this.doc.createInsert(after, text);
    this.idb.putOp({ ...op, id: opBaseId(op) });
    this.known.add(opBaseId(op));
    this.doc.apply(op);
    this._insert(op);
    this.channel.postMessage({ t: 'op', site: this.site, op });
    return op;
  }
  localDelete(ids) {
    const op = this.doc.createDelete(ids);
    this.idb.putOp({ ...op, id: opBaseId(op) });
    this.known.add(opBaseId(op));
    this.doc.apply(op);
    this._insert(op);
    this.channel.postMessage({ t: 'op', site: this.site, op });
  }
  localFormat(ids, on) {
    const op = this.doc.createFormat(ids, on);
    if (op.kind !== 'bold' && !(op.marks && op.marks.length)) return;
    this.idb.putOp({ ...op, id: opBaseId(op) });
    this.known.add(opBaseId(op));
    this.doc.apply(op);
    this._insert(op);
    this.channel.postMessage({ t: 'op', site: this.site, op });
  }

  onWire(msg) {
    if (!msg || msg.site === this.site) return;
    if (msg.t === 'op') this._receive([msg.op]);
    else if (msg.t === 'hello') this._sendMissing(msg.vclock || {});
    else if (msg.t === 'sync') this._receive(msg.ops || []);
  }

  _receive(ops) {
    const fresh = [];
    for (const op of ops) {
      const id = opBaseId(op);
      if (this.known.has(id) || this.doc.hasApplied(op)) continue;
      this.known.add(id);
      fresh.push({ ...op, id });
    }
    if (!fresh.length) return;
    this.idb.putOpsBulk(fresh); // 远程操作也先落库
    for (const op of fresh) {
      if (isReady(op, this.doc.vclock)) {
        this.doc.apply(op);
        this._insert(op);
      } else {
        this.pending.push(op);
      }
    }
    this._drain();
  }

  hello() {
    this.channel.postMessage({ t: 'hello', site: this.site, vclock: this.doc.vclock });
  }
  _sendMissing(peerVclock) {
    const missing = this.allOps.filter((op) => (peerVclock[op.site] || 0) < op.seq);
    if (missing.length) this.channel.postMessage({ t: 'sync', site: this.site, ops: missing });
  }

  text() { return this.doc.render().text; }
}

// 让 buildSeedOps 保持普通 import（避免 top-level await 复杂化）
import { buildSeedOps } from '../js/seed.js';
function await_unavailable() {
  return { buildSeedOps };
}

test('4 标签页并发编辑 5 分钟场景的压缩模拟：最终内容一致', async () => {
  const idb = new MemIDB();
  const host = new Tab(idb, { seed: true });
  const seedText = host.text();
  assert.ok(Array.from(seedText).length >= 10000, '播种文档需超过 1 万字');

  const tabs = [host, new Tab(new MemIDB()), new Tab(new MemIDB()), new Tab(new MemIDB())];
  tabs.forEach((t) => t.hello());
  await host.settle();

  const before = tabs.map((t) => t.text());
  assert.ok(before.every((x) => x === before[0]), '晚加入标签页应通过 sync 追平');

  // 并发编辑：所有标签页使用同一个字符 id 作为锚点（真实 UI 传递的就是 id，
  // 不是下标）。锚点选在文档中部一个不会被后续删除范围覆盖的位置。
  const anchor = host.doc.render().ids[500];
  for (let round = 0; round < 40; round++) {
    tabs.forEach((tab, i) => {
      // 锚点固定不变；即使锚点后来被删除，新字符也会作为墓碑子树被提升显示
      tab.localInsert(anchor, `[t${i}r${round}]`);
      const ids = tab.doc.render().ids;
      if (ids.length > 900 && round % 3 === i % 3) {
        tab.localDelete(ids.slice(100, 104)); // 删除范围远离中部锚点
      }
      if (round % 4 === i) {
        tab.localFormat(ids.slice(20, 40), true);
      }
    });
    await host.settle();
  }
  await host.settle();

  const finals = tabs.map((t) => ({
    text: t.text(),
    runs: t.doc.render().runs,
    ops: t.idb.countOps(),
  }));
  assert.ok(finals.every((f) => f.text === finals[0].text), '文本不一致');
  assert.ok(finals.every((f) => JSON.stringify(f.runs) === JSON.stringify(finals[0].runs)), '加粗不一致');
  assert.ok(finals.every((f) => f.ops === finals[0].ops), '操作日志条数不一致');

  // 无重复字符：每个插入标记恰好出现一次
  for (let i = 0; i < 4; i++) {
    for (let r = 0; r < 40; r++) {
      const token = `[t${i}r${r}]`;
      assert.equal(finals[0].text.split(token).length - 1, 1, `${token} 重复/丢失`);
    }
  }
});

test('断网再恢复：离线期间的编辑在恢复 hello 后双向补齐', async () => {
  const a = new Tab(new MemIDB(), { seed: false });
  const b = new Tab(new MemIDB());
  a.hello();
  await a.settle();

  const ids = a.doc.render().ids;
  a.localInsert(ids[10], '离线前A');
  await a.settle();

  // 双方断线
  a.channel.online = false;
  b.channel.online = false;
  a.localInsert(ids[20], 'A离线编辑');
  b.localInsert(b.doc.render().ids[30], 'B离线编辑');
  await a.settle();
  assert.ok(!a.text().includes('B离线编辑'));
  assert.ok(!b.text().includes('A离线编辑'));

  // 恢复
  a.channel.online = true;
  b.channel.online = true;
  a.hello();
  b.hello();
  await a.settle();
  await a.settle();

  assert.ok(a.text().includes('A离线编辑') && a.text().includes('B离线编辑'));
  assert.equal(a.text(), b.text());
});

test('关闭标签页重开：IndexedDB 完整恢复文档与操作日志', async () => {
  const idb = new MemIDB();
  const tab = new Tab(idb, { seed: true });
  const ids = tab.doc.render().ids;
  tab.localInsert(ids[100], '待恢复的文字');
  tab.localDelete(ids.slice(200, 205));
  tab.localFormat(ids.slice(300, 320), true);
  const expectedText = tab.text();
  const expectedRuns = JSON.stringify(tab.doc.render().runs);
  const expectedCount = idb.countOps();

  // 用同一个“磁盘”（MemIDB）新建标签页，模拟刷新/重开
  const reopened = new Tab(idb);
  assert.equal(reopened.text(), expectedText);
  assert.equal(JSON.stringify(reopened.doc.render().runs), expectedRuns);
  assert.equal(reopened.idb.countOps(), expectedCount);

  // 日志按规范序重放，每个操作只应用一次
  const fresh = new Doc(reopened.site);
  const ops = idb.getAllOps().sort(canonicalOrder);
  for (const op of ops) fresh.apply(op);
  assert.equal(fresh.render().text, expectedText);
});
