import { GameEngine } from './game.mjs';
import { parseCommand, createCommandGate } from './commands.mjs';

const directions = new Set(['UP', 'DOWN', 'LEFT', 'RIGHT']);
const interimStableMs = 40;
const minTurnStepMs = 100;

export class GameSession {
  constructor({ engine = new GameEngine(), now = () => performance.now(), stepMs = 500,
    countdownMs = 3000, wallGraceMs = 1200, onChange = () => {}, onReceipt = () => {} } = {}) {
    if (!Number.isFinite(stepMs) || stepMs < 100 || !Number.isFinite(countdownMs) || countdownMs < 0 ||
        !Number.isFinite(wallGraceMs) || wallGraceMs < 0) {
      throw new Error('Invalid session timing');
    }
    this.engine = engine;
    this.now = now;
    this.stepMs = stepMs;
    this.countdownMs = countdownMs;
    this.wallGraceMs = wallGraceMs;
    this.wallGraceUntil = null;
    this.onChange = onChange;
    this.onReceipt = onReceipt;
    this.gate = createCommandGate();
    this.listening = false;
    this.focused = true;
    this.visible = true;
    this.startRequested = false;
    this.countdownAt = null;
    this.nextStepAt = null;
    this.lastStepAt = -Infinity;
    this.lastTurnMs = null;
    this.activeResults = new Set();
    this.directionCandidates = new Map();
    this.earlyResults = new Set();
    this.blockedResults = new Set();
    this.epoch = 0;
    this.inputBoundaryAt = -Infinity;
  }

  ready() { return this.listening && this.focused && this.visible; }

  inputContext() {
    return { state: this.engine.state, epoch: this.epoch, boundaryAt: this.inputBoundaryAt,
      focused: this.focused, visible: this.visible };
  }

  boundary() {
    this.wallGraceUntil = null;
    this.epoch += 1;
    this.inputBoundaryAt = this.now();
    for (const id of this.activeResults) this.blockedResults.add(id);
    this.activeResults.clear();
    this.directionCandidates.clear();
    while (this.blockedResults.size > 256) this.blockedResults.delete(this.blockedResults.values().next().value);
  }

  requestStart() {
    if (!['READY', 'ENDED'].includes(this.engine.state)) return false;
    this.engine.prepare();
    this.startRequested = true;
    this.boundary();
    this.armCountdown();
    return true;
  }

  armCountdown() {
    if (this.startRequested && this.ready() && this.countdownAt === null) {
      this.countdownAt = this.now() + this.countdownMs;
    }
    this.emit();
  }

  setListening(listening) {
    this.listening = listening;
    if (!listening) this.interrupt('voice_unavailable');
    else this.armCountdown();
  }

  setPresence({ focused = this.focused, visible = this.visible }) {
    this.focused = focused;
    this.visible = visible;
    if (!focused || !visible) this.interrupt(visible ? 'focus' : 'hidden');
    else this.armCountdown();
  }

  interrupt(reason) {
    this.boundary();
    this.engine.pause(reason);
    this.countdownAt = null;
    this.nextStepAt = null;
    this.emit();
  }

  receive(input) {
    if (!input || typeof input.resultId !== 'string' || typeof input.text !== 'string') return;
    if (input.source === 'lingxi' && (input.inputEpoch !== this.epoch ||
        !Number.isFinite(input.audioEndAt) || input.audioEndAt < this.inputBoundaryAt ||
        this.now() < input.audioEndAt || this.now() - input.audioEndAt > 1500)) {
      const receipt = { accepted: false, reason: 'old_interaction' };
      this.onReceipt(input, null, receipt);
      return receipt;
    }
    if (input.isFinal) {
      this.activeResults.delete(input.resultId);
      this.directionCandidates.delete(input.resultId);
    }
    if (this.blockedResults.has(input.resultId)) {
      if (input.isFinal) this.onReceipt(input, null, { accepted: false, reason: 'old_interaction' });
      return;
    }
    // A late final/revision must not repeat an already attempted early direction.
    if (this.earlyResults.has(input.resultId)) return { accepted: false, reason: 'duplicate' };
    if (!input.isFinal) {
      this.activeResults.add(input.resultId);
      const command = parseCommand(input.text);
      if (directions.has(command) && this.ready() && this.engine.state === 'RUNNING' &&
          input.receivedAt >= this.inputBoundaryAt) {
        const previous = this.directionCandidates.get(input.resultId);
        if (!previous || previous.command !== command) {
          this.directionCandidates.set(input.resultId, { command, input: { ...input },
            stableAt: this.now() + (input.source === 'local' ? 16 : interimStableMs) });
        }
      } else this.directionCandidates.delete(input.resultId);
      if (this.activeResults.size > 256) {
        const oldest = this.activeResults.values().next().value;
        this.activeResults.delete(oldest);
        this.directionCandidates.delete(oldest);
      }
      return;
    }
    return this.execute(input);
  }

