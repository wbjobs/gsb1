const ROOT_ID = 'ROOT';

export function nodeKey(id) {
  if (typeof id === 'string') return id;
  return id === ROOT_ID ? ROOT_ID : id.join(':');
}

export function parseNodeId(value) {
  if (!value || value === ROOT_ID) return ROOT_ID;
  if (Array.isArray(value)) return value;
  const parts = value.split(':');
  return [Number(parts[0]), Number(parts[1]), parts[2], Number(parts[3] || 0)];
}

function nodeLookupKey(value) {
  if (typeof value === 'string' || Array.isArray(value)) return nodeKey(value);
  return ROOT_ID;
}

function compareIds(left, right) {
  if (left === ROOT_ID || right === ROOT_ID) return 0;
  if (left[0] !== right[0]) return right[0] - left[0];
  if (left[2] !== right[2]) return left[2] < right[2] ? 1 : -1;
  if (left[1] !== right[1]) return right[1] - left[1];
  return (right[3] || 0) - (left[3] || 0);
}

function binaryInsertChild(children, node) {
  let low = 0;
  let high = children.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (compareIds(node.id, children[middle].id) < 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  children.splice(low, 0, node);
}

function clockBefore(left, right) {
  let leftHasStrict = false;
  let rightHasStrict = false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const client of keys) {
    const lv = left[client] || 0;
    const rv = right[client] || 0;
    if (lv < rv) leftHasStrict = true;
    if (lv > rv) rightHasStrict = true;
  }
  if (leftHasStrict && !rightHasStrict) return -1;
  if (rightHasStrict && !leftHasStrict) return 1;
  return 0;
}

export function causalOrder(left, right) {
  const byClock = clockBefore(left.vclock, right.vclock);
  if (byClock !== 0) return byClock;
  if (left.lamport !== right.lamport) return left.lamport - right.lamport;
  if (left.client !== right.client) return left.client < right.client ? -1 : 1;
  return left.seq - right.seq;
}

export function createCRDT() {
  const root = {
    id: ROOT_ID,
    parentId: null,
    ch: null,
    lamport: -1,
    deleted: false,
    bold: false,
  };

  return {
    nodes: new Map([[ROOT_ID, root]]),
    children: new Map([[ROOT_ID, []]]),
    vclock: {},
    lamport: 0,
    applied: new Set(),
    pending: [],
  };
}

export function nextOperationMetadata(state, client) {
  const seq = (state.vclock[client] || 0) + 1;
  const lamport = state.lamport + 1;
  const vclock = { ...state.vclock, [client]: seq };
  return { client, seq, lamport, vclock };
}

export function makeInsertOperation(state, client, leftId, text, bold = false, ts = Date.now()) {
  const meta = nextOperationMetadata(state, client);
  const chars = Array.from(text.replace(/\r\n?/g, '\n'));
  return {
    ...meta,
    kind: 'insert',
    opId: `${client}:${meta.seq}`,
    parentId: leftId || ROOT_ID,
    text: chars.join(''),
    bold: Boolean(bold),
    ts,
  };
}

export function makeRangeOperation(state, client, kind, ids, bold = false, ts = Date.now()) {
  const meta = nextOperationMetadata(state, client);
  return {
    ...meta,
    kind,
    opId: `${client}:${meta.seq}`,
    targets: [...ids],
    bold: kind === 'bold' ? Boolean(bold) : false,
    ts,
  };
}

export function visibleNodes(state) {
  const result = [];
  const stack = [...(state.children.get(ROOT_ID) || [])].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (!node.deleted) result.push(node);
    const kids = state.children.get(nodeKey(node.id));
    if (kids?.length) {
      for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
    }
  }
  return result;
}

export function snapshot(state) {
  const nodes = visibleNodes(state);
  const text = nodes.map((node) => node.ch).join('');
  const bold = new Uint8Array(nodes.length);
  const lamports = new Uint32Array(nodes.length);
  const seqs = new Uint32Array(nodes.length);
  const parts = new Uint32Array(nodes.length);
  const clients = [];
  const clientIndex = new Map();
  const clientCodes = new Uint32Array(nodes.length);

  nodes.forEach((node, index) => {
    bold[index] = node.boldValue ? 1 : 0;
    lamports[index] = node.id[0];
    seqs[index] = node.id[1];
    parts[index] = node.id[3] || 0;
    let code = clientIndex.get(node.id[2]);
    if (code === undefined) {
      code = clients.length;
      clientIndex.set(node.id[2], code);
      clients.push(node.id[2]);
    }
    clientCodes[index] = code;
  });

  return { text, bold, lamports, seqs, parts, clients, clientCodes };
}

export function cloneState(state) {
  return {
    nodes: new Map(Array.from(state.nodes, ([key, node]) => [key, { ...node }])),
    children: new Map(Array.from(state.children, ([key, kids]) => [key, kids.slice()])),
    vclock: { ...state.vclock },
    lamport: state.lamport,
    applied: new Set(state.applied || []),
    pending: [],
  };
}

