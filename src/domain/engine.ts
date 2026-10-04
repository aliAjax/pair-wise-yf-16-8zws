import {
  AbortError,
  BaseDamage,
  Measurement,
  PlanResult,
  SkiProfile,
  State,
  Step,
  WorkOrder,
} from "./types";

// ---- 初始档案（雪板 / 工单 / 砂带 / 工位） ----

export function initialState(): State {
  return {
    skis: [
      {
        skiNo: "SK-001",
        brand: "Burton Custom 156",
        lengthCm: 156,
        shape: "全地域",
        edgeSpec: "侧刃88° / 底刃1°",
        waxType: "低温蜡",
        customerPref: "弱咬雪，底板尽量少磨",
        baseThicknessMm: 2.1,
        safetyThicknessMm: 1.4,
        damage: [],
        authorizations: [],
        profileVersion: 1,
      },
      {
        skiNo: "SK-002",
        brand: "Atomic Redster 165",
        lengthCm: 165,
        shape: "竞速板",
        edgeSpec: "侧刃87° / 底刃0.5°",
        waxType: "竞速蜡",
        customerPref: "追求高速底面平面度",
        baseThicknessMm: 1.45,
        safetyThicknessMm: 1.4,
        damage: [{ id: "DMG-0", note: "底板划痕 12cm，已 P-Tex 补过", at: Date.now() - 86400000 * 3 }],
        authorizations: [],
        profileVersion: 1,
      },
      {
        skiNo: "SK-003",
        brand: "Jones Hovercraft 158",
        lengthCm: 158,
        shape: "粉雪板",
        edgeSpec: "侧刃89° / 底刃1°",
        waxType: "温蜡",
        customerPref: "粉雪浮板感",
        baseThicknessMm: 2.4,
        safetyThicknessMm: 1.4,
        damage: [],
        authorizations: [],
        profileVersion: 1,
      },
    ],
    orders: [
      {
        orderNo: "WO-301",
        skiNo: "SK-001",
        edgeTarget: "侧刃88° / 底刃1°",
        planGrindMm: 0.2,
        status: "measured",
        preGrindMm: 2.1,
        lastMeasureAt: Date.now() - 3600_000,
        release: null,
        beltNo: null,
        station: null,
        consumedLifeMm: 0,
        startedAt: null,
        finishedAt: null,
        postGrindMm: null,
      },
      {
        orderNo: "WO-302",
        skiNo: "SK-002",
        edgeTarget: "侧刃87° / 底刃0.5°",
        planGrindMm: 0.15,
        status: "measured",
        preGrindMm: 1.45,
        lastMeasureAt: Date.now() - 2400_000,
        release: null,
        beltNo: null,
        station: null,
        consumedLifeMm: 0,
        startedAt: null,
        finishedAt: null,
        postGrindMm: null,
      },
      {
        orderNo: "WO-303",
        skiNo: "SK-003",
        edgeTarget: "侧刃89° / 底刃1°",
        planGrindMm: 0.1,
        status: "unmeasured",
        preGrindMm: null,
        lastMeasureAt: null,
        release: null,
        beltNo: null,
        station: null,
        consumedLifeMm: 0,
        startedAt: null,
        finishedAt: null,
        postGrindMm: null,
      },
    ],
    belts: [
      { beltNo: "BT-07", grit: "P120", totalLifeMm: 40, remainingLifeMm: 2.5, heldByOrderNo: null, version: 1 },
      { beltNo: "BT-08", grit: "P150", totalLifeMm: 40, remainingLifeMm: 18, heldByOrderNo: null, version: 1 },
      { beltNo: "BT-09", grit: "P80", totalLifeMm: 40, remainingLifeMm: 0.05, heldByOrderNo: null, version: 1 },
    ],
    stations: [
      { code: "ST-A", name: "一号磨床", heldByOrderNo: null },
      { code: "ST-B", name: "二号磨床", heldByOrderNo: null },
    ],
  };
}

// ---- 查找助手 ----

