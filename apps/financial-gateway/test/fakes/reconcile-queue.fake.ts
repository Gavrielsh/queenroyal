import type {
  ReconcileEventInput,
  ReconcileMessage,
  ReconcileQueue,
} from "../../src/lib/reconcile-queue";

/**
 * In-memory {@link ReconcileQueue} for tests. Models the Redis-Streams broker's observable
 * behavior — immediate + delayed (scheduled) delivery, an in-flight PEL with redelivery on
 * reclaim, acks, and a Dead Letter Queue — without Redis. Install it with
 * `setReconcileQueue(new ReconcileQueueFake())`.
 */

interface Scheduled {
  evt: ReconcileEventInput;
  visibleAt: number;
}

interface InFlight extends ReconcileMessage {
  deliveredAt: number;
}

export interface DeadLetterEntry {
  message: ReconcileMessage;
  error: string;
}

export class ReconcileQueueFake implements ReconcileQueue {
  private seq = 0;
  private ready: ReconcileMessage[] = [];
  private scheduled: Scheduled[] = [];
  private readonly inFlight = new Map<string, InFlight>();
  readonly dead: DeadLetterEntry[] = [];

  async publish(evt: ReconcileEventInput): Promise<void> {
    this.ready.push(this.makeMessage(evt, 1));
  }

  async schedule(evt: ReconcileEventInput, delayMs: number): Promise<void> {
    this.scheduled.push({ evt, visibleAt: Date.now() + Math.max(0, delayMs) });
  }

  async pull(count: number, _blockMs: number): Promise<ReconcileMessage[]> {
    this.drainDue(count);
    const batch = this.ready.splice(0, count);
    for (const msg of batch) this.inFlight.set(msg.deliveryId, { ...msg, deliveredAt: Date.now() });
    return batch;
  }

  async reclaim(minIdleMs: number, count: number): Promise<ReconcileMessage[]> {
    const now = Date.now();
    const stale: ReconcileMessage[] = [];
    for (const msg of this.inFlight.values()) {
      if (now - msg.deliveredAt < minIdleMs) continue;
      msg.deliveryCount += 1;
      msg.deliveredAt = now;
      stale.push({ ...msg });
      if (stale.length >= count) break;
    }
    return stale;
  }

  async ack(msg: ReconcileMessage): Promise<void> {
    this.inFlight.delete(msg.deliveryId);
  }

  async deadLetter(msg: ReconcileMessage, error: string): Promise<void> {
    this.dead.push({ message: { ...msg }, error });
    this.inFlight.delete(msg.deliveryId);
  }

  // ── test inspection helpers ──────────────────────────────────────────────
  /** Force any scheduled (delayed) events due now-or-later to become immediately deliverable. */
  releaseScheduled(): void {
    for (const s of this.scheduled.splice(0)) this.ready.push(this.makeMessage(s.evt, 1));
  }

  get readyCount(): number {
    return this.ready.length;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  get scheduledCount(): number {
    return this.scheduled.length;
  }

  private drainDue(count: number): void {
    const now = Date.now();
    let moved = 0;
    this.scheduled = this.scheduled.filter((s) => {
      if (moved >= count || s.visibleAt > now) return true;
      this.ready.push(this.makeMessage(s.evt, 1));
      moved += 1;
      return false;
    });
  }

  private makeMessage(evt: ReconcileEventInput, deliveryCount: number): ReconcileMessage {
    this.seq += 1;
    return {
      deliveryId: `${Date.now()}-${this.seq}`,
      operatorTransactionId: evt.operatorTransactionId,
      reason: evt.reason,
      deliveryCount,
      enqueuedAt: new Date().toISOString(),
    };
  }
}
