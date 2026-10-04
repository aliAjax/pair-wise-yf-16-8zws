// 雪板磨底放行账 —— 状态管理（useReducer + localStorage 持久化）
import { useCallback, useEffect, useReducer } from "react";
import type { LedgerEvent, LedgerState, LedgerStep } from "./types";
import {
  initialState,
  invalidateReleases,
  mergeOfflineMeasurements,
  postStep,
  uid,
  validateStart,
  WORKSTATIONS,
} from "./ledger";

const STORAGE_KEY = "ski-base-grind-ledger-v1";

export type Action =
  | { type: "RELEASE_ORDER"; orderId: string }
  | { type: "START_ORDER"; orderId: string; workstation: string }
  | { type: "FINISH_ORDER"; orderId: string }
  | { type: "ADD_DAMAGE"; boardId: string; description: string }
  | { type: "AUTHORIZE_THICKNESS"; boardId: string; newThickness: number }
  | { type: "RECORD_MEASUREMENT"; boardId: string; thickness: number }
  | { type: "GO_ONLINE" }
  | { type: "GO_OFFLINE" }
  | { type: "CLAIM_BELT"; beltId: string; workstation: string }
  | { type: "SIMULTANEOUS_CLAIM"; beltId: string }
  | { type: "RETRY_PENDING_STEPS" }
  | { type: "TOGGLE_INJECT_FAILURE" }
  | { type: "RESET" };

function loadState(): LedgerState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as LedgerState;
  } catch {
    /* ignore */
  }
  return initialState();
}

function pushEvent(state: LedgerState, message: string, type: LedgerEvent["type"]): LedgerState {
  return {
    ...state,
    events: [{ id: uid("evt"), time: Date.now(), message, type }, ...state.events].slice(0, 80),
  };
}