export function skiOf(s: State, skiNo: string): SkiProfile {
  const p = s.skis.find((x) => x.skiNo === skiNo);
  if (!p) throw new AbortError(`雪板 ${skiNo} 不存在`);
  return p;
}
export function orderOf(s: State, orderNo: string): WorkOrder {
  const o = s.orders.find((x) => x.orderNo === orderNo);
  if (!o) throw new AbortError(`工单 ${orderNo} 不存在`);
  return o;
}
export function beltOf(s: State, beltNo: string) {
  const b = s.belts.find((x) => x.beltNo === beltNo);
  if (!b) throw new AbortError(`砂带 ${beltNo} 不存在`);
  return b;
}

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

// ---- 放行失效：底板版本变化后，未完工工单的主管放行作废 ----

function voidReleaseForUnfinished(s: State, skiNo: string, reason: string, now: number) {
  for (const o of s.orders) {
    if (o.skiNo !== skiNo || o.status === "done") continue;
    if (o.release && !o.release.voided) {
      o.release = { ...o.release, voided: true, voidReason: reason };
    }
    if (o.status === "released") o.status = "measured";
    if (o.status === "running") {
      // 加工中被打断：退回测量，释放砂带与工位（砂带已耗用不退）
      o.status = "measured";
      if (o.beltNo) {
        const b = beltOf(s, o.beltNo);
        b.heldByOrderNo = null;
        o.beltNo = null;
      }
      if (o.station) {
        const st = s.stations.find((x) => x.code === o.station);
        if (st) st.heldByOrderNo = null;
        o.station = null;
      }
      o.startedAt = null;
    }
    void now;
  }
}

// ---- 校验：开工前（安全厚度 + 放行快照 + 砂带寿命 + 工位） ----

export interface GateInput {
  state: State;
  orderNo: string;
  beltNo: string;
  station: string;
}

export interface GateRejection {
  code:
    | "NO_ORDER"
    | "NO_RELEASE"
    | "RELEASE_VOIDED"
    | "PROFILE_CHANGED"
    | "NOT_RELEASED"
    | "THICKNESS_UNSAFE"
    | "MEASURE_MISMATCH"
    | "BELT_HELD"
    | "BELT_LIFE"
    | "STATION_HELD";
  message: string;
}

export function checkGate(input: GateInput): GateRejection | null {
  const { state, orderNo, beltNo, station } = input;
  const o = state.orders.find((x) => x.orderNo === orderNo);
  if (!o) return { code: "NO_ORDER", message: `工单 ${orderNo} 不存在` };
  const ski = state.skis.find((x) => x.skiNo === o.skiNo);
  if (!ski) return { code: "NO_ORDER", message: `雪板档案 ${o.skiNo} 缺失` };
  const belt = state.belts.find((x) => x.beltNo === beltNo);
  if (!belt) return { code: "BELT_HELD", message: `砂带批次 ${beltNo} 不存在` };
  const st = state.stations.find((x) => x.code === station);
  if (!st) return { code: "STATION_HELD", message: `工位 ${station} 不存在` };

  // 1) 主管放行必须有效，且绑定的是同一砂带
  if (!o.release) return { code: "NOT_RELEASED", message: "主管未放行，禁止开工" };
  if (o.release.voided)
    return { code: "RELEASE_VOIDED", message: `放行已失效（${o.release.voidReason ?? "底板有变化"}），需回到测量` };
  if (o.status !== "released")
    return { code: "NOT_RELEASED", message: `工单状态为 ${o.status}，不在可开工状态` };
  if (o.release.beltNo !== beltNo)
    return { code: "BELT_HELD", message: `该放行绑定砂带 ${o.release.beltNo}，与领取的 ${beltNo} 不一致` };

  // 2) 放行快照必须仍与档案一致（新增损伤/授权改厚会抬升版本或厚度）
  if (o.release.profileVersion !== ski.profileVersion)
    return { code: "PROFILE_CHANGED", message: "放行后底板发生变化（版本已更新），放行失效，回到测量" };
  if (o.preGrindMm == null || o.preGrindMm !== o.release.preGrindMm)
    return { code: "MEASURE_MISMATCH", message: "磨前厚度与放行快照不一致，需重新测量" };

  // 3) 安全厚度：磨前厚度 - 计划磨削量 不得低于安全厚度
  const remaining = o.preGrindMm - o.planGrindMm;
  if (remaining < ski.safetyThicknessMm)
    return {
      code: "THICKNESS_UNSAFE",
      message: `安全厚度拦截：磨前 ${o.preGrindMm}mm − 计划磨 ${o.planGrindMm}mm = ${remaining.toFixed(
        2
      )}mm < 安全下限 ${ski.safetyThicknessMm}mm`,
    };

  // 4) 砂带：同一条只能由一侧持有；剩余寿命要够本单计划磨削
  if (belt.heldByOrderNo && belt.heldByOrderNo !== orderNo)
    return { code: "BELT_HELD", message: `砂带 ${beltNo} 已被 ${belt.heldByOrderNo} 一侧领取，只放行一侧` };
  if (belt.remainingLifeMm < o.planGrindMm)
    return {
      code: "BELT_LIFE",
      message: `砂带寿命不足：剩余 ${belt.remainingLifeMm}mm < 计划磨削 ${o.planGrindMm}mm`,
    };

  // 5) 工位：必须空闲
  if (st.heldByOrderNo && st.heldByOrderNo !== orderNo)
    return { code: "STATION_HELD", message: `工位 ${station} 正被 ${st.heldByOrderNo} 占用` };

  return null;
}

