import {
  applyOperation,
  causalOrder,
  cloneState,
  createCRDT,
  restoreState,
  snapshot,
} from './crdt.js';

const CHECKPOINT_EVERY = 250;

export class ReplayEngine {
  constructor() {
    this.operations = [];
    this.signature = [];
    this.baseState = createCRDT();
    this.viewState = createCRDT();
    this.checkpoints = new Map([[0, cloneState(this.baseState)]]);
    this.version = 0;
  }

  static opSignature(op) {
    return `${op.client}:${op.seq}`;
  }

  rebuild(operations) {
    const sorted = [...operations].sort(causalOrder);
    this.operations = sorted;
    this.signature = sorted.map(ReplayEngine.opSignature);
    this.baseState = createCRDT();
    this.checkpoints = new Map([[0, cloneState(this.baseState)]]);
    const pending = [];
    for (let i = 0; i < sorted.length; i += 1) {
      applyOperation(this.baseState, sorted[i], pending);
      if ((i + 1) % CHECKPOINT_EVERY === 0 || i === sorted.length - 1) {
        this.checkpoints.set(i + 1, cloneState(this.baseState));
      }
    }
    this.seek(Math.min(this.version, sorted.length));
  }

  update(operations) {
    const previous = this.signature;
    const sorted = [...operations].sort(causalOrder);
    const nextSignature = sorted.map(ReplayEngine.opSignature);
    const samePrefix = previous.every((id, index) => id === nextSignature[index]);
    if (!samePrefix) {
      this.rebuild(operations);
      return;
    }

    const pending = [];
    let state = this.baseState;
    for (let i = previous.length; i < sorted.length; i += 1) {
      applyOperation(state, sorted[i], pending);
      if ((i + 1) % CHECKPOINT_EVERY === 0 || i === sorted.length - 1) {
        this.checkpoints.set(i + 1, cloneState(state));
      }
    }
    this.baseState = state;
    this.operations = sorted;
    this.signature = nextSignature;
    this.seek(Math.min(Math.max(this.version, 0), sorted.length));
  }

  seek(version) {
    const target = Math.max(0, Math.min(version, this.operations.length));
    let checkpoint = 0;
    for (const candidate of this.checkpoints.keys()) {
      if (candidate <= target && candidate > checkpoint) checkpoint = candidate;
    }
    restoreState(this.viewState, cloneState(this.checkpoints.get(checkpoint)));
    const pending = [];
    for (let i = checkpoint; i < target; i += 1) {
      applyOperation(this.viewState, this.operations[i], pending);
    }
    this.version = target;
    return this.getSnapshot();
  }

  stepForward() {
    if (this.version >= this.operations.length) return this.getSnapshot();
    return this.seek(this.version + 1);
  }

  stepBackward() {
    if (this.version === 0) return this.getSnapshot();
    return this.seek(this.version - 1);
  }

  getSnapshot() {
    return {
      version: this.version,
      total: this.operations.length,
      doc: snapshot(this.viewState),
      operation: this.version ? this.operations[this.version - 1] : null,
    };
  }
}