function reducer(state: LedgerState, action: Action): LedgerState {
  switch (action.type) {
    case "RESET":
      return pushEvent(initialState(), "已重置全部演示数据", "warn");

    case "TOGGLE_INJECT_FAILURE": {
      const next = !state.injectFailure;
      return pushEvent(
        { ...state, injectFailure: next },
        next ? "已开启写入故障注入：下次入账将失败，可演示只重试未入账步骤" : "已关闭写入故障注入",
        next ? "warn" : "info"
      );
    }

    case "RELEASE_ORDER": {
      const order = state.orders.find((o) => o.id === action.orderId);
      if (!order || (order.status !== "measuring" && order.status !== "rejected")) return state;
      const board = state.boards.find((b) => b.id === order.boardId);
      const next: LedgerState = {
        ...state,
        orders: state.orders.map((o) =>
          o.id === action.orderId
            ? {
                ...o,
                status: "released",
                rejectReason: null,
                release: {
                  supervisor: state.supervisor,
                  boardRevision: board!.revision,
                  releasedAt: Date.now(),
                },
              }
            : o
        ),
      };
      return pushEvent(
        next,
        `${order.id} 主管放行（依据档案 v${board!.revision}）`,
        "success"
      );
    }

    case "START_ORDER": {
      const order = state.orders.find((o) => o.id === action.orderId);
      if (!order) return state;
      const board = state.boards.find((b) => b.id === order.boardId)!;
      // 砂带 = 本工位领取的那批
      const belt = state.belts.find((b) => b.workstation === action.workstation);
      const validation = validateStart(
        { ...order, workstation: action.workstation },
        board,
        belt,
        state.ledger
      );

      if (!validation.ok) {
        // 拒绝开工：工位与耗用都不变
        const next: LedgerState = {
          ...state,
          orders: state.orders.map((o) =>
            o.id === action.orderId
              ? { ...o, status: "rejected", rejectReason: validation.reason! }
              : o
          ),
        };
        return pushEvent(
          next,
          `${order.id} 拒绝开工：${validation.reason}（工位与耗用不变）`,
          "error"
        );
      }

      // 校验通过：分配工位，入账耗用步骤（幂等）
      const stepId = `${order.id}:consume`;
      let step = state.ledger.find((s) => s.id === stepId);
      let belts = state.belts;
      let ledger = state.ledger;
      if (!step) {
        step = {
          id: stepId,
          orderId: order.id,
          boardId: order.boardId,
          beltId: belt!.id,
          workstation: action.workstation,
          kind: "consume",
          amount: order.requiredBeltLife,
          status: "pending",
          createdAt: Date.now(),
        };
        ledger = [...state.ledger, step];
      }
      const posted = postStep(step, belts, state.injectFailure);
      belts = posted.belts;
      ledger = ledger.map((s) => (s.id === stepId ? posted.step : s));

      const next: LedgerState = {
        ...state,
        belts,
        ledger,
        orders: state.orders.map((o) =>
          o.id === action.orderId
            ? { ...o, status: "in-progress", workstation: action.workstation, rejectReason: null }
            : o
        ),
      };
      if (posted.step.status === "posted") {
        return pushEvent(
          next,
          `${order.id} 开工：工位 ${action.workstation}，砂带 ${belt!.id} 耗用 ${order.requiredBeltLife} 已入账`,
          "success"
        );
      }
      return pushEvent(
        next,
        `${order.id} 开工但耗用入账失败（${posted.step.error}），可重试未入账步骤`,
        "warn"
      );
    }

    case "FINISH_ORDER": {
      const order = state.orders.find((o) => o.id === action.orderId);
      if (!order || order.status !== "in-progress") return state;
      const pending = state.ledger.filter(
        (s) => s.orderId === order.id && s.status !== "posted"
      );
      if (pending.length > 0) {
        return pushEvent(
          state,
          `${order.id} 存在 ${pending.length} 个未入账步骤，不能完工，请先重试入账`,
          "error"
        );
      }
      const next: LedgerState = {
        ...state,
        orders: state.orders.map((o) => (o.id === action.orderId ? { ...o, status: "done" } : o)),
      };
      return pushEvent(next, `${order.id} 完工`, "success");
    }

    case "ADD_DAMAGE": {
      const board = state.boards.find((b) => b.id === action.boardId);
      if (!board) return state;
      const next: LedgerState = {
        ...state,
        boards: state.boards.map((b) =>
          b.id === action.boardId
            ? {
                ...b,
                damages: [
                  ...b.damages,
                  { id: uid("dmg"), description: action.description, createdAt: Date.now() },
                ],
                revision: b.revision + 1,
              }
            : b
        ),
        orders: invalidateReleases(state.orders, action.boardId),
      };
      return pushEvent(
        next,
        `${board.id} 新增损伤「${action.description}」，档案 v${board.revision} → v${board.revision + 1}，未完工工单放行失效回到测量`,
        "warn"
      );
    }

    case "AUTHORIZE_THICKNESS": {
      const board = state.boards.find((b) => b.id === action.boardId);
      if (!board) return state;
      const next: LedgerState = {
        ...state,
        boards: state.boards.map((b) =>
          b.id === action.boardId
            ? { ...b, baseThickness: action.newThickness, revision: b.revision + 1 }
            : b
        ),
        orders: invalidateReleases(state.orders, action.boardId),
      };
      return pushEvent(
        next,
        `${board.id} 客户授权厚度变更 ${board.baseThickness} → ${action.newThickness}mm，档案 v${board.revision} → v${board.revision + 1}，未完工工单放行失效回到测量`,
        "warn"
      );
    }

    case "RECORD_MEASUREMENT": {
      const board = state.boards.find((b) => b.id === action.boardId);
      if (!board) return state;
      if (state.online) {
        const next: LedgerState = {
          ...state,
          boards: state.boards.map((b) =>
            b.id === action.boardId
              ? { ...b, baseThickness: action.thickness, revision: b.revision + 1 }
              : b
          ),
          orders: invalidateReleases(state.orders, action.boardId),
        };
        return pushEvent(
          next,
          `${board.id} 在线测量厚度 ${action.thickness}mm，档案 v${board.revision} → v${board.revision + 1}，未完工工单放行失效回到测量`,
          "info"
        );
      }
      // 离线：只进队列，不入网、不改档案
      const rec = {
        id: uid("meas"),
        boardId: action.boardId,
        thickness: action.thickness,
        measuredAt: Date.now(),
        synced: false,
      };
      return pushEvent(
        { ...state, offlineQueue: [...state.offlineQueue, rec] },
        `${board.id} 离线测量 ${action.thickness}mm 已暂存，回网后按雪板号合并`,
        "info"
      );
    }

    case "GO_ONLINE": {
      if (state.online) return state;
      const merged = mergeOfflineMeasurements(state.offlineQueue);
      if (merged.size === 0) {
        return pushEvent({ ...state, online: true }, "已回网，无离线测量待合并", "info");
      }
      let boards = state.boards;
      let orders = state.orders;
      const parts: string[] = [];
      for (const [boardId, { thickness }] of merged) {
        const board = boards.find((b) => b.id === boardId);
        if (!board) continue;
        parts.push(`${boardId}→${thickness}mm`);
        boards = boards.map((b) =>
          b.id === boardId
            ? { ...b, baseThickness: thickness, revision: b.revision + 1 }
            : b
        );
        orders = invalidateReleases(orders, boardId);
      }
      const next: LedgerState = {
        ...state,
        online: true,
        boards,
        orders,
        offlineQueue: state.offlineQueue.map((m) => ({ ...m, synced: true })),
      };
      return pushEvent(
        next,
        `已回网，离线测量按雪板号合并 ${merged.size} 块：${parts.join("，")}`,
        "success"
      );
    }

    case "GO_OFFLINE":
      return pushEvent({ ...state, online: false }, "已切离线：测量暂存本地，不写入档案", "warn");

    case "CLAIM_BELT": {
      const belt = state.belts.find((b) => b.id === action.beltId);
      if (!belt) return state;
      if (belt.workstation && belt.workstation !== action.workstation) {
        return pushEvent(
          state,
          `${action.workstation} 领取 ${belt.id} 被拒：已被 ${belt.workstation} 领取（同批砂带只放行一侧）`,
          "error"
        );
      }
      const next: LedgerState = {
        ...state,
        belts: state.belts.map((b) =>
          b.id === action.beltId ? { ...b, workstation: action.workstation } : b
        ),
      };
      return pushEvent(next, `${action.workstation} 领取 ${belt.id}`, "success");
    }

    case "SIMULTANEOUS_CLAIM": {
      const belt = state.belts.find((b) => b.id === action.beltId);
      if (!belt) return state;
      if (belt.workstation) {
        return pushEvent(
          state,
          `模拟同时领取 ${belt.id}：已被 ${belt.workstation} 占用，两侧均拒绝`,
          "error"
        );
      }
      // 同一批次内 A、B 同时领取：只放行先到的 A 一侧
      const next: LedgerState = {
        ...state,
        belts: state.belts.map((b) =>
          b.id === action.beltId ? { ...b, workstation: WORKSTATIONS[0] } : b
        ),
      };
      return pushEvent(
        next,
        `模拟两台平板同时领取 ${belt.id}：仅 ${WORKSTATIONS[0]} 一侧放行，${WORKSTATIONS[1]} 一侧拒绝`,
        "warn"
      );
    }

    case "RETRY_PENDING_STEPS": {
      const pending = state.ledger.filter((s) => s.status !== "posted");
      if (pending.length === 0) {
        return pushEvent(state, "没有未入账步骤需要重试", "info");
      }
      let belts = state.belts;
      let ledger = state.ledger;
      let postedCount = 0;
      let failedCount = 0;
      for (const s of pending) {
        const res = postStep(s, belts, state.injectFailure);
        belts = res.belts;
        ledger = ledger.map((x) => (x.id === s.id ? res.step : x));
        if (res.step.status === "posted") postedCount += 1;
        else failedCount += 1;
      }
      const next: LedgerState = { ...state, belts, ledger };
      if (failedCount === 0) {
        return pushEvent(next, `重试 ${pending.length} 个未入账步骤：全部入账成功`, "success");
      }
      return pushEvent(
        next,
        `重试 ${pending.length} 个未入账步骤：${postedCount} 个入账，${failedCount} 个仍失败（只重试未入账步骤）`,
        "warn"
      );
    }

    default:
      return state;
  }
}

export function useLedger() {
  const [state, dispatch] = useReducer(reducer, undefined, loadState);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state]);

  const reset = useCallback(() => dispatch({ type: "RESET" }), []);
  return { state, dispatch, reset };
}