// ---- 指令 → 步骤计划（拒绝开工也写一笔拒绝账，工位/砂带/耗用一律不动） ----

export interface StartArgs {
  orderNo: string;
  beltNo: string;
  station: string;
  client: string;
}

export function planStart(s: State, args: StartArgs): PlanResult {
  const now = Date.now();
  const reject = checkGate({ state: s, ...args });
  if (reject) {
    return {
      steps: [
        {
          id: `start:${args.client}:${args.orderNo}:reject:${now}`,
          kind: "ledgerReject",
          op: "开工校验",
          detail: reject.message,
          orderNo: args.orderNo,
          beltNo: args.beltNo,
          station: args.station,
        },
      ],
    };
  }
  const o = orderOf(s, args.orderNo);
  const belt = beltOf(s, args.beltNo);
  const base = `start:${args.client}:${args.orderNo}:${args.beltNo}`;
  return {
    steps: [
      { id: `${base}:claim`, kind: "claimBelt", orderNo: args.orderNo, beltNo: args.beltNo, expectVersion: belt.version },
      { id: `${base}:station`, kind: "occupyStation", orderNo: args.orderNo, station: args.station },
      { id: `${base}:begin`, kind: "startOrder", orderNo: args.orderNo, at: now },
    ],
  };
}

export interface ReleaseArgs {
  orderNo: string;
  by: string;
  beltNo: string;
  planGrindMm?: number; // 可覆盖计划磨削量
}

export function planRelease(s: State, args: ReleaseArgs): PlanResult {
  const o = orderOf(s, args.orderNo);
  const ski = skiOf(s, o.skiNo);
  if (o.status !== "measured") return { error: `工单状态 ${o.status} 不可放行（需在已测量状态）` };
  if (o.preGrindMm == null) return { error: "缺少磨前厚度，先回到测量" };
  beltOf(s, args.beltNo);
  const plan = args.planGrindMm ?? o.planGrindMm;
  if (plan <= 0) return { error: "计划磨削量必须大于 0" };
  if (o.preGrindMm - plan < ski.safetyThicknessMm)
    return {
      error: `不能放行：磨后 ${(o.preGrindMm - plan).toFixed(2)}mm 将低于安全下限 ${ski.safetyThicknessMm}mm`,
    };
  return {
    steps: [
      {
        id: `release:${args.orderNo}:${args.beltNo}:${o.preGrindMm}:${plan}:v${ski.profileVersion}`,
        kind: "releaseOrder",
        orderNo: args.orderNo,
        by: args.by || "值班主管",
        beltNo: args.beltNo,
        at: Date.now(),
      },
    ],
  };
}