export function restoreState(target, saved) {
  target.nodes = saved.nodes;
  target.children = saved.children;
  target.vclock = saved.vclock;
  target.lamport = saved.lamport;
  target.applied = saved.applied || new Set();
  target.pending = [];
}

function applyInsert(state, op) {
  const chars = Array.from(op.text);
  const ids = [];
  for (let i = 0; i < chars.length; i += 1) {
    ids.push([op.lamport, op.seq, op.client, i]);
  }

  let parentId = parseNodeId(op.parentId);
  for (let i = 0; i < chars.length; i += 1) {
    const id = ids[i];
    const key = nodeKey(id);
    if (state.nodes.has(key)) {
      parentId = id;
      continue;
    }
    if (i === 0 && !state.nodes.has(nodeLookupKey(parentId))) return false;
    const ch = chars[i];
    const node = {
      id,
      parentId,
      ch,
      lamport: op.lamport,
      deleted: false,
      boldValue: op.bold && ch !== '\n',
      boldLamport: op.lamport,
      boldClient: op.client,
      boldSeq: op.seq,
    };
    state.nodes.set(key, node);
    const kids = state.children.get(nodeLookupKey(parentId)) || [];
    binaryInsertChild(kids, node);
    state.children.set(nodeLookupKey(parentId), kids);
    state.children.set(key, []);
    parentId = id;
  }
  return true;
}

function applyMark(state, op) {
  for (const target of op.targets) {
    const node = state.nodes.get(nodeLookupKey(target));
    if (!node) return false;
    if (op.kind === 'delete') {
      node.deleted = true;
    } else if (node.ch !== '\n') {
      const newer = op.lamport > (node.boldLamport ?? -1)
        || (op.lamport === (node.boldLamport ?? -1) && op.client > (node.boldClient || ''));
      if (newer) {
        node.boldValue = Boolean(op.bold);
        node.boldLamport = op.lamport;
        node.boldClient = op.client;
        node.boldSeq = op.seq;
      }
    }
  }
  return true;
}

export function canApply(state, op) {
  const opKey = `${op.client}:${op.seq}`;
  if (state.applied?.has(opKey)) return 'duplicate';
  if (op.kind === 'insert') {
    let parentId = parseNodeId(op.parentId);
    const chars = Array.from(op.text);
    for (let i = 0; i < chars.length; i += 1) {
      const id = [op.lamport, op.seq, op.client, i];
      if (state.nodes.has(nodeKey(id))) {
        parentId = id;
        continue;
      }
      if (i > 0) {
        parentId = id;
        continue;
      }
      if (!state.nodes.has(nodeLookupKey(parentId))) return 'pending';
      parentId = id;
    }
    return 'ready';
  }
  for (const target of op.targets || []) {
    if (!state.nodes.has(nodeLookupKey(target))) return 'pending';
  }
  return 'ready';
}

export function applyOperation(state, op, pending = state.pending || []) {
  const opKey = op.opId || `${op.client}:${op.seq}`;
  if (!state.applied) state.applied = new Set();
  if (!state.pending) state.pending = [];
  if (state.applied.has(opKey)) return 'duplicate';

  const readiness = canApply(state, op);
  if (readiness === 'duplicate') return 'duplicate';
  if (readiness === 'pending') {
    if (!pending.some((item) => (item.opId || `${item.client}:${item.seq}`) === opKey)) {
      pending.push(op);
    }
    return 'pending';
  }

  const succeeded = op.kind === 'insert' ? applyInsert(state, op) : applyMark(state, op);
  if (!succeeded) {
    if (!pending.some((item) => (item.opId || `${item.client}:${item.seq}`) === opKey)) {
      pending.push(op);
    }
    return 'pending';
  }

  state.applied.add(opKey);
  state.vclock[op.client] = Math.max(state.vclock[op.client] || 0, op.seq);
  state.lamport = Math.max(state.lamport, op.lamport);

  let progressed = true;
  while (progressed && pending.length) {
    let madeProgress = false;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const candidate = pending[i];
      if (canApply(state, candidate) === 'ready') {
        const candidateKey = candidate.opId || `${candidate.client}:${candidate.seq}`;
        const ok = candidate.kind === 'insert' ? applyInsert(state, candidate) : applyMark(state, candidate);
        if (ok) {
          state.applied.add(candidateKey);
          state.vclock[candidate.client] = Math.max(state.vclock[candidate.client] || 0, candidate.seq);
          state.lamport = Math.max(state.lamport, candidate.lamport);
          pending.splice(i, 1);
          madeProgress = true;
        }
      }
    }
    progressed = madeProgress;
  }

  return 'applied';
}

export function idAt(snapshotValue, index) {
  if (index < 0 || index >= snapshotValue.text.length) return null;
  return [
    snapshotValue.lamports[index],
    snapshotValue.seqs[index],
    snapshotValue.clients[snapshotValue.clientCodes[index]],
    snapshotValue.parts[index],
  ];
}
