// 简化版 CRDT：RGA（Replicated Growable Array）变体
// - 每个字符是一个节点，id = lamport.site.seq.batchIndex（定长编码，可直接比较）
// - 插入锚定在 afterId 之后；同一锚点的并发插入按 (lamp, site, seq) 决胜
// - 删除/加粗/取消加粗只打标记（tombstone / mark），天然幂等、可交换
// - 每个操作携带因果向量时钟 vclock，未满足因果依赖的操作先缓冲
//
// 同一份文件既被 Web Worker（type: module）加载，也被 Node 测试加载。

export const ROOT = '';

export function pad(num, width) {
  return String(num).padStart(width, '0');
}

export function newSiteId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// 字符 id：基础三元组 + 批次内下标
export function charId(op, ci) {
  return `${pad(op.lamp, 12)}.${op.site}.${pad(op.seq, 8)}.${pad(ci, 5)}`;
}

export function baseOf(charIdStr) {
  const parts = charIdStr.split('.');
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

// RGA 扫描顺序：基础 id 越大越靠前（lamp -> site -> seq 字典序），
// 同一操作批次内按 ci 升序（保证一批字符还原为输入顺序）。
// 返回 -1 表示 a 排在 b 前面。
export function compareRGA(aMeta, bMeta) {
  if (aMeta.lamp !== bMeta.lamp) return aMeta.lamp > bMeta.lamp ? -1 : 1;
  if (aMeta.site !== bMeta.site) return aMeta.site > bMeta.site ? -1 : 1;
  if (aMeta.seq !== bMeta.seq) return aMeta.seq > bMeta.seq ? -1 : 1;
  return aMeta.ci - bMeta.ci;
}

export function parseId(id) {
  const p = id.split('.');
  return { lamp: Number(p[0]), site: p[1], seq: Number(p[2]), ci: Number(p[3]) };
}

// 操作的全局唯一基础 id（删除/加粗操作也用它去重）
export function opBaseId(op) {
  return `${pad(op.lamp, 12)}.${op.site}.${pad(op.seq, 8)}`;
}

// 规范化因果序（时间轴 / 重建时使用）：lamp 升序，再 site、seq
export function canonicalOrder(a, b) {
  if (a.lamp !== b.lamp) return a.lamp - b.lamp;
  if (a.site !== b.site) return a.site < b.site ? -1 : 1;
  return a.seq - b.seq;
}

// 因果依赖是否已满足
export function isReady(op, vclock) {
  for (const [site, seq] of Object.entries(op.vclock || {})) {
    if ((vclock[site] || 0) < seq) return false;
  }
  return true;
}

export class Doc {
  constructor(site) {
    this.site = site;
    this.lamp = 0;
    this.seq = 0;
    this.vclock = {};
    this.kids = new Map();   // key(ROOT 或 charId) -> 子 id 数组（RGA 扫描序）
    this.kids.set(ROOT, []);
    this.ch = new Map();     // charId -> 字符
    this.meta = new Map();   // charId -> {lamp,site,seq,ci}
    this.removed = new Set();
    this.marks = new Map();  // charId -> Set(markId)，加粗标记
    this.marksOff = new Set(); // 被取消的 markId
    this.applied = new Set(); // 已应用操作的 baseId（去重，保证操作不会重复应用）
  }

  hasApplied(op) {
    return this.applied.has(opBaseId(op));
  }

  _nextOpBase() {
    this.seq += 1;
    this.lamp += 1;
    return { seq: this.seq, lamp: this.lamp };
  }

  // 操作携带的是“依赖向量”：自己依赖本站点此前已发出的 seq 个操作，
  // 其他站点依赖 vclock 中记录的序号。注意不能写入即将分配的新序号，
  // 否则接收方在应用该操作前永远满足不了依赖。
  _makeVClock() {
    return { ...this.vclock };
  }

  // 在 afterId（-1 表示文档开头）之后插入 text
  createInsert(afterId, text, now = Date.now()) {
    const { seq, lamp } = this._nextOpBase();
    const op = {
      kind: 'ins',
      site: this.site,
      seq,
      lamp,
      vclock: this._makeVClock(),
      after: afterId === -1 || afterId == null ? -1 : afterId,
      text,
      ts: now,
    };
    return op;
  }

  // 删除一组字符
  createDelete(ids, now = Date.now()) {
    const { seq, lamp } = this._nextOpBase();
    return {
      kind: 'del',
      site: this.site,
      seq,
      lamp,
      vclock: this._makeVClock(),
      targets: ids.slice(),
      ts: now,
    };
  }

  // on=true 加粗（生成一个新 mark）；on=false 取消这些字符上当前生效的所有 mark
  createFormat(ids, on, now = Date.now()) {
    const { seq, lamp } = this._nextOpBase();
    const op = {
      kind: on ? 'bold' : 'unbold',
      site: this.site,
      seq,
      lamp,
      vclock: this._makeVClock(),
      targets: ids.slice(),
      ts: now,
    };
    if (on) {
      op.mark = `${pad(lamp, 12)}.${this.site}.${pad(seq, 8)}.m`;
    } else {
      const union = new Set();
      for (const id of ids) {
        const ms = this.marks.get(id);
        if (ms) for (const m of ms) if (!this.marksOff.has(m)) union.add(m);
      }
      op.marks = [...union];
    }
    return op;
  }

  // 应用一个因果依赖已满足、且未应用过的操作
  apply(op) {
    const base = opBaseId(op);
    if (this.applied.has(base)) return false;
    if (op.kind === 'ins') this._applyInsert(op);
    else if (op.kind === 'del') this._applyDelete(op);
    else if (op.kind === 'bold') this._applyBold(op);
    else if (op.kind === 'unbold') this._applyUnbold(op);
    else throw new Error('unknown op kind: ' + op.kind);

    this.applied.add(base);
    this.vclock[op.site] = Math.max(this.vclock[op.site] || 0, op.seq);
    if (op.lamp > this.lamp) this.lamp = op.lamp;
    return true;
  }

  _insertOne(anchor, id, ch) {
    const m = parseId(id);
    this.ch.set(id, ch);
    this.meta.set(id, m);
    const key = anchor === -1 ? ROOT : anchor;
    let list = this.kids.get(key);
    if (!list) {
      list = [];
      this.kids.set(key, list);
    }
    // RGA：插到第一个“比新 id 小”的节点前面；末尾追加是 O(1)
    if (list.length === 0) {
      list.push(id);
    } else {
      const lastMeta = this.meta.get(list[list.length - 1]);
      if (compareRGA(lastMeta, m) < 0) {
        list.push(id);
      } else {
        let pos = list.length;
        for (let i = 0; i < list.length; i++) {
          if (compareRGA(this.meta.get(list[i]), m) > 0) {
            pos = i;
            break;
          }
        }
        list.splice(pos, 0, id);
      }
    }
  }

  _applyInsert(op) {
    const chars = Array.from(op.text);
    let anchor = op.after;
    for (let ci = 0; ci < chars.length; ci++) {
      const id = charId(op, ci);
      if (this.meta.has(id)) {
        // 同批次重复投递：跳过但保持锚点推进
        anchor = id;
        continue;
      }
      this._insertOne(anchor, id, chars[ci]);
      anchor = id;
    }
  }

  _applyDelete(op) {
    for (const id of op.targets) this.removed.add(id);
  }

  _applyBold(op) {
    for (const id of op.targets) {
      let set = this.marks.get(id);
      if (!set) {
        set = new Set();
        this.marks.set(id, set);
      }
      set.add(op.mark);
    }
  }

  _applyUnbold(op) {
    for (const m of op.marks || []) this.marksOff.add(m);
  }

  isBold(id) {
    const set = this.marks.get(id);
    if (!set) return false;
    for (const m of set) if (!this.marksOff.has(m)) return true;
    return false;
  }

  // 深度优先遍历未删除字符，输出纯文本、可见 id 序列、加粗区间。
  // 墓碑节点本身不输出，但它的子树仍然可能存活（插入锚点后来被删除的情况），
  // 因此用“跳过节点”而不是“跳过子树”处理，存活子字符会被提升显示，绝不丢失。
  render() {
    const textParts = [];
    const ids = [];
    const runs = []; // [start, end) bold
    const stack = [{ key: ROOT, i: 0 }];
    let runStart = -1;
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const list = this.kids.get(frame.key);
      if (!list || frame.i >= list.length) {
        stack.pop();
        continue;
      }
      const id = list[frame.i++];
      if (!this.removed.has(id)) {
        const idx = ids.length;
        ids.push(id);
        textParts.push(this.ch.get(id));
        const bold = this.isBold(id);
        if (bold) {
          if (runStart === -1) runStart = idx;
        } else if (runStart !== -1) {
          runs.push([runStart, idx]);
          runStart = -1;
        }
      }
      // 无论是否墓碑都继续深入其子树，保证锚定在墓碑后的存活字符可见
      stack.push({ key: id, i: 0 });
    }
    if (runStart !== -1) runs.push([runStart, ids.length]);
    return { text: textParts.join(''), ids, runs };
  }

  // ---- 快照（时间轴回放索引使用，保证回放绝不重复应用同一个操作）----
  toJSON() {
    return {
      site: this.site,
      lamp: this.lamp,
      seq: this.seq,
      vclock: { ...this.vclock },
      kids: [...this.kids].map(([k, v]) => [k, v.slice()]),
      ch: [...this.ch],
      meta: [...this.meta].map(([id, m]) => [id, m.lamp, m.site, m.seq, m.ci]),
      removed: [...this.removed],
      marks: [...this.marks].map(([id, s]) => [id, [...s]]),
      marksOff: [...this.marksOff],
      applied: [...this.applied],
    };
  }

  static fromJSON(data) {
    const d = new Doc(data.site);
    d.lamp = data.lamp;
    d.seq = data.seq;
    d.vclock = { ...data.vclock };
    d.kids = new Map(data.kids.map(([k, v]) => [k, v.slice()]));
    d.ch = new Map(data.ch);
    d.meta = new Map(
      data.meta.map(([id, lamp, site, seq, ci]) => [id, { lamp, site, seq, ci }])
    );
    d.removed = new Set(data.removed);
    d.marks = new Map(data.marks.map(([id, s]) => [id, new Set(s)]));
    d.marksOff = new Set(data.marksOff);
    d.applied = new Set(data.applied);
    return d;
  }
}