export function planComplete(s: State, orderNo: string, postGrindMm: number): PlanResult {
  const o = orderOf(s, orderNo);
  if (o.status !== "running") return { error: "仅加工中的工单可以完工" };
  if (!o.beltNo || !o.station) return { error: "工单未占用砂带/工位，状态异常" };
  if (o.preGrindMm == null) return { error: "缺少磨前厚度" };
  if (postGrindMm >= o.preGrindMm) return { error: "磨后厚度必须小于磨前厚度" };
  const used = +(o.preGrindMm - postGrindMm).toFixed(3);
  const ski = skiOf(s, o.skiNo);
  if (postGrindMm < ski.safetyThicknessMm)
    return { error: `实际磨后 ${postGrindMm}mm 已低于安全下限 ${ski.safetyThicknessMm}mm，禁止入账完工` };
  const base = `complete:${orderNo}`;
  return {
    steps: [
      { id: `${base}:consume`, kind: "consumeBelt", orderNo, beltNo: o.beltNo, mm: used },
      { id: `${base}:done`, kind: "completeOrder", orderNo, postGrindMm, at: Date.now() },
    ],
  };
}

export function planDamage(s: State, skiNo: string, note: string): PlanResult {
  if (!note.trim()) return { error: "损伤描述不能为空" };
  skiOf(s, skiNo);
  const dmg: BaseDamage = { id: uid("DMG"), note: note.trim(), at: Date.now() };
  return { steps: [{ id: `damage:${skiNo}:${dmg.id}`, kind: "reportDamage", skiNo, damage: dmg }] };
}

export function planAuthorize(
  s: State,
  skiNo: string,
  args: { by: string; toMm: number; note: string }
): PlanResult {
  const ski = skiOf(s, skiNo);
  if (!args.by.trim()) return { error: "需要客户/授权人" };
  if (!(args.toMm > 0)) return { error: "授权厚度不合法" };
  if (Math.abs(args.toMm - ski.baseThicknessMm) < 0.001) return { error: "授权厚度与当前厚度一致，无需变更" };
  const auth = {
    id: uid("AUTH"),
    by: args.by.trim(),
    fromMm: ski.baseThicknessMm,
    toMm: args.toMm,
    note: args.note.trim(),
    at: Date.now(),
  };
  return { steps: [{ id: `auth:${skiNo}:${auth.id}`, kind: "authorizeThickness", skiNo, auth }] };
}

export function planMeasure(
  s: State,
  skiNo: string,
  thicknessMm: number,
  client: string
): PlanResult {
  const ski = skiOf(s, skiNo);
  if (!(thicknessMm > 0)) return { error: "厚度不合法" };
  if (thicknessMm < ski.safetyThicknessMm)
    return { error: `测量值 ${thicknessMm}mm 已低于安全下限 ${ski.safetyThicknessMm}mm` };
  const m: Measurement = { id: uid("MSR"), skiNo, thicknessMm, at: Date.now(), client, valid: true };
  return { steps: [{ id: `measure:online:${m.id}`, kind: "applyMeasurement", measurement: m }] };
}

/**
 * 离线测量回网：按雪板号合并。
 * 同一雪板多条测量只取最晚一条有效数据；重复 ID 去重；找不到档案的不合并。
 */
export function planOfflineMerge(
  s: State,
  queue: Measurement[],
  client: string
): { steps?: Step[]; applied: Measurement[]; skipped: Measurement[]; error?: string } {
  const valid = queue.filter((m) => m.valid);
  const bySki = new Map<string, Measurement[]>();
  for (const m of valid) {
    const arr = bySki.get(m.skiNo) ?? [];
    arr.push(m);
    bySki.set(m.skiNo, arr);
  }
  const steps: Step[] = [];
  const applied: Measurement[] = [];
  const skipped: Measurement[] = [];
  for (const [skiNo, arr] of bySki) {
    const ski = s.skis.find((x) => x.skiNo === skiNo);
    const sorted = [...arr].sort((a, b) => a.at - b.at);
    if (!ski) {
      skipped.push(...sorted);
      continue;
    }
    const latest = sorted[sorted.length - 1];
    const inRange = latest.thicknessMm >= ski.safetyThicknessMm;
    if (!inRange) {
      skipped.push(...sorted);
      continue;
    }
    for (const m of sorted.slice(0, -1)) skipped.push(m);
    // 幂等：步骤 ID 以测量 ID 为键，重试不会重复入账
    steps.push({ id: `measure:offline:${latest.id}`, kind: "applyMeasurement", measurement: latest });
    applied.push(latest);
  }
  void client;
  return { steps, applied, skipped };
}

