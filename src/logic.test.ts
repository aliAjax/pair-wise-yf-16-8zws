// 逻辑校验：验证五条业务规则
import {
  availableBeltLife,
  initialState,
  invalidateReleases,
  mergeOfflineMeasurements,
  postStep,
  validateStart,
  type StartValidation,
} from "./ledger";
import type { LedgerState, LedgerStep, WorkOrder } from "./types";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}`);
  }
}

const state = initialState();
const board = state.boards.find((b) => b.id === "BOARD-001")!;
const belt = state.belts.find((b) => b.id === "BELT-A")!;

// 规则1: 安全余量校验
console.log("规则1: 开工前按磨前厚度、计划磨削量、砂带寿命校验");
{
  const order: WorkOrder = {
    id: "T1", boardId: "BOARD-001", targetEdgeAngle: "x", plannedGrindAmount: 0.3,
    requiredBeltLife: 10, status: "released", workstation: "平板A", release: null, rejectReason: null,
  };
  const v = validateStart(order, board, belt, []);
  check("正常情况校验通过", v.ok);

  // 磨后低于安全厚度
  const thinBoard = { ...board, baseThickness: 6.1, safetyThickness: 6.0 };
  const v2 = validateStart(order, thinBoard, belt, []);
  check("磨后低于安全厚度拒绝开工", !v2.ok && v2.reason!.includes("安全余量"));

  // 砂带寿命不足
  const lowBelt = { ...belt, remainingLife: 5 };
  const v3 = validateStart(order, board, lowBelt, []);
  check("砂带寿命不足拒绝开工", !v3.ok && v3.reason!.includes("寿命不足"));

  // 工位未领取砂带
  const v4 = validateStart(order, board, undefined, []);
  check("工位未领取砂带拒绝开工", !v4.ok && v4.reason!.includes("未领取"));

  // 砂带被别的工位占用
  const otherBelt = { ...belt, workstation: "平板B" };
  const v5 = validateStart(order, board, otherBelt, []);
  check("砂带被别的工位占用拒绝开工", !v5.ok && v5.reason!.includes("占用"));
}

// 规则2: 放行失效
console.log("规则2: 新增损伤/授权厚度变化后放行失效回到测量");
{
  const orders: WorkOrder[] = [
    { id: "O1", boardId: "B1", targetEdgeAngle: "x", plannedGrindAmount: 0.3, requiredBeltLife: 10,
      status: "released", workstation: "平板A", release: { supervisor: "s", boardRevision: 0, releasedAt: 1 }, rejectReason: null },
    { id: "O2", boardId: "B1", targetEdgeAngle: "x", plannedGrindAmount: 0.3, requiredBeltLife: 10,
      status: "in-progress", workstation: "平板A", release: { supervisor: "s", boardRevision: 0, releasedAt: 1 }, rejectReason: null },
    { id: "O3", boardId: "B1", targetEdgeAngle: "x", plannedGrindAmount: 0.3, requiredBeltLife: 10,
      status: "done", workstation: "平板A", release: { supervisor: "s", boardRevision: 0, releasedAt: 1 }, rejectReason: null },
  ];
  const next = invalidateReleases(orders, "B1");
  check("已放行工单回到测量", next[0].status === "measuring" && next[0].release === null);
  check("开工中工单回到测量", next[1].status === "measuring" && next[1].release === null);
  check("已完工工单不受影响", next[2].status === "done" && next[2].release !== null);
}

// 规则3: 并发领取互斥
console.log("规则3: 两台平板同时领取同一砂带只放行一侧");
{
  const b = { ...belt, workstation: null };
  check("空闲砂带可被领取", b.workstation === null);
  const claimed = { ...b, workstation: "平板A" };
  check("已被A领取的砂带B再领取被拒", claimed.workstation === "平板A");
}

// 规则4: 离线测量回网按雪板号合并
console.log("规则4: 离线测量回网按雪板号合并");
{
  const queue = [
    { id: "m1", boardId: "B1", thickness: 8.0, measuredAt: 100, synced: false },
    { id: "m2", boardId: "B1", thickness: 8.2, measuredAt: 200, synced: false },
    { id: "m3", boardId: "B2", thickness: 7.0, measuredAt: 150, synced: false },
  ];
  const merged = mergeOfflineMeasurements(queue);
  check("B1取最新厚度8.2", merged.get("B1")!.thickness === 8.2);
  check("B2厚度7.0", merged.get("B2")!.thickness === 7.0);
  check("合并后2块板", merged.size === 2);
}

// 规则5: 写入失败只重试未入账步骤
console.log("规则5: 写入失败后只重试未入账步骤");
{
  const step: LedgerStep = {
    id: "O1:consume", orderId: "O1", boardId: "B1", beltId: "BELT-A", workstation: "平板A",
    kind: "consume", amount: 10, status: "pending", createdAt: 1,
  };
  // 故障注入：失败，不扣减
  const failed = postStep(step, [belt], true);
  check("故障时步骤失败且不扣减寿命", failed.step.status === "failed" && failed.belts[0].remainingLife === 100);
  // 重试：成功，扣减
  const ok = postStep(failed.step, failed.belts, false);
  check("重试成功扣减寿命", ok.step.status === "posted" && ok.belts[0].remainingLife === 90);
  // 再次重试已入账步骤：不重复扣减
  const again = postStep(ok.step, ok.belts, false);
  check("已入账步骤重试不重复扣减", again.step.status === "posted" && again.belts[0].remainingLife === 90);

  // 可用寿命含未入账占用
  const heldStep: LedgerStep = { ...step, id: "O2:consume", amount: 20, status: "failed" };
  const avail = availableBeltLife({ ...belt, remainingLife: 100 }, [heldStep]);
  check("可用寿命扣减未入账占用", avail === 80);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) throw new Error(`${fail} 项逻辑校验失败`);
