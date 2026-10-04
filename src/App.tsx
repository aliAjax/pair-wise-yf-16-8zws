import { useState, type Dispatch } from "react";
import "./styles.css";
import { useLedger, type Action } from "./store";
import type { LedgerState, OrderStatus } from "./types";
import { WORKSTATIONS, availableBeltLife, isReleaseValid } from "./ledger";

const STATUS_LABEL: Record<OrderStatus, string> = {
  measuring: "测量中",
  released: "已放行",
  "in-progress": "开工中",
  done: "完工",
  rejected: "被拒绝",
};

const STATUS_COLOR: Record<OrderStatus, string> = {
  measuring: "#64748b",
  released: "#0369a1",
  "in-progress": "#f97316",
  done: "#16a34a",
  rejected: "#dc2626",
};

function fmtTime(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function BoardCard({
  state,
  dispatch,
  boardId,
}: {
  state: LedgerState;
  dispatch: Dispatch<Action>;
  boardId: string;
}) {
  const board = state.boards.find((b) => b.id === boardId)!;
  const thicknessOk = board.baseThickness - 0 >= board.safetyThickness;
  const [damage, setDamage] = useState("");
  const [thickness, setThickness] = useState("");

  return (
    <article className="card">
      <div className="card-head">
        <div>
          <strong>{board.id}</strong>
          <span className="muted">
            {" "}
            · {board.brand} {board.length} · {board.model}
          </span>
        </div>
        <span className="badge" style={{ background: "#eef2ff", color: "#4338ca" }}>
          档案 v{board.revision}
        </span>
      </div>
      <div className="thickness-row">
        <div>
          <small>底板厚度</small>
          <strong className={thicknessOk ? "" : "danger"}>{board.baseThickness.toFixed(2)} mm</strong>
        </div>
        <div>
          <small>安全厚度</small>
          <strong>≥ {board.safetyThickness.toFixed(2)} mm</strong>
        </div>
        <div>
          <small>损伤</small>
          <strong>{board.damages.length} 处</strong>
        </div>
      </div>
      {board.damages.length > 0 && (
        <ul className="damage-list">
          {board.damages.map((d) => (
            <li key={d.id}>{d.description}</li>
          ))}
        </ul>
      )}
      <div className="inline-actions">
        <input
          placeholder="新增损伤描述"
          value={damage}
          onChange={(e) => setDamage(e.target.value)}
        />
        <button
          onClick={() => {
            if (damage.trim()) {
              dispatch({ type: "ADD_DAMAGE", boardId, description: damage.trim() });
              setDamage("");
            }
          }}
        >
          新增损伤
        </button>
      </div>
      <div className="inline-actions">
        <input
          placeholder="授权厚度 (mm)"
          inputMode="decimal"
          value={thickness}
          onChange={(e) => setThickness(e.target.value)}
        />
        <button
          onClick={() => {
            const v = parseFloat(thickness);
            if (!Number.isNaN(v)) {
              dispatch({ type: "AUTHORIZE_THICKNESS", boardId, newThickness: v });
              setThickness("");
            }
          }}
        >
          客户授权改厚度
        </button>
      </div>
    </article>
  );
}

function BeltCard({
  state,
  dispatch,
  beltId,
}: {
  state: LedgerState;
  dispatch: Dispatch<Action>;
  beltId: string;
}) {
  const belt = state.belts.find((b) => b.id === beltId)!;
  const avail = availableBeltLife(belt, state.ledger);
  const low = avail <= 20;
  return (
    <article className="card">
      <div className="card-head">
        <div>
          <strong>{belt.id}</strong>
          <span className="muted"> · 总寿命 {belt.totalLife}</span>
        </div>
        {belt.workstation ? (
          <span className="badge" style={{ background: "#fef3c7", color: "#b45309" }}>
            {belt.workstation} 占用中
          </span>
        ) : (
          <span className="badge" style={{ background: "#dcfce7", color: "#16a34a" }}>
            空闲
          </span>
        )}
      </div>
      <div className="thickness-row">
        <div>
          <small>剩余寿命</small>
          <strong>{belt.remainingLife}</strong>
        </div>
        <div>
          <small>可用(含未入账占用)</small>
          <strong className={low ? "danger" : ""}>{avail}</strong>
        </div>
      </div>
      <div className="inline-actions">
        {WORKSTATIONS.map((ws) => (
          <button
            key={ws}
            onClick={() => dispatch({ type: "CLAIM_BELT", beltId, workstation: ws })}
          >
            {ws} 领取
          </button>
        ))}
        <button
          className="ghost"
          onClick={() => dispatch({ type: "SIMULTANEOUS_CLAIM", beltId })}
        >
          模拟两台同时领取
        </button>
      </div>
    </article>
  );
}

function OrderCard({
  state,
  dispatch,
  orderId,
}: {
  state: LedgerState;
  dispatch: Dispatch<Action>;
  orderId: string;
}) {
  const order = state.orders.find((o) => o.id === orderId)!;
  const board = state.boards.find((b) => b.id === order.boardId)!;
  const releaseValid = isReleaseValid(order, board);
  const afterGrind = board.baseThickness - order.plannedGrindAmount;

  return (
    <article className="card">
      <div className="card-head">
        <div>
          <strong>{order.id}</strong>
          <span className="muted">
            {" "}
            · {order.boardId} · {order.targetEdgeAngle}
          </span>
        </div>
        <span
          className="badge"
          style={{ background: `${STATUS_COLOR[order.status]}1a`, color: STATUS_COLOR[order.status] }}
        >
          {STATUS_LABEL[order.status]}
        </span>
      </div>
      <div className="thickness-row">
        <div>
          <small>计划磨削</small>
          <strong>{order.plannedGrindAmount.toFixed(2)} mm</strong>
        </div>
        <div>
          <small>磨后厚度</small>
          <strong className={afterGrind < board.safetyThickness ? "danger" : ""}>
            {afterGrind.toFixed(2)} mm
          </strong>
        </div>
        <div>
          <small>需求寿命</small>
          <strong>{order.requiredBeltLife}</strong>
        </div>
        <div>
          <small>工位</small>
          <strong>{order.workstation ?? "—"}</strong>
        </div>
      </div>

      {order.status === "released" && !releaseValid && (
        <p className="warn-note">放行依据档案 v{order.release?.boardRevision}，当前 v{board.revision}，放行已失效</p>
      )}
      {order.status === "rejected" && order.rejectReason && (
        <p className="error-note">拒绝开工：{order.rejectReason}（工位与耗用不变）</p>
      )}
      {order.status === "released" && releaseValid && (
        <p className="ok-note">
          主管放行有效（v{order.release?.boardRevision}），开工前校验磨后厚度与砂带寿命
        </p>
      )}

      <div className="inline-actions">
        {order.status === "measuring" && (
          <button
            className="primary"
            onClick={() => dispatch({ type: "RELEASE_ORDER", orderId })}
          >
            主管放行
          </button>
        )}
        {order.status === "released" && (
          <>
            {WORKSTATIONS.map((ws) => (
              <button
                key={ws}
                className="primary"
                onClick={() => dispatch({ type: "START_ORDER", orderId, workstation: ws })}
              >
                开工 @ {ws}
              </button>
            ))}
          </>
        )}
        {order.status === "in-progress" && (
          <button
            className="primary"
            onClick={() => dispatch({ type: "FINISH_ORDER", orderId })}
          >
            完工
          </button>
        )}
        {order.status === "rejected" && (
          <button
            onClick={() => dispatch({ type: "RELEASE_ORDER", orderId })}
          >
            重新放行
          </button>
        )}
      </div>
    </article>
  );
}

function App() {
  const { state, dispatch, reset } = useLedger();
  const [measBoard, setMeasBoard] = useState(state.boards[0]?.id ?? "");
  const [measThickness, setMeasThickness] = useState("");

  const measuringCount = state.orders.filter((o) => o.status === "measuring").length;
  const inProgressCount = state.orders.filter((o) => o.status === "in-progress").length;
  const doneCount = state.orders.filter((o) => o.status === "done").length;
  const pendingSteps = state.ledger.filter((s) => s.status !== "posted").length;

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62004 · 雪板磨底放行账</p>
        <h1>磨底放行账</h1>
        <span>
          雪板档案、磨板工单、砂带批次一本账：开工前按磨前厚度、计划磨削量与砂带剩余寿命校验，
          低于安全厚度或寿命不足即拒绝开工，工位与耗用都不变。
        </span>
      </section>

      <section className="metrics">
        <article>
          <small>待维护 / 测量</small>
          <strong>{measuringCount}</strong>
        </article>
        <article>
          <small>开工中</small>
          <strong>{inProgressCount}</strong>
        </article>
        <article>
          <small>完工工单</small>
          <strong>{doneCount}</strong>
        </article>
        <article>
          <small>未入账步骤</small>
          <strong className={pendingSteps > 0 ? "danger" : ""}>{pendingSteps}</strong>
        </article>
      </section>

      <section className="panel control-bar">
        <div className="control-group">
          <span className={`badge ${state.online ? "online" : "offline"}`}>
            {state.online ? "在线" : "离线"}
          </span>
          {!state.online && (
            <button className="primary" onClick={() => dispatch({ type: "GO_ONLINE" })}>
              回网合并测量 ({state.offlineQueue.filter((m) => !m.synced).length})
            </button>
          )}
          <button onClick={() => dispatch({ type: state.online ? "GO_OFFLINE" : "GO_ONLINE" })}>
            {state.online ? "切离线" : "回网"}
          </button>
        </div>
        <div className="control-group">
          <button
            className={state.injectFailure ? "danger-btn" : ""}
            onClick={() => dispatch({ type: "TOGGLE_INJECT_FAILURE" })}
          >
            {state.injectFailure ? "故障注入：开" : "故障注入：关"}
          </button>
          <button onClick={reset}>重置演示</button>
        </div>
      </section>

      <section className="workspace">
        <div className="stack">
          <h2 className="section-title">雪板档案</h2>
          {state.boards.map((b) => (
            <BoardCard key={b.id} state={state} dispatch={dispatch} boardId={b.id} />
          ))}

          <h2 className="section-title">离线测量（回网按雪板号合并）</h2>
          <article className="card">
            <div className="inline-actions">
              <select value={measBoard} onChange={(e) => setMeasBoard(e.target.value)}>
                {state.boards.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.id}
                  </option>
                ))}
              </select>
              <input
                placeholder="厚度 (mm)"
                inputMode="decimal"
                value={measThickness}
                onChange={(e) => setMeasThickness(e.target.value)}
              />
              <button
                onClick={() => {
                  const v = parseFloat(measThickness);
                  if (!Number.isNaN(v) && measBoard) {
                    dispatch({ type: "RECORD_MEASUREMENT", boardId: measBoard, thickness: v });
                    setMeasThickness("");
                  }
                }}
              >
                记录测量
              </button>
            </div>
            {state.offlineQueue.length === 0 ? (
              <p className="muted">暂无离线测量记录</p>
            ) : (
              <ul className="damage-list">
                {state.offlineQueue.map((m) => (
                  <li key={m.id}>
                    {m.boardId} · {m.thickness.toFixed(2)}mm · {fmtTime(m.measuredAt)} ·{" "}
                    {m.synced ? "已合并" : "待回网"}
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>

        <div className="stack">
          <h2 className="section-title">磨板工单</h2>
          {state.orders.map((o) => (
            <OrderCard key={o.id} state={state} dispatch={dispatch} orderId={o.id} />
          ))}

          <h2 className="section-title">砂带批次</h2>
          {state.belts.map((b) => (
            <BeltCard key={b.id} state={state} dispatch={dispatch} beltId={b.id} />
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>放行账</p>
            <h2>耗用入账步骤</h2>
          </div>
          <button
            className={pendingSteps > 0 ? "primary" : ""}
            onClick={() => dispatch({ type: "RETRY_PENDING_STEPS" })}
            disabled={pendingSteps === 0}
          >
            重试未入账步骤 ({pendingSteps})
          </button>
        </div>
        {state.ledger.length === 0 ? (
          <p className="muted">暂无入账步骤（开工后生成耗用步骤）</p>
        ) : (
          <div className="records">
            {state.ledger.map((s) => (
              <article key={s.id}>
                <b
                  style={{
                    background:
                      s.status === "posted"
                        ? "linear-gradient(135deg,#16a34a,#15803d)"
                        : s.status === "failed"
                          ? "linear-gradient(135deg,#dc2626,#b91c1c)"
                          : "linear-gradient(135deg,#f97316,#ea580c)",
                  }}
                >
                  {s.status === "posted" ? "已入账" : s.status === "failed" ? "失败" : "待入账"}
                </b>
                <div>
                  <h3>
                    {s.orderId} · {s.beltId} · {s.workstation}
                  </h3>
                  <p>
                    耗用 {s.amount} · {s.kind}
                    {s.postedAt ? ` · ${fmtTime(s.postedAt)} 入账` : ""}
                    {s.error ? ` · ${s.error}` : ""}
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>事件日志</p>
            <h2>账台动态</h2>
          </div>
        </div>
        <ul className="event-log">
          {state.events.map((e) => (
            <li key={e.id} className={`event-${e.type}`}>
              <span className="muted">{fmtTime(e.time)}</span> {e.message}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

export default App;