// ---- 单步应用（含 CAS 乐观锁）。失败抛 AbortError，不可重试 ----

export function applyStep(s: State, step: Step): void {
  switch (step.kind) {
    case "ledgerReject":
      return; // 仅记账，无任何状态副作用（工位/耗用都不变）

    case "releaseOrder": {
      const o = orderOf(s, step.orderNo);
      const ski = skiOf(s, o.skiNo);
      if (o.status !== "measured" || o.preGrindMm == null)
        throw new AbortError("放行前提已变：工单不在已测量状态");
      o.release = {
        at: step.at,
        by: step.by,
        beltNo: step.beltNo,
        planMm: o.planGrindMm,
        preGrindMm: o.preGrindMm,
        profileVersion: ski.profileVersion,
        voided: false,
      };
      o.status = "released";
      return;
    }

    case "claimBelt": {
      const b = beltOf(s, step.beltNo);
      if (b.version !== step.expectVersion)
        throw new AbortError(`砂带 ${step.beltNo} 已被另一侧抢先领取（版本冲突）`);
      if (b.heldByOrderNo && b.heldByOrderNo !== step.orderNo)
        throw new AbortError(`砂带 ${step.beltNo} 只放行一侧，已由 ${b.heldByOrderNo} 持有`);
      b.heldByOrderNo = step.orderNo;
      b.version += 1;
      const o = orderOf(s, step.orderNo);
      o.beltNo = step.beltNo;
      return;
    }

    case "consumeBelt": {
      const b = beltOf(s, step.beltNo);
      const o = orderOf(s, step.orderNo);
      if (b.remainingLifeMm < step.mm)
        throw new AbortError(`砂带 ${step.beltNo} 剩余寿命不足以入账耗用 ${step.mm}mm`);
      b.remainingLifeMm = +(b.remainingLifeMm - step.mm).toFixed(3);
      b.version += 1;
      o.consumedLifeMm = +(o.consumedLifeMm + step.mm).toFixed(3);
      return;
    }

    case "occupyStation": {
      const st = s.stations.find((x) => x.code === step.station);
      if (!st) throw new AbortError(`工位 ${step.station} 不存在`);
      if (st.heldByOrderNo && st.heldByOrderNo !== step.orderNo)
        throw new AbortError(`工位 ${step.station} 已被 ${st.heldByOrderNo} 占用`);
      st.heldByOrderNo = step.orderNo;
      orderOf(s, step.orderNo).station = step.station;
      return;
    }

    case "startOrder": {
      const o = orderOf(s, step.orderNo);
      if (o.status !== "released") throw new AbortError("工单未处于已放行状态");
      o.status = "running";
      o.startedAt = step.at;
      return;
    }

    case "completeOrder": {
      const o = orderOf(s, step.orderNo);
      if (o.status !== "running") throw new AbortError("工单不在加工中");
      if (o.beltNo) beltOf(s, o.beltNo).heldByOrderNo = null;
      if (o.station) {
        const st = s.stations.find((x) => x.code === o.station);
        if (st) st.heldByOrderNo = null;
      }
      o.status = "done";
      o.postGrindMm = step.postGrindMm;
      o.finishedAt = step.at;
      o.beltNo = null;
      o.station = null;
      const ski = skiOf(s, o.skiNo);
      ski.baseThicknessMm = step.postGrindMm;
      return;
    }

    case "reportDamage": {
      const ski = skiOf(s, step.skiNo);
      ski.damage = [...ski.damage, step.damage];
      ski.profileVersion += 1;
      voidReleaseForUnfinished(s, step.skiNo, "底板新增损伤，需重新测量", step.damage.at);
      return;
    }

    case "authorizeThickness": {
      const ski = skiOf(s, step.skiNo);
      ski.authorizations = [...ski.authorizations, step.auth];
      ski.baseThicknessMm = step.auth.toMm;
      ski.profileVersion += 1;
      voidReleaseForUnfinished(s, step.skiNo, "客户授权厚度变化，需重新测量", step.auth.at);
      // 授权改厚后旧测量作废，未完工工单回到测量
      for (const o of s.orders) {
        if (o.skiNo === step.skiNo && o.status !== "done") o.preGrindMm = null;
      }
      return;
    }

    case "applyMeasurement": {
      const m = step.measurement;
      const ski = skiOf(s, m.skiNo);
      ski.baseThicknessMm = m.thicknessMm;
      for (const o of s.orders) {
        if (o.skiNo !== m.skiNo || o.status === "done") continue;
        if (o.status === "running") continue; // 加工中不回改
        o.preGrindMm = m.thicknessMm;
        o.lastMeasureAt = m.at;
        if (o.status === "unmeasured") o.status = "measured";
        // 新测量使旧放行失效（releaseOrder 的快照对不上即被闸门拦截，这里同步标记）
        if (o.release && !o.release.voided) {
          o.release = { ...o.release, voided: true, voidReason: "重新测量，厚度已更新" };
        }
        if (o.status === "released") o.status = "measured";
      }
      return;
    }
  }
}

