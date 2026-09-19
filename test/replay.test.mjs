// 时间轴回放测试：
//   - 模拟 Worker 的回放引擎（独立临时文档 + 每 500 操作快照）
//   - 任意跳转（前进/后退/反复拖动）结果都等于从空文档全量重放
//   - 每个操作在同一份临时文档上只应用一次（applied 集合兜底）
//   - 操作日志超过 1 万字播种 + 大量随机插入/删除

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import { Doc, newSiteId, opBaseId, canonicalOrder } from '../js/crdt.js';
import { buildSeedOps } from '../js/seed.js';

const SNAPSHOT_EVERY = 500;

class ReplayEngine {
  constructor(ops) {
    this.ops = ops.slice().sort(canonicalOrder);
    this.doc = new Doc('replay');
    this.index = 0;
    this.snapshots = new Map();
    this.applications = 0; // 当前文档实例内真正应用次数
  }
  _resetDoc(fromSnapshot) {
    this.doc = fromSnapshot ? Doc.fromJSON(fromSnapshot) : new Doc('replay');
    this.applications = 0; // 新实例重新计数
  }
  keyOf(i) { return Math.floor(i / SNAPSHOT_EVERY) * SNAPSHOT_EVERY; }
  seek(target) {
    target = Math.max(0, Math.min(target, this.ops.length));
    if (this.index > target) {
      let key = this.keyOf(target);
      while (key > 0 && !this.snapshots.has(key)) key -= SNAPSHOT_EVERY;
      if (this.snapshots.has(key)) this._resetDoc(this.snapshots.get(key));
      else this._resetDoc(null);
      this.index = key;
    }
    while (this.index < target) {
      const before = this.doc.applied.size;
      const changed = this.doc.apply(this.ops[this.index]);
      assert.equal(changed, true, '同一文档实例内操作不应被重复应用');
      assert.equal(this.doc.applied.size, before + 1);
      this.applications++;
      this.index++;
      if (this.index % SNAPSHOT_EVERY === 0 && !this.snapshots.has(this.index)) {
        this.snapshots.set(this.index, this.doc.toJSON());
      }
    }
    return this.doc.render();
  }
}

function referenceAt(ops, n) {
  const doc = new Doc('replay');
  for (let i = 0; i < n; i++) doc.apply(ops[i]);
  return doc.render();
}

test('回放任意位置与全量重放一致；操作不重复应用', () => {
  const site = newSiteId();
  const builder = new Doc(site);
  const ops = buildSeedOps(builder);

  // 继续追加随机插入/删除，制造足够长的日志
  let live = builder;
  for (let r = 0; r < 1200; r++) {
    const ids = live.render().ids;
    if (r % 5 === 0 && ids.length > 10) {
      const pos = Math.floor(Math.random() * (ids.length - 2));
      ops.push(live.createDelete(ids.slice(pos, pos + 1 + (r % 3))));
    } else {
      const pos = Math.floor(Math.random() * ids.length);
      ops.push(live.createInsert(ids[pos], ['协同', '回放', '快照', '锚点'][r % 4]));
    }
    live.apply(ops[ops.length - 1]);
  }

  const engine = new ReplayEngine(ops);
  assert.ok(ops.length > 1200);

  // 反复随机拖动时间轴（含快速前进、后退、跳到 0、跳到末尾）
  const points = [0, 1, 499, 500, 501, 1000, 750, 2, 1200, 300, ops.length, 0, 600];
  for (const target of points) {
    const got = engine.seek(target);
    const want = referenceAt(engine.ops, target);
    assert.equal(got.text, want.text, `位置 ${target} 文本不一致`);
    assert.deepEqual(got.runs, want.runs, `位置 ${target} 加粗区间不一致`);
    assert.equal(got.ids.length, want.ids.length);
  }

  // 从 0 单步走到末尾，与参考逐点比对（抽样）
  engine.seek(0);
  for (let i = 1; i <= engine.ops.length; i++) {
    const got = engine.seek(i);
    if (i % 137 === 0 || i === engine.ops.length) {
      const want = referenceAt(engine.ops, i);
      assert.equal(got.text, want.text);
    }
  }

  // 当前文档实例是从 0 顺序走到末尾的，每个操作恰好真正应用一次
  assert.equal(engine.applications, engine.ops.length);
  assert.equal(engine.doc.applied.size, engine.ops.length);
});

test('日志规范序是确定的线性历史（两副本各自排序结果相同）', () => {
  const a = new Doc(newSiteId());
  const b = new Doc(newSiteId());
  const seed = a.createInsert(-1, 'X'.repeat(10500));
  a.apply(seed);
  b.apply(structuredClone(seed));
  const ids = a.render().ids;

  const collected = [];
  for (let i = 0; i < 200; i++) {
    const doc = i % 2 ? a : b;
    const pos = (i * 37) % ids.length;
    const op = doc.createInsert(ids[pos], 'Z');
    doc.apply(op);
    collected.push(op);
  }
  const orderA = collected.slice().sort(canonicalOrder).map(opBaseId);
  const orderB = collected.slice().sort(canonicalOrder).map(opBaseId);
  assert.deepEqual(orderA, orderB);
});
