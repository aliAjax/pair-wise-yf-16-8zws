import { applyStep, initialState, ledgerRowFor } from "./engine";
import type {
  CommandResult,
  LedgerRow,
  Measurement,
  PlanResult,
  State,
  Step,
  TxnRecord,
} from "./types";

const STORAGE_KEY = "fangxingzhang-v1";

interface PersistShape {
  state: State;
  ledger: LedgerRow[];
  txns: TxnRecord[];
  queue: Measurement[];
  /** 写了一半的交易：重启/重试时只从 cursor 起继续，已入账步骤靠 stepId 跳过 */
  pending: { txnId: string; opType: string; at: number; steps: Step[]; cursor: number } | null;
}

function freshShape(): PersistShape {
  return { state: initialState(), ledger: [], txns: [], queue: [], pending: null };
}

type Listener = () => void;

class Store {
  private shape: PersistShape;
  private lock: Promise<unknown> = Promise.resolve();
  private listeners = new Set<Listener>();
  private version = 0;
  /** 故障注入：让下一次持久化写入失败 */
  failNextWrite = false;

  constructor() {
    this.shape = this.load();
  }

  private load(): PersistShape {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return freshShape();
      const parsed = JSON.parse(raw) as PersistShape;
      if (!parsed.state || !parsed.ledger) return freshShape();
      return parsed;
    } catch {
      return freshShape();
    }
  }

  private snapshot(): PersistShape {
    return JSON.parse(JSON.stringify(this.shape)) as PersistShape;
  }

  /**
   * 单步原子落账：状态、流水、待办队列同写。
   * 写入失败时整体回滚到上一个耐久快照，已入账步骤不受影响。
   */
  private persistDurable(durable: PersistShape): void {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("模拟存储写入失败（磁盘/网络中断）");
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(durable));
    this.shape = durable;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit() {
    this.version += 1;
    this.listeners.forEach((l) => l());
  }

  getVersion(): number {
    return this.version;
  }

  get state(): State {
    return this.shape.state;
  }
  get ledger(): LedgerRow[] {
    return this.shape.ledger;
  }
  get txns(): TxnRecord[] {
    return this.shape.txns;
  }
  get queue(): Measurement[] {
    return this.shape.queue;
  }
  get pending() {
    return this.shape.pending;
  }

  // ---- 串行锁：两台平板同时领取，请求排队，第二个看到第一个已提交的结果 ----
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(() => fn());
    this.lock = run.catch(() => undefined);
    return run;
  }

  private delay(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * 执行一个指令：planner 基于当前耐久状态产出步骤；
   * 每一步 apply → 立刻落账。中途写失败则停在该步，等待重试，绝不重放已入账步骤。
   */
  async runTxn(
    opType: string,
    planner: (s: State) => PlanResult | null,
    opts?: { queueAfter?: Measurement[] }
  ): Promise<CommandResult> {
    return this.withLock(async () => {
      // 有待入账步骤时，必须先处理完，避免越过半完成交易
      if (this.shape.pending) {
        return { ok: false, error: "存在写了一半的交易，请先重试未入账步骤" };
      }
      const planned = planner(this.snapshot().state);
      if (!planned || planned.error || !planned.steps) return { ok: false, error: planned?.error ?? "指令无效" };

      const now = Date.now();
      const txnId = `TXN-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const steps = planned.steps;
      const committedStepIds = new Set(this.shape.ledger.map((r) => r.stepId));

      let cursor = 0;
      for (; cursor < steps.length; cursor++) {
        const step = steps[cursor];
        const durable = this.snapshot();
        if (committedStepIds.has(step.id) || durable.ledger.some((r) => r.stepId === step.id)) {
          continue; // 幂等：已入账步骤重试时跳过
        }
        try {
          applyStep(durable.state, step); // CAS/不变量失败抛 AbortError
        } catch (e) {
          const rec: TxnRecord = durable.txns.find((t) => t.id === txnId) ?? {
            id: txnId,
            opType,
            at: now,
            attempts: 0,
            status: "pending",
          };
          rec.status = "aborted";
          rec.abortReason = (e as Error).message;
          if (!durable.txns.some((t) => t.id === txnId)) durable.txns.unshift(rec);
          durable.pending = null;
          this.persistDurable(durable);
          this.emit();
          return { ok: false, error: `交易中止：${(e as Error).message}` };
        }
        const row = ledgerRowFor(step, txnId, now);
        durable.ledger.unshift(row);
        const rec = durable.txns.find((t) => t.id === txnId);
        if (rec) rec.attempts += 1;
        else
          durable.txns.unshift({
            id: txnId,
            opType,
            at: now,
            attempts: 1,
            status: cursor === steps.length - 1 ? "committed" : "pending",
          });
        if (cursor === steps.length - 1) {
          const t = durable.txns.find((t) => t.id === txnId)!;
          t.status = "committed";
          if (opts?.queueAfter) durable.queue = opts.queueAfter;
          durable.pending = null;
        } else {
          durable.pending = { txnId, opType, at: now, steps, cursor: cursor + 1 };
        }

        // 小延迟纯粹用于把两台平板的并发在界面上拉开，便于观察
        await this.delay(90);

        try {
          this.persistDurable(durable);
        } catch {
          // 回滚内存到上一个耐久快照，只把 pending 信息存住（故障注入为单发，此写成功）
          const rollback = this.snapshot();
          rollback.pending = { txnId, opType, at: now, steps, cursor };
          const rec0 = rollback.txns.find((t) => t.id === txnId);
          if (rec0) rec0.status = "pending";
          else rollback.txns.unshift({ id: txnId, opType, at: now, attempts: 1, status: "pending" });
          this.persistDurable(rollback);
          this.emit();
          return {
            ok: false,
            txnId,
            error: `写入中断：${step.kind} 未入账，其余步骤不受影响，可重试`,
          };
        }
        committedStepIds.add(step.id);
        this.emit();
      }

      const rejectedStep = steps.find((x) => x.kind === "ledgerReject");
      if (rejectedStep && rejectedStep.kind === "ledgerReject") {
        return { ok: true, txnId, rejected: rejectedStep.detail };
      }
      return { ok: true, txnId };
    });
  }

  /** 重试没入账的步骤：从 pending.cursor 继续，已入账 stepId 一律跳过 */
  async retryPending(): Promise<CommandResult> {
    return this.withLock(async () => {
      const p = this.shape.pending;
      if (!p) return { ok: true };
      const { txnId, steps, cursor: start } = p;
      let cursor = start;
      for (; cursor < steps.length; cursor++) {
        const step = steps[cursor];
        const durable = this.snapshot();
        if (durable.ledger.some((r) => r.stepId === step.id)) continue;
        try {
          applyStep(durable.state, step);
        } catch (e) {
          durable.pending = null;
          const rec = durable.txns.find((t) => t.id === txnId);
          if (rec) {
            rec.status = "aborted";
            rec.abortReason = (e as Error).message;
          }
          this.persistDurable(durable);
          this.emit();
          return { ok: false, error: `交易中止：${(e as Error).message}` };
        }
        durable.ledger.unshift(ledgerRowFor(step, txnId, p.at));
        const rec = durable.txns.find((t) => t.id === txnId);
        if (rec) {
          rec.attempts += 1;
          rec.status = cursor === steps.length - 1 ? "committed" : "pending";
        }
        if (cursor === steps.length - 1) {
          durable.pending = null;
          const t = durable.txns.find((t) => t.id === txnId);
          if (t) t.status = "committed";
        } else {
          durable.pending = { ...p, cursor: cursor + 1 };
        }
        await this.delay(60);
        try {
          this.persistDurable(durable);
        } catch {
          const rollback = this.snapshot();
          rollback.pending = { ...p, cursor };
          this.persistDurable(rollback);
          this.emit();
          return { ok: false, txnId, error: "重试时再次写入失败，仍停在未入账步骤" };
        }
        this.emit();
      }
      return { ok: true, txnId };
    });
  }

  // ---- 离线队列（本地缓存，回网后按雪板号合并） ----

  enqueueOffline(m: Measurement): void {
    const durable = this.snapshot();
    durable.queue.push(m);
    this.persistDurable(durable);
    this.emit();
  }

  removeQueue(ids: string[]): void {
    const durable = this.snapshot();
    durable.queue = durable.queue.filter((m) => !ids.includes(m.id));
    this.persistDurable(durable);
    this.emit();
  }

  resetAll(): void {
    localStorage.removeItem(STORAGE_KEY);
    this.shape = freshShape();
    this.emit();
  }
}

export const store = new Store();
