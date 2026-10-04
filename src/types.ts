// 雪板磨底放行账 —— 领域模型

/** 工单状态：测量中 → 主管已放行 → 开工中 → 完工；开工被拒则回到拒绝 */
export type OrderStatus =
  | "measuring" // 测量中（无放行）
  | "released" // 主管已放行
  | "in-progress" // 开工中（已分配工位、已入账耗用）
  | "done" // 完工
  | "rejected"; // 开工校验被拒

/** 底板损伤记录 */
export interface DamageRecord {
  id: string;
  description: string;
  createdAt: number;
}

/** 雪板档案 */
export interface Board {
  id: string; // 雪板号
  brand: string;
  length: number;
  model: string; // 板型
  baseThickness: number; // 底板厚度 mm
  safetyThickness: number; // 安全厚度 mm（磨后不得低于此值）
  damages: DamageRecord[];
  revision: number; // 档案版本：新增损伤或授权厚度变化时 +1
}

/** 砂带批次 */
export interface BeltBatch {
  id: string; // 批次号
  totalLife: number; // 总寿命
  remainingLife: number; // 剩余寿命（已入账扣减后的真实值）
  workstation: string | null; // 当前占用工位（平板A / 平板B）
}

/** 放行账步骤（按 stepId 幂等，只重试未入账步骤） */
export interface LedgerStep {
  id: string; // 幂等键，如 `${orderId}:consume`
  orderId: string;
  boardId: string;
  beltId: string;
  workstation: string;
  kind: "consume"; // 耗用砂带寿命
  amount: number; // 耗用寿命
  status: "pending" | "posted" | "failed";
  error?: string;
  createdAt: number;
  postedAt?: number;
}

/** 磨板工单 */
export interface WorkOrder {
  id: string;
  boardId: string;
  targetEdgeAngle: string; // 目标刃角
  plannedGrindAmount: number; // 计划磨削量 mm
  requiredBeltLife: number; // 需求砂带寿命
  status: OrderStatus;
  workstation: string | null; // 分配工位（拒绝开工时不变）
  release: {
    supervisor: string;
    boardRevision: number; // 放行时依据的档案版本
    releasedAt: number;
  } | null;
  rejectReason: string | null;
}

/** 离线测量记录（离线时不入网，回网按雪板号合并） */
export interface OfflineMeasurement {
  id: string;
  boardId: string;
  thickness: number;
  measuredAt: number;
  synced: boolean;
}

/** 事件日志 */
export interface LedgerEvent {
  id: string;
  time: number;
  message: string;
  type: "info" | "warn" | "error" | "success";
}

export interface LedgerState {
  boards: Board[];
  belts: BeltBatch[];
  orders: WorkOrder[];
  ledger: LedgerStep[];
  offlineQueue: OfflineMeasurement[];
  events: LedgerEvent[];
  online: boolean;
  injectFailure: boolean; // 模拟写入故障
  supervisor: string;
}
