// 放行账领域模型：雪板档案 / 磨板工单 / 砂带批次 / 流水

export type OrderStatus =
  | "unmeasured" // 待测量
  | "measured" // 已测量，待主管放行
  | "released" // 主管已放行，可开工
  | "running" // 加工中（占工位、占砂带）
  | "done"; // 已完工

export interface BaseDamage {
  id: string;
  note: string;
  at: number;
}

export interface Authorization {
  id: string;
  by: string; // 客户/授权人
  fromMm: number;
  toMm: number;
  note: string;
  at: number;
}

export interface SkiProfile {
  skiNo: string;
  brand: string;
  lengthCm: number;
  shape: string;
  edgeSpec: string; // 当前刃角设定（仅参考，放行不再只看它）
  waxType: string;
  customerPref: string;
  baseThicknessMm: number; // 当前底板厚度
  safetyThicknessMm: number; // 安全厚度下限
  damage: BaseDamage[];
  authorizations: Authorization[];
  /** 底板版本：新增损伤 / 客户授权改厚后 +1，旧放行立即失效 */
  profileVersion: number;
}

export interface ActiveRelease {
  at: number;
  by: string; // 放行主管
  beltNo: string;
  planMm: number;
  preGrindMm: number; // 放行时快照的磨前厚度
  profileVersion: number; // 放行时快照的底板版本
  voided: boolean;
  voidReason?: string;
}

export interface WorkOrder {
  orderNo: string;
  skiNo: string;
  edgeTarget: string; // 目标刃角（参考项）
  planGrindMm: number; // 计划磨削量
  status: OrderStatus;
  preGrindMm: number | null; // 磨前厚度
  lastMeasureAt: number | null;
  release: ActiveRelease | null;
  beltNo: string | null; // 已领取的砂带
  station: string | null; // 已占用工位
  consumedLifeMm: number; // 本工单累计耗用砂带寿命
  startedAt: number | null;
  finishedAt: number | null;
  postGrindMm: number | null;
}

export interface BeltBatch {
  beltNo: string;
  grit: string;
  totalLifeMm: number;
  remainingLifeMm: number;
  heldByOrderNo: string | null;
  /** 乐观锁版本：领取/耗用每次落账 +1，用于并发抢占 CAS */
  version: number;
}

export interface Station {
  code: string;
  name: string;
  heldByOrderNo: string | null;
}

export interface Measurement {
  id: string;
  skiNo: string;
  thicknessMm: number;
  at: number;
  client: string; // 测量平板编号
  valid: boolean;
}

export interface State {
  skis: SkiProfile[];
  orders: WorkOrder[];
  belts: BeltBatch[];
  stations: Station[];
}

export interface LedgerRow {
  stepId: string; // 幂等键
  txnId: string;
  at: number;
  op: string;
  status: "committed" | "rejected";
  detail: string;
  orderNo?: string;
  skiNo?: string;
  beltNo?: string;
  station?: string;
}

export interface TxnRecord {
  id: string;
  opType: string;
  at: number;
  attempts: number;
  status: "pending" | "committed" | "aborted";
  abortReason?: string;
}

/** 单步落账动作。同一步骤以 stepId 为幂等键，重试时跳过已入账步骤 */
export type Step =
  | { id: string; kind: "ledgerReject"; op: string; detail: string; orderNo?: string; skiNo?: string; beltNo?: string; station?: string }
  | { id: string; kind: "releaseOrder"; orderNo: string; by: string; beltNo: string; at: number }
  | { id: string; kind: "claimBelt"; orderNo: string; beltNo: string; expectVersion: number }
  | { id: string; kind: "consumeBelt"; orderNo: string; beltNo: string; mm: number }
  | { id: string; kind: "occupyStation"; orderNo: string; station: string }
  | { id: string; kind: "startOrder"; orderNo: string; at: number }
  | { id: string; kind: "completeOrder"; orderNo: string; postGrindMm: number; at: number }
  | { id: string; kind: "reportDamage"; skiNo: string; damage: BaseDamage }
  | { id: string; kind: "authorizeThickness"; skiNo: string; auth: Authorization }
  | { id: string; kind: "applyMeasurement"; measurement: Measurement };

export class AbortError extends Error {}

export interface CommandResult {
  ok: boolean;
  error?: string;
  rejected?: string; // 放行账拒绝原因（已入拒绝账）
  txnId?: string;
}

/** 指令规划结果：要么产出可落账步骤，要么给出不可执行原因 */
export interface PlanResult {
  steps?: Step[];
  error?: string;
}
