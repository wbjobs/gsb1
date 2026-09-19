import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCRDT,
  makeInsertOperation,
  makeRangeOperation,
  snapshot,
  nodeKey,
  visibleNodes,
  applyOperation,
} from '../src/crdt.js';
import { ReplayEngine } from '../src/replay.js';

function shuffle(values, seed = 1) {
  const result = values.slice();
  let randomState = seed;
  const random = () => {
    randomState = (randomState * 1664525 + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

test('four replicas converge under same-paragraph concurrent insert delete and bold', () => {
  const replicas = [createCRDT(), createCRDT(), createCRDT(), createCRDT()];
  const clients = ['tab-a', 'tab-b', 'tab-c', 'tab-d'];
  const allOperations = [];

  const seed = makeInsertOperation(replicas[0], clients[0], 'ROOT', '共同段落ABCDEFGHIJ', false, 1);
  for (const replica of replicas) applyOperation(replica, seed);
  allOperations.push(seed);

  const inserts = replicas.map((replica, index) => {
    const nodes = visibleNodes(replica);
    const left = nodes[Math.min(index * 2 + 1, nodes.length - 1)].id;
    const op = makeInsertOperation(replica, clients[index], nodeKey(left), `X${index}Y`, Boolean(index % 2), 10 + index);
    applyOperation(replica, op);
    return op;
  });
  inserts.forEach((op) => {
    for (const replica of replicas) applyOperation(replica, op);
  });
  allOperations.push(...inserts);

  const deletes = replicas.map((replica, index) => {
    const nodes = visibleNodes(replica);
    const target = nodes[(index + 2) % nodes.length].id;
    const op = makeRangeOperation(replica, clients[index], 'delete', [nodeKey(target)], false, 20 + index);
    applyOperation(replica, op);
    return op;
  });
  deletes.forEach((op) => {
    for (const replica of replicas) applyOperation(replica, op);
  });
  allOperations.push(...deletes);

  const marks = replicas.map((replica, index) => {
    const nodes = visibleNodes(replica);
    const targets = nodes.slice(index % 3, (index % 3) + 3).map((node) => nodeKey(node.id));
    const op = makeRangeOperation(replica, clients[index], 'bold', targets, index % 2 === 0, 30 + index);
    applyOperation(replica, op);
    return op;
  });
  marks.forEach((op) => {
    for (const replica of replicas) applyOperation(replica, op);
  });
  allOperations.push(...marks);

  const expected = snapshot(replicas[0]);
  for (let i = 1; i < replicas.length; i += 1) {
    const actual = snapshot(replicas[i]);
    assert.equal(actual.text, expected.text);
    assert.deepEqual(Array.from(actual.bold), Array.from(expected.bold));
  }

  for (let seedValue = 1; seedValue <= 8; seedValue += 1) {
    const merged = createCRDT();
    for (const op of shuffle(allOperations, seedValue)) applyOperation(merged, op);
    const mergedSnapshot = snapshot(merged);
    assert.equal(mergedSnapshot.text, expected.text);
    assert.deepEqual(Array.from(mergedSnapshot.bold), Array.from(expected.bold));
  }
});

test('causal replay reconstructs every prefix without applying an operation twice', () => {
  const replica = createCRDT();
  const operations = [];
  let left = 'ROOT';
  for (let i = 0; i < 37; i += 1) {
    const op = makeInsertOperation(replica, 'history', left, '字', false, i);
    applyOperation(replica, op);
    operations.push(op);
    left = nodeKey([op.lamport, op.seq, op.client, 0]);
  }

  const engine = new ReplayEngine();
  engine.rebuild(operations);
  const liveText = snapshot(replica).text;

  engine.seek(31);
  engine.seek(12);
  engine.seek(37);
  assert.equal(engine.getSnapshot().doc.text, liveText);
  engine.stepBackward();
  assert.equal(engine.version, 36);
  engine.stepForward();
  assert.equal(engine.getSnapshot().doc.text, liveText);

  const prefixes = new Set();
  for (let version = 0; version <= operations.length; version += 1) {
    const value = engine.seek(version);
    prefixes.add(value.doc.text);
    assert.equal(value.version, version);
  }
  assert.ok(prefixes.size >= 2);
});

test('out-of-order dependent operations are held until prerequisites arrive', () => {
  const state = createCRDT();
  const first = createCRDT();
  const rootInsert = makeInsertOperation(first, 'a', 'ROOT', 'AB', false, 1);
  applyOperation(first, rootInsert);
  const childInsert = makeInsertOperation(first, 'a', [rootInsert.lamport, rootInsert.seq, 'a', 1].join(':'), 'C', false, 2);

  assert.equal(applyOperation(state, childInsert), 'pending');
  assert.equal(applyOperation(state, rootInsert), 'applied');
  assert.equal(snapshot(state).text, 'ABC');
  assert.equal(applyOperation(state, childInsert), 'duplicate');
});

test('multi-character operation resumes through an existing deleted prefix', () => {
  const template = createCRDT();
  const op = makeInsertOperation(template, 'a', 'ROOT', 'ABCD', false, 1);
  applyOperation(template, op);
  const deleteFirstTwo = makeRangeOperation(template, 'a', 'delete', [
    [1, 1, 'a', 0].join(':'),
    [1, 1, 'a', 1].join(':'),
  ], false, 2);
  applyOperation(template, deleteFirstTwo);

  const replica = createCRDT();
  applyOperation(replica, op);
  applyOperation(replica, deleteFirstTwo);

  const lateJoined = createCRDT();
  applyOperation(lateJoined, deleteFirstTwo);
  applyOperation(lateJoined, op);

  assert.equal(snapshot(lateJoined).text, 'CD');
  assert.deepEqual(Array.from(snapshot(lateJoined).bold), Array.from(snapshot(replica).bold));
  assert.equal(lateJoined.pending.length, 0);
});