  execute(input) {
    const now = this.now();
    // A delayed animation frame must not let a newly arrived command renew grace.
    if (this.wallGraceUntil !== null && now >= this.wallGraceUntil && this.engine.nextStepHitsWall(now)) {
      this.engine.step(now);
      this.nextStepAt = null;
      this.boundary();
    }
    const command = parseCommand(input.text);
    const event = { command, id: input.resultId, receivedAt: input.receivedAt };
    let receipt = { accepted: false, reason: 'unknown' };
    const before = this.engine.state;
    if (command) {
      if (!this.ready()) receipt = { accepted: false, reason: 'input_unavailable' };
      else if (input.receivedAt < this.inputBoundaryAt) receipt = { accepted: false, reason: 'old_interaction' };
      else {
        receipt = this.gate.accept(event, before, this.now());
        if (receipt.accepted) receipt = this.engine.dispatch(event, this.now());
      }
    }
    if (receipt.accepted && ['PAUSE', 'RESTART', 'END'].includes(command)) this.boundary();
    if (receipt.accepted && command === 'END') {
      this.listening = false;
      this.startRequested = false;
      this.countdownAt = null;
      this.nextStepAt = null;
    } else if (receipt.accepted && ['RESTART', 'RESUME'].includes(command)) {
      this.nextStepAt = this.now() + this.stepMs;
      this.lastStepAt = this.now();
      this.lastTurnMs = null;
    } else if (receipt.accepted && command === 'PAUSE') this.nextStepAt = null;
    if (receipt.accepted && receipt.reason === 'queued') {
      // Pull a turn forward without allowing rapid speech to burst grid moves.
      this.nextStepAt = Math.min(this.nextStepAt,
        Math.max(this.now(), this.lastStepAt + minTurnStepMs));
    }
    this.onReceipt(input, command, receipt);
    this.emit();
    return receipt;
  }

  update() {
    const now = this.now();
    if (this.countdownAt !== null && this.ready() && now >= this.countdownAt) {
      this.startRequested = false;
      this.countdownAt = null;
      this.engine.start();
      this.boundary();
      this.nextStepAt = now + this.stepMs;
      this.lastStepAt = now - minTurnStepMs;
      this.lastTurnMs = null;
    }
    for (const [id, candidate] of this.directionCandidates) {
      if (now < candidate.stableAt) continue;
      this.directionCandidates.delete(id);
      this.earlyResults.add(id);
      while (this.earlyResults.size > 256) this.earlyResults.delete(this.earlyResults.values().next().value);
      this.execute(candidate.input);
    }
    if (this.engine.state === 'RUNNING' && this.ready() && this.nextStepAt !== null && now >= this.nextStepAt) {
      if (this.engine.nextStepHitsWall(now)) {
        if (this.wallGraceUntil === null) this.wallGraceUntil = now + this.wallGraceMs;
        if (now < this.wallGraceUntil) {
          this.nextStepAt = this.wallGraceUntil;
          this.emit();
          return;
        }
      }
      this.wallGraceUntil = null;
      // At most one grid step per frame; recovery never catches up missed moves.
      const previous = this.engine.state;
      const receivedAt = this.engine.pending?.receivedAt;
      this.engine.step(now);
      this.lastStepAt = now;
      if (this.engine.lastAppliedId) this.lastTurnMs = Math.max(0, Math.round(now - receivedAt));
      this.nextStepAt = now + this.stepMs;
      if (previous !== this.engine.state) {
        this.boundary();
        this.nextStepAt = null;
      }
    }
    this.emit();
  }

  snapshot() {
    return { ...this.engine.snapshot(), listening: this.listening,
      countdown: this.countdownAt === null ? null : Math.max(1, Math.ceil((this.countdownAt - this.now()) / 1000)),
      starting: this.startRequested, inputEpoch: this.epoch, stepMs: this.stepMs,
      lastTurnMs: this.lastTurnMs,
      wallWaitMs: this.wallGraceUntil === null ? null : Math.max(0, this.wallGraceUntil - this.now()) };
  }

  emit() { this.onChange(this.snapshot()); }
}