// 把一笔交易的每一步渲染成流水行（提交后才可见为 committed / rejected）
export function ledgerRowFor(step: Step, txnId: string, at: number): import("./types").LedgerRow {
  const base = { stepId: step.id, txnId, at };
  switch (step.kind) {
    case "ledgerReject":
      return { ...base, op: step.op, status: "rejected", detail: step.detail, orderNo: step.orderNo, skiNo: step.skiNo, beltNo: step.beltNo, station: step.station };
    case "releaseOrder":
      return { ...base, op: "主管放行", status: "committed", detail: `${step.by} 放行，绑定砂带 ${step.beltNo}`, orderNo: step.orderNo, beltNo: step.beltNo };
    case "claimBelt":
      return { ...base, op: "领取砂带", status: "committed", detail: `砂带 ${step.beltNo} 由本侧领取（CAS v${step.expectVersion}）`, orderNo: step.orderNo, beltNo: step.beltNo };
    case "consumeBelt":
      return { ...base, op: "砂带耗用", status: "committed", detail: `耗用砂带寿命 ${step.mm}mm`, orderNo: step.orderNo, beltNo: step.beltNo };
    case "occupyStation":
      return { ...base, op: "占用工位", status: "committed", detail: `占用工位 ${step.station}`, orderNo: step.orderNo, station: step.station };
    case "startOrder":
      return { ...base, op: "开工", status: "committed", detail: "校验通过，开工磨削", orderNo: step.orderNo };
    case "completeOrder":
      return { ...base, op: "完工", status: "committed", detail: `磨后厚度 ${step.postGrindMm}mm，释放砂带与工位`, orderNo: step.orderNo };
    case "reportDamage":
      return { ...base, op: "底板损伤上报", status: "committed", detail: step.damage.note, skiNo: step.skiNo };
    case "authorizeThickness":
      return { ...base, op: "客户授权改厚", status: "committed", detail: `${step.auth.by}：${step.auth.fromMm}mm → ${step.auth.toMm}mm${step.auth.note ? "；" + step.auth.note : ""}`, skiNo: step.skiNo };
    case "applyMeasurement":
      return { ...base, op: step.measurement.client.startsWith("PAD") ? "离线测量回网" : "在线测量", status: "committed", detail: `${step.measurement.client} 测得 ${step.measurement.thicknessMm}mm`, skiNo: step.measurement.skiNo };
  }
}
