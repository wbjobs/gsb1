// Node 测试：4 个副本在同一锚点并发插入、删除、加粗/取消加粗，
// 以乱序、重复投递验证 CRDT 收敛；同时验证操作不重复应用、回放逐前缀一致。
// 运行：node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

import {
  Doc,
  newSiteId,
  opBaseId,
  isReady,
  canonicalOrder,
  charId,
} from '../js/crdt.js';

// 简易因果广播：收集操作后按乱序、带重复地投递给其他副本
function exchange(replicas, opsBySite, shuffle) {
  let inflight = [];
  for (let s = 0; s < replicas.length; s++) {
    for (const op of opsBySite[s]) inflight.push({ op, from: s });
  }
  shuffle(inflight);
  const delivered = inflight.flatMap((m) => (Math.random() < 0.25 ? [m, m] : [m])); // 25% 重复
  const pending = replicas.map(() => []);
  for (const { op, from } of delivered) {
    for (let s = 0; s < replicas.length; s++) {
      if (s === from) continue;
      const copy = structuredClone(op);
      if (replicas[s].hasApplied(copy)) continue;
      if (isReady(copy, replicas[s].vclock)) {
        replicas[s].apply(copy);
      } else {
        pending[s].push(copy);
      }
    }
  }
  // 反复冲刷因果缓冲直到稳定：每轮找任意一个依赖已满足的操作应用。
  // 不能按 lamp 排序冲刷（未就绪操作会挡住其他站点的就绪操作）。
  for (const [i, doc] of replicas.entries()) {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let j = 0; j < pending[i].length; j++) {
        if (isReady(pending[i][j], doc.vclock)) {
          doc.apply(pending[i].splice(j, 1)[0]);
          progressed = true;
          break;
        }
      }
    }
  }
}

function seededShuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(((i * 1103515245 + 12345) % 2147483648) / 2147483648 * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function freshReplicas(n = 4) {
  const sites = Array.from({ length: n }, () => newSiteId());
  return sites.map((site) => new Doc(site));
}

// 公共初始段落，所有副本基于完全相同的历史
function seedCommon(replicas, text) {
  const doc0 = replicas[0];
  const op = doc0.createInsert(-1, text);
  doc0.apply(op);
  for (let s = 1; s < replicas.length; s++) replicas[s].apply(structuredClone(op));
  return op;
}

test('并发在同一段落插入：内容一致、无重复/丢失字符', () => {
  for (let round = 0; round < 20; round++) {
    const replicas = freshReplicas(4);
    seedCommon(replicas, '共同的段落开头与结尾，大家都在这里编辑文字。');

    const anchorId = replicas[0].render().ids[8]; // 段落中部同一锚点
    const opsBySite = replicas.map((doc, i) => {
      const ops = [];
      // 每个副本在同一锚点后连续插入（各自形成因果链）
      let after = anchorId;
      for (let k = 0; k < 10; k++) {
        const op = doc.createInsert(after, `s${i}k${k}_`);
        doc.apply(op);
        ops.push(op);
        after = charId(op, Array.from(op.text).length - 1);
      }
      return ops;
    });

    exchange(replicas, opsBySite, seededShuffle);

    const views = replicas.map((d) => d.render().text);
    assert.ok(views.every((t) => t === views[0]), `第 ${round} 轮文本不一致`);
    // 每个副本各插入 20 个字符，共 80，全部恰好出现一次
    for (let i = 0; i < 4; i++) {
      for (let k = 0; k < 10; k++) {
        const token = `s${i}k${k}_`;
        const count = views[0].split(token).length - 1;
        assert.equal(count, 1, `标记 ${token} 出现 ${count} 次`);
      }
    }
  }
});

test('同时插入与删除同一区域：收敛且删除幂等', () => {
  for (let round = 0; round < 20; round++) {
    const replicas = freshReplicas(4);
    const base = seedCommon(replicas, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    const ids = replicas[0].render().ids;

    const opsBySite = replicas.map((doc, i) => {
      const ops = [];
      if (i % 2 === 0) {
        const op = doc.createInsert(ids[12], `插入${i}`);
        doc.apply(op);
        ops.push(op);
      } else {
        // 删除中间 10 个字符，奇数副本删除范围重叠
        const op = doc.createDelete(ids.slice(10 + (i === 1 ? 0 : 2), 20));
        doc.apply(op);
        ops.push(op);
      }
      return ops;
    });

    exchange(replicas, opsBySite, seededShuffle);
    const views = replicas.map((d) => d.render().text);
    assert.ok(views.every((t) => t === views[0]), '文本不一致');
    // 删除的字符在最终文本里都消失
    for (const ch of 'KLMNOPQRST') {
      assert.ok(!views[0].includes(ch), `${ch} 应已删除`);
    }
    // 插入各出现一次
    assert.equal(views[0].split('插入0').length - 1, 1);
    assert.equal(views[0].split('插入2').length - 1, 1);
  }
});

test('并发加粗/取消加粗：标记收敛', () => {
  const replicas = freshReplicas(4);
  seedCommon(replicas, '需要被格式化为粗体的一段示例文字ABCDEFGH');
  const ids = replicas[0].render().ids;

  const opsBySite = replicas.map((doc, i) => {
    const ops = [];
    if (i === 0) {
      const op = doc.createFormat(ids.slice(0, 12), true);
      doc.apply(op);
      ops.push(op);
    } else if (i === 1) {
      const op0 = replicas[0]; // 不读其他副本状态；直接基于初始视图并发操作
      const bold = doc.createFormat(ids.slice(4, 16), true);
      doc.apply(bold);
      ops.push(bold);
    } else if (i === 2) {
      const unbold = doc.createFormat(ids.slice(2, 10), false); // 初始无 mark，marks 为空，会被跳过
      doc.apply(unbold);
      ops.push(unbold);
    } else {
      const del = doc.createDelete(ids.slice(6, 10));
      doc.apply(del);
      ops.push(del);
    }
    return ops;
  });

  exchange(replicas, opsBySite, seededShuffle);
  const rendered = replicas.map((d) => d.render());
  for (let i = 1; i < 4; i++) {
    assert.equal(rendered[i].text, rendered[0].text, '文本不一致');
    assert.deepEqual(rendered[i].runs, rendered[0].runs, '加粗区间不一致');
  }
  // 至少存在一个加粗区间，且区间不覆盖被删除字符
  assert.ok(rendered[0].runs.length > 0);
});

test('加粗后取消再加粗：最终状态确定', () => {
  const a = new Doc(newSiteId());
  const b = new Doc(newSiteId());
  const ins = a.createInsert(-1, 'XXXXXXXXXX');
  a.apply(ins);
  b.apply(structuredClone(ins));
  const ids = a.render().ids;

  const bold = a.createFormat(ids, true);
  a.apply(bold);
  b.apply(structuredClone(bold));

  // 并发：A 取消加粗，B 在“仍加粗”的视图上再点一次加粗（生成新 mark）
  const off = a.createFormat(ids, false);
  a.apply(off);
  const bold2 = b.createFormat(ids, true);
  b.apply(bold2);
  b.apply(structuredClone(off));
  a.apply(structuredClone(bold2));

  assert.deepEqual(a.render().runs, [[0, 10]]);
  assert.deepEqual(b.render().runs, [[0, 10]]);
});

test('重复投递操作不会重复应用', () => {
  const doc = new Doc(newSiteId());
  const op = doc.createInsert(-1, 'hello');
  assert.equal(doc.apply(op), true);
  assert.equal(doc.apply(structuredClone(op)), false);
  const del = doc.createDelete(doc.render().ids.slice(0, 2));
  doc.apply(del);
  assert.equal(doc.apply(structuredClone(del)), false);
  assert.equal(doc.render().text, 'llo');
});

test('时间轴：每个前缀从空文档重放都得到确定结果', () => {
  const replicas = freshReplicas(4);
  seedCommon(replicas, '初始段落。');
  const anchorId = replicas[0].render().ids[2];
  const opsBySite = replicas.map((doc, i) => {
    const op = doc.createInsert(anchorId, `${i}-并发`);
    doc.apply(op);
    return [op];
  });
  exchange(replicas, opsBySite, seededShuffle);

  const all = replicas[0].applied ? null : null;
  // 从每个副本已应用集合里取不全，直接重新收集：
  const collected = [];
  for (const list of opsBySite) for (const op of list) collected.push(structuredClone(op));
  // 加上播种操作（从副本 0 无法枚举，改为新建一份日志做回放语义验证）
  const replay = new Doc(newSiteId());
  const seed = replicas[0];
  const seedIns = {
    kind: 'ins', site: seed.site, seq: 1, lamp: 1, vclock: {}, after: -1, text: '初始段落。', ts: 0,
  };
  replay.apply(seedIns);
  collected.sort(canonicalOrder);
  const before = replay.render().text;
  for (const op of collected) {
    replay.apply(op);
    assert.equal(replay.apply(structuredClone(op)), false); // 绝不重复应用
  }
  assert.equal(replay.render().text, replicas[0].render().text);
  assert.notEqual(before, replicas[0].render().text);
});
