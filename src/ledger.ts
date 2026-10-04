// 雪板磨底放行账 —— 纯业务规则与初始数据
import type {
  BeltBatch,
  Board,
  LedgerState,
  LedgerStep,
  OfflineMeasurement,
  WorkOrder,
} from "./types";

export const WORKSTATIONS = ["平板A", "平板B"] as const;

export const SAFETY_THICKNESS_DEFAULT = 6.0;

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

/** 砂带可用寿命 = 剩余寿命 - 未入账（pending/failed）步骤占用量，防止超承诺 */
export function availableBeltLife(belt: BeltBatch, steps: LedgerStep[]): number {
  const held = steps
    .filter((s) => s.beltId === belt.id && s.status !== "posted")
    .reduce((sum, s) => sum + s.amount, 0);
  return belt.remainingLife - held;
}

export interface StartValidation {
  ok: boolean;
  reason?: string;
}

/**
 * 开工前校验：
 * 1. 磨前厚度 - 计划磨削量 >= 安全厚度（安全余量）
 * 2. 砂带可用寿命 >= 需求寿命
 * 3. 砂带须被本工位领取（占用互斥）
 * 任一不满足 → 拒绝开工，工位与耗用都不变。
 */
export function validateStart(
  order: WorkOrder,
  board: Board,
  belt: BeltBatch | undefined,
  steps: LedgerStep[]
): StartValidation {
  const after = board.baseThickness - order.plannedGrindAmount;
  if (after < board.safetyThickness) {
    return {
      ok: false,
      reason: `安全余量不足：磨后厚度 ${after.toFixed(2)}mm 低于安全厚度 ${board.safetyThickness.toFixed(2)}mm`,
    };
  }
  if (!belt) {
    return { ok: false, reason: "工位未领取砂带" };
  }
  const avail = availableBeltLife(belt, steps);
  if (avail < order.requiredBeltLife) {
    return {
      ok: false,
      reason: `砂带寿命不足：可用 ${avail} < 需求 ${order.requiredBeltLife}`,
    };
  }
  if (belt.workstation && belt.workstation !== order.workstation) {
    return { ok: false, reason: `砂带已被工位 ${belt.workstation} 占用` };
  }
  return { ok: true };
}

/** 放行是否仍有效：放行依据的档案版本须与当前版本一致 */
export function isReleaseValid(order: WorkOrder, board: Board): boolean {
  return !!order.release && order.release.boardRevision === board.revision;
}

/** 入账：按步骤状态推进，已入账(posted)的步骤绝不重复扣减 */
export function postStep(
  step: LedgerStep,
  belts: BeltBatch[],
  injectFailure: boolean
): { step: LedgerStep; belts: BeltBatch[] } {
  if (step.status === "posted") return { step, belts };
  if (injectFailure) {
    return {
      step: { ...step, status: "failed", error: "模拟写入失败：耗用未入账" },
      belts,
    };
  }
  return {
    step: { ...step, status: "posted", postedAt: Date.now(), error: undefined },
    belts: belts.map((b) =>
      b.id === step.beltId ? { ...b, remainingLife: b.remainingLife - step.amount } : b
    ),
  };
}

/** 新增损伤 / 授权厚度变化后，未完工工单的主管放行失效，回到测量 */
export function invalidateReleases(orders: WorkOrder[], boardId: string): WorkOrder[] {
  return orders.map((o) => {
    if (o.boardId !== boardId || o.status === "done") return o;
    if (!o.release) return o;
    return { ...o, status: "measuring", release: null, workstation: null, rejectReason: null };
  });
}

/** 离线测量回网：按雪板号合并，取最新一次厚度 */
export function mergeOfflineMeasurements(
  queue: OfflineMeasurement[]
): Map<string, { thickness: number; measuredAt: number }> {
  const latest = new Map<string, { thickness: number; measuredAt: number }>();
  for (const m of queue) {
    const cur = latest.get(m.boardId);
    if (!cur || m.measuredAt > cur.measuredAt) {
      latest.set(m.boardId, { thickness: m.thickness, measuredAt: m.measuredAt });
    }
  }
  return latest;
}

export function initialState(): LedgerState {
  const boards: Board[] = [
    {
      id: "BOARD-001",
      brand: "Burton",
      length: 156,
      model: "全地域",
      baseThickness: 8.0,
      safetyThickness: SAFETY_THICKNESS_DEFAULT,
      damages: [],
      revision: 0,
    },
    {
      id: "BOARD-002",
      brand: "竞速板",
      length: 165,
      model: "竞速板",
      baseThickness: 6.6,
      safetyThickness: SAFETY_THICKNESS_DEFAULT,
      damages: [
        { id: uid("dmg"), description: "底板划痕 12cm，待补 P-Tex", createdAt: Date.now() - 86400000 },
      ],
      revision: 1,
    },
    {
      id: "BOARD-003",
      brand: "粉雪板",
      length: 158,
      model: "粉雪板",
      baseThickness: 5.7,
      safetyThickness: SAFETY_THICKNESS_DEFAULT,
      damages: [],
      revision: 0,
    },
  ];

  const belts: BeltBatch[] = [
    { id: "BELT-A", totalLife: 100, remainingLife: 100, workstation: null },
    { id: "BELT-B", totalLife: 100, remainingLife: 15, workstation: null },
    { id: "BELT-C", totalLife: 100, remainingLife: 60, workstation: null },
  ];

  const orders: WorkOrder[] = [
    {
      id: "ORD-106",
      boardId: "BOARD-001",
      targetEdgeAngle: "侧刃88° / 底刃1°",
      plannedGrindAmount: 0.3,
      requiredBeltLife: 10,
      status: "measuring",
      workstation: null,
      release: null,
      rejectReason: null,
    },
    {
      id: "ORD-112",
      boardId: "BOARD-002",
      targetEdgeAngle: "侧刃87° / 底刃0.5°",
      plannedGrindAmount: 0.4,
      requiredBeltLife: 12,
      status: "released",
      workstation: null,
      release: { supervisor: "主管", boardRevision: 1, releasedAt: Date.now() - 3600000 },
      rejectReason: null,
    },
    {
      id: "ORD-118",
      boardId: "BOARD-003",
      targetEdgeAngle: "侧刃89° / 底刃1°",
      plannedGrindAmount: 0.3,
      requiredBeltLife: 10,
      status: "measuring",
      workstation: null,
      release: null,
      rejectReason: null,
    },
    {
      id: "ORD-120",
      boardId: "BOARD-001",
      targetEdgeAngle: "侧刃88° / 底刃1.5°",
      plannedGrindAmount: 0.2,
      requiredBeltLife: 8,
      status: "released",
      workstation: null,
      release: { supervisor: "主管", boardRevision: 0, releasedAt: Date.now() - 1800000 },
      rejectReason: null,
    },
  ];

  return {
    boards,
    belts,
    orders,
    ledger: [],
    offlineQueue: [],
    events: [
      {
        id: uid("evt"),
        time: Date.now(),
        message: "放行账已建立：3 块雪板、3 批砂带、4 张工单",
        type: "info",
      },
    ],
    online: true,
    injectFailure: false,
    supervisor: "主管",
  };
}
