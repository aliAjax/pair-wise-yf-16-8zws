import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import "./styles.css";
import {
  checkGate,
  planAuthorize,
  planComplete,
  planDamage,
  planMeasure,
  planOfflineMerge,
  planRelease,
  planStart,
} from "./domain/engine";
import { store } from "./domain/store";
import type { Measurement, OrderStatus, PlanResult, State } from "./domain/types";

function useStoreVersion(): number {
  return useSyncExternalStore(
    (l) => store.subscribe(l),
    () => store.getVersion()
  );
}

function useStateSnapshot(): State {
  useStoreVersion();
  return store.state;
}

type Planner = (s: State) => PlanResult | null;

const STATUS_TEXT: Record<OrderStatus, string> = {
  unmeasured: "待测量",
  measured: "已测量·待放行",
  released: "已放行",
  running: "加工中",
  done: "已完工",
};

const STATUS_CLASS: Record<OrderStatus, string> = {
  unmeasured: "st-gray",
  measured: "st-amber",
  released: "st-teal",
  running: "st-blue",
  done: "st-green",
};

type Toast = { kind: "ok" | "err" | "reject"; text: string } | null;

export default function App() {
  useStoreVersion();
  const state = store.state;
  const ledger = store.ledger;
  const txns = store.txns;
  const queue = store.queue;
  const pending = store.pending;
  const [toast, setToast] = useState<Toast>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  function notify(t: Toast) {
    setToast(t);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 5200);
  }

  const metrics = useMemo(() => {
    const running = state.orders.filter((o) => o.status === "running").length;
    const done = state.orders.filter((o) => o.status === "done").length;
    const unsafe = state.orders.filter((o) => {
      const ski = state.skis.find((s) => s.skiNo === o.skiNo);
      return ski && o.preGrindMm != null && o.preGrindMm - o.planGrindMm < ski.safetyThicknessMm;
    }).length;
    const heldBelts = state.belts.filter((b) => b.heldByOrderNo).length;
    return { running, done, unsafe, heldBelts };
  }, [state]);

  async function run(opType: string, planner: Planner, opts?: { queueAfter?: Measurement[] }) {
    const r = await store.runTxn(opType, planner, opts);
    if (r.rejected) notify({ kind: "reject", text: `已拒绝开工并写入拒绝账：${r.rejected}` });
    else if (r.ok) notify({ kind: "ok", text: `${opType} 已入账${r.txnId ? `（${r.txnId}）` : ""}` });
    else notify({ kind: "err", text: r.error ?? "操作失败" });
  }

  return (
    <main className="app">
      <section className="hero">
        <p>放行账 · 雪板档案 × 磨板工单 × 砂带批次 · Port 62004</p>
        <h1>磨底开工联检台</h1>
        <span>
          开工前同时校验<b>磨前厚度 / 计划磨削量 / 安全厚度 / 砂带剩余寿命 / 工位占用 / 放行快照</b>。
          刃角仅作参考，厚度与寿命不过关一律拒绝开工，工位与耗用不变。
        </span>
        <div className="metric-row">
          <div><small>加工中</small><strong>{metrics.running}</strong></div>
          <div><small>已完工</small><strong>{metrics.done}</strong></div>
          <div><small>厚度不安全单</small><strong className={metrics.unsafe ? "warn" : ""}>{metrics.unsafe}</strong></div>
          <div><small>被领用砂带</small><strong>{metrics.heldBelts}</strong></div>
        </div>
      </section>

      {pending && (
        <section className="panel banner">
          <div>
            <b>检测到写了一半的交易（{pending.txnId}）</b>
            <p>
              已入账 {pending.cursor}/{pending.steps.length} 步。系统保证不重放已入账步骤，
              只重试从第 {pending.cursor + 1} 步起的未入账动作。
            </p>
          </div>
          <button className="primary" onClick={() => store.retryPending().then((r) =>
            notify(r.ok ? { kind: "ok", text: "未入账步骤已补录完成" } : { kind: "err", text: r.error! }))}>
            只重试未入账步骤
          </button>
        </section>
      )}

      {toast && (
        <div className={`toast toast-${toast.kind}`}>
          {toast.kind === "ok" ? "✅ " : toast.kind === "reject" ? "⛔ " : "⚠️ "}
          {toast.text}
        </div>
      )}

      <section className="workspace">
        <div className="col">
          <section className="panel">
            <div className="heading">
              <div><p>工单 × 雪板档案</p><h2>磨板工单</h2></div>
            </div>
            <div className="cards">
              {state.orders.map((o) => {
                const ski = state.skis.find((s) => s.skiNo === o.skiNo)!;
                const after = o.preGrindMm != null ? o.preGrindMm - o.planGrindMm : null;
                const thicknessBlocked = after != null && after < ski.safetyThicknessMm;
                const gateHint =
                  o.status === "released" && o.release
                    ? checkGate({ state, orderNo: o.orderNo, beltNo: o.release.beltNo, station: "ST-A" })
                    : null;
                return (
                  <article key={o.orderNo} className="card">
                    <header>
                      <div>
                        <h3>{o.orderNo} <span className="muted">{ski.skiNo} · {ski.brand}</span></h3>
                        <p className="muted small">
                          板型 {ski.shape} · 长度 {ski.lengthCm}cm · 刃角目标（参考）：{o.edgeTarget}
                        </p>
                      </div>
                      <span className={`tag ${STATUS_CLASS[o.status]}`}>{STATUS_TEXT[o.status]}</span>
                    </header>

                    <div className="kv-grid">
                      <div><small>磨前厚度</small><b>{o.preGrindMm == null ? "—" : `${o.preGrindMm} mm`}</b></div>
                      <div><small>计划磨削</small><b>{o.planGrindMm} mm</b></div>
                      <div><small>磨后预计</small>
                        <b className={thicknessBlocked ? "warn" : ""}>
                          {after == null ? "—" : `${after.toFixed(2)} mm`}
                        </b>
                      </div>
                      <div><small>安全厚度</small><b>{ski.safetyThicknessMm} mm</b></div>
                      <div><small>已耗砂带</small><b>{o.consumedLifeMm} mm</b></div>
                      <div><small>砂带/工位</small><b>{o.beltNo ?? "—"} / {o.station ?? "—"}</b></div>
                    </div>

                    {thicknessBlocked && (
                      <p className="flag">⛔ 安全厚度不足：磨后将低于 {ski.safetyThicknessMm}mm，即使刃角达标也不能放行/开工</p>
                    )}
                    {o.release && (
                      <p className={`flag ${o.release.voided ? "flag-void" : "flag-ok"}`}>
                        {o.release.voided ? "🚫 放行已失效" : "🟢 主管放行有效"}：{o.release.by} · 绑 {o.release.beltNo} ·
                        快照厚度 {o.release.preGrindMm}mm · 底板版本 v{o.release.profileVersion}
                        {o.release.voided && `（原因：${o.release.voidReason}）`}
                      </p>
                    )}
                    {gateHint && o.status === "released" && (
                      <p className="flag">当前预检：{gateHint.message}</p>
                    )}

                    <OrderActions
                      orderNo={o.orderNo}
                      status={o.status}
                      run={run}
                    />
                  </article>
                );
              })}
            </div>
          </section>

          <ConcurrentDemo />
        </div>

        <div className="col">
          <section className="panel">
            <div className="heading">
              <div><p>砂带批次</p><h2>砂带寿命与持有</h2></div>
            </div>
            <table className="data">
              <thead><tr><th>批次</th><th>粒度</th><th>剩余寿命</th><th>版本</th><th>持有方</th></tr></thead>
              <tbody>
                {state.belts.map((b) => (
                  <tr key={b.beltNo} className={b.heldByOrderNo ? "row-held" : b.remainingLifeMm < 0.5 ? "row-low" : ""}>
                    <td>{b.beltNo}</td>
                    <td>{b.grit}</td>
                    <td>{b.remainingLifeMm} mm</td>
                    <td>v{b.version}</td>
                    <td>{b.heldByOrderNo ?? <span className="muted">空闲</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">同一砂带同一时刻只允许一侧持有；领取走 CAS 乐观锁，两台平板并发时先到者得、后到者拒绝。</p>
          </section>

          <section className="panel">
            <div className="heading"><div><p>雪板档案</p><h2>厚度 / 损伤 / 客户授权</h2></div></div>
            {state.skis.map((s) => (
              <div key={s.skiNo} className="profile">
                <header>
                  <b>{s.skiNo} · {s.brand}</b>
                  <span className="tag st-gray">底板版本 v{s.profileVersion}</span>
                </header>
                <p className="small muted">
                  当前底板厚 <b>{s.baseThicknessMm}mm</b> · 安全下限 {s.safetyThicknessMm}mm · 蜡型 {s.waxType} · 偏好：{s.customerPref}
                </p>
                <ul className="damage-list">
                  {s.damage.map((d) => <li key={d.id}>🔧 {d.note}</li>)}
                  {s.authorizations.map((a) => (
                    <li key={a.id}>✍️ {a.by} 授权 {a.fromMm}mm → {a.toMm}mm{a.note ? `（${a.note}）` : ""}</li>
                  ))}
                </ul>
                <div className="inline-forms">
                  <DamageForm skiNo={s.skiNo} run={run} />
                  <AuthForm skiNo={s.skiNo} run={run} />
                  <OnlineMeasure skiNo={s.skiNo} run={run} />
                </div>
              </div>
            ))}
            <p className="muted small">
              新增底板损伤或客户授权的厚度变化会抬升底板版本：该雪板所有<b>未完工</b>工单的主管放行立即失效、退回测量；已完工工单不受影响。
            </p>
          </section>

          <OfflinePanel queue={queue} run={run} />

          <section className="panel">
            <div className="heading">
              <div><p>持久化与故障</p><h2>写入失败演练</h2></div>
            </div>
            <div className="btn-row">
              <button
                className={store.failNextWrite ? "danger armed" : "danger"}
                onClick={() => { store.failNextWrite = true; notify({ kind: "err", text: "已安排：下一次落账写入将失败（只失败一步）" }); }}
              >
                安排下一次写入失败
              </button>
              <button onClick={() => { store.resetAll(); notify({ kind: "ok", text: "已重置为初始档案" }); }}>
                重置全部数据
              </button>
            </div>
            <p className="muted small">
              每步落账为一次原子写入；写失败时内存回滚到上一耐久快照，只把未入账步骤挂起。重试时按步骤幂等键（stepId）跳过已入账动作。
            </p>
          </section>
        </div>
      </section>

      <section className="workspace ledger-section">
        <section className="panel">
          <div className="heading">
            <div><p>流水不可重放</p><h2>放行账</h2></div>
            <span className="muted small">共 {ledger.length} 条 · 最近在前</span>
          </div>
          <div className="ledger">
            {ledger.length === 0 && <p className="muted">还没有流水。放行、拒绝、领用、耗用、测量都会落账。</p>}
            {ledger.map((r) => (
              <div key={r.stepId} className={`ledger-row ledger-${r.status}`}>
                <span className={`dot ${r.status}`} />
                <div className="ledger-main">
                  <b>{r.op}</b>
                  <p>{r.detail}</p>
                </div>
                <div className="ledger-meta">
                  <span>{[r.orderNo, r.skiNo, r.beltNo, r.station].filter(Boolean).join(" · ")}</span>
                  <small>{r.stepId.length > 46 ? r.stepId.slice(0, 46) + "…" : r.stepId}</small>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="heading"><div><p>交易</p><h2>事务与重试</h2></div></div>
          <table className="data">
            <thead><tr><th>交易号</th><th>操作</th><th>尝试</th><th>状态</th></tr></thead>
            <tbody>
              {txns.length === 0 && <tr><td colSpan={4} className="muted">暂无交易</td></tr>}
              {txns.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{t.id}</td>
                  <td>{t.opType}</td>
                  <td>{t.attempts}</td>
                  <td>
                    <span className={`tag txn-${t.status}`}>
                      {t.status === "committed" ? "已提交" : t.status === "pending" ? "挂起·待重试" : "已中止"}
                    </span>
                    {t.abortReason && <p className="small muted">{t.abortReason}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </section>
    </main>
  );
}

// ---------- 工单操作：主管放行 / 开工 / 完工 ----------

function OrderActions({
  orderNo,
  status,
  run,
}: {
  orderNo: string;
  status: OrderStatus;
  run: (op: string, p: Planner) => Promise<void>;
}) {
  const s = useStateSnapshot();
  const order = s.orders.find((o) => o.orderNo === orderNo)!;
  const [belt, setBelt] = useState("BT-08");
  const [station, setStation] = useState("ST-A");
  const [postMm, setPostMm] = useState("");

  return (
    <div className="actions">
      {(status === "measured") && (
        <div className="action-line">
          <label>主管放行，绑定砂带
            <select value={belt} onChange={(e) => setBelt(e.target.value)}>
              {s.belts.map((b) => <option key={b.beltNo} value={b.beltNo}>{b.beltNo}（余 {b.remainingLifeMm}mm）</option>)}
            </select>
          </label>
          <button className="primary" onClick={() =>
            run("主管放行", (st) => planRelease(st, { orderNo, by: "王主管", beltNo: belt }))}>
            主管放行
          </button>
        </div>
      )}
      {status === "released" && order.release && (
        <div className="action-line">
          <label>领取砂带（默认放行绑定 {order.release.beltNo}）
            <select value={belt} onChange={(e) => setBelt(e.target.value)}>
              {s.belts.map((b) => <option key={b.beltNo} value={b.beltNo}>{b.beltNo}</option>)}
            </select>
          </label>
          <label>工位
            <select value={station} onChange={(e) => setStation(e.target.value)}>
              {s.stations.map((st) => <option key={st.code} value={st.code}>{st.code} {st.name}</option>)}
            </select>
          </label>
          <button className="primary" onClick={() =>
            run("开工校验", (st) => planStart(st, { orderNo, beltNo: belt, station, client: "PAD-主控台" }))}>
            校验并开工
          </button>
        </div>
      )}
      {status === "running" && (
        <div className="action-line">
          <label>磨后实测厚度 mm
            <input value={postMm} placeholder="如 1.9" onChange={(e) => setPostMm(e.target.value)} />
          </label>
          <button onClick={() => {
            const v = Number(postMm);
            if (!v) return;
            run("完工入账", (st) => planComplete(st, orderNo, v));
          }}>按实测完工（扣砂带耗用）</button>
        </div>
      )}
    </div>
  );
}

// ---------- 两台平板同时领取同一砂带 ----------

function ConcurrentDemo() {
  const s = useStateSnapshot();
  const released = s.orders.filter((o) => o.status === "released");
  return (
    <section className="panel">
      <div className="heading">
        <div><p>并发场景</p><h2>两台平板同时领取同一砂带</h2></div>
      </div>
      <p className="muted small">
        选择两张「已放行且绑定同一砂带」的工单，两台平板（PAD-01 / PAD-02）同时点开工：
        请求串行落账，先到一侧完成砂带 CAS 领取，后到一侧在闸门处被拒并写拒绝账，<b>工位与耗用都不变</b>。
      </p>
      <div className="btn-row">
        {s.orders.map((o) => (
          <span key={o.orderNo} className={`chip ${o.status === "released" ? "" : "chip-off"}`}>
            {o.orderNo}：{o.status === "released" ? `放行绑 ${o.release!.beltNo}` : STATUS_TEXT[o.status]}
          </span>
        ))}
      </div>
      <div className="btn-row">
        <button
          className="primary"
          disabled={released.length < 2}
          onClick={async () => {
            const [a, b] = released;
            const freeStationFor = (orderNo: string) =>
              s.stations.find((st) => !st.heldByOrderNo || st.heldByOrderNo === orderNo)?.code ?? "ST-A";
            const ra = store.runTxn("开工校验·PAD-01", (st) =>
              planStart(st, { orderNo: a.orderNo, beltNo: a.release!.beltNo, station: freeStationFor(a.orderNo), client: "PAD-01" })
            );
            const rb = store.runTxn("开工校验·PAD-02", (st) =>
              planStart(st, { orderNo: b.orderNo, beltNo: b.release!.beltNo, station: freeStationFor(b.orderNo), client: "PAD-02" })
            );
            const [x, y] = await Promise.all([ra, rb]);
            const fail = [x, y].find((r) => r.rejected || !r.ok);
            const ok = [x, y].find((r) => r.ok && !r.rejected);
            if (fail?.rejected)
              return alert(`只放行一侧：\n通过侧：${ok?.txnId ?? "—"}\n拒绝侧：${fail.rejected}`);
            alert(`两侧均通过（说明绑定的不是同一条砂带或工位冲突）`);
          }}
        >
          PAD-01 与 PAD-02 同时开工（前两张已放行单）
        </button>
      </div>
    </section>
  );
}

// ---------- 档案操作表单 ----------

function DamageForm({ skiNo, run }: { skiNo: string; run: (op: string, p: Planner) => Promise<void> }) {
  const [note, setNote] = useState("");
  return (
    <div className="mini-form">
      <input placeholder="新增底板损伤，如：板刃旁深划痕 6cm" value={note} onChange={(e) => setNote(e.target.value)} />
      <button onClick={() => run("底板损伤上报", (s) => planDamage(s, skiNo, note)).then(() => setNote(""))}>
        上报损伤
      </button>
    </div>
  );
}

function AuthForm({ skiNo, run }: { skiNo: string; run: (op: string, p: Planner) => Promise<void> }) {
  const [by, setBy] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  return (
    <div className="mini-form">
      <input placeholder="客户/授权人" value={by} onChange={(e) => setBy(e.target.value)} />
      <input placeholder="授权后厚度 mm" value={to} onChange={(e) => setTo(e.target.value)} />
      <input placeholder="事由（如 P-Tex 修底）" value={note} onChange={(e) => setNote(e.target.value)} />
      <button onClick={() =>
        run("客户授权改厚", (s) => planAuthorize(s, skiNo, { by, toMm: Number(to), note }))
          .then(() => { setBy(""); setTo(""); setNote(""); })}>
        授权改厚
      </button>
    </div>
  );
}

function OnlineMeasure({ skiNo, run }: { skiNo: string; run: (op: string, p: Planner) => Promise<void> }) {
  const [mm, setMm] = useState("");
  return (
    <div className="mini-form">
      <input placeholder="在线测量厚度 mm" value={mm} onChange={(e) => setMm(e.target.value)} />
      <button onClick={() => run("在线测量", (s) => planMeasure(s, skiNo, Number(mm), "主控台")).then(() => setMm(""))}>
        在线测量
      </button>
    </div>
  );
}

// ---------- 离线测量：缓存 → 回网按雪板号合并 ----------

function OfflinePanel({
  queue,
  run,
}: {
  queue: Measurement[];
  run: (op: string, p: Planner, opts?: { queueAfter?: Measurement[] }) => Promise<void>;
}) {
  useStateSnapshot();
  const [skiNo, setSkiNo] = useState("SK-001");
  const [mm, setMm] = useState("");
  const [client, setClient] = useState("PAD-03");
  const [result, setResult] = useState<string>("");

  const grouped = queue.reduce<Record<string, Measurement[]>>((acc, m) => {
    (acc[m.skiNo] ??= []).push(m);
    return acc;
  }, {});

  return (
    <section className="panel">
      <div className="heading">
        <div><p>离线测量</p><h2>离网缓存 · 回网按雪板号合并</h2></div>
        <span className="muted small">待同步 {queue.length} 条</span>
      </div>
      <div className="action-line">
        <label>平板
          <select value={client} onChange={(e) => setClient(e.target.value)}>
            <option>PAD-03</option><option>PAD-04</option>
          </select>
        </label>
        <label>雪板号
          <select value={skiNo} onChange={(e) => setSkiNo(e.target.value)}>
            {store.state.skis.map((s) => <option key={s.skiNo} value={s.skiNo}>{s.skiNo}</option>)}
          </select>
        </label>
        <label>测得厚度 mm
          <input value={mm} onChange={(e) => setMm(e.target.value)} placeholder="如 2.05" />
        </label>
        <button onClick={() => {
          const v = Number(mm);
          if (!(v > 0)) return;
          store.enqueueOffline({
            id: `MSR-OFF-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            skiNo, thicknessMm: v, at: Date.now(), client, valid: true,
          });
          setMm("");
        }}>离网暂存一条</button>
      </div>

      {Object.entries(grouped).length > 0 && (
        <div className="queue-box">
          {Object.entries(grouped).map(([no, arr]) => (
            <span key={no} className="chip">
              {no}：{arr.length} 条（最晚 {Math.max(...arr.map((m) => m.thicknessMm))}mm 级别）
            </span>
          ))}
        </div>
      )}

      <div className="btn-row">
        <button className="primary" disabled={queue.length === 0} onClick={async () => {
          // 按雪板号合并：同号只取最晚一条有效测量；步骤幂等键为测量 ID
          const planned = planOfflineMerge(store.state, queue, client);
          if (!planned.steps || planned.steps.length === 0) {
            store.removeQueue(queue.map((m) => m.id));
            setResult("没有可合并的有效测量");
            return;
          }
          const appliedIds = new Set(planned.applied.map((m) => m.id));
          const rest = queue.filter((m) => !appliedIds.has(m.id));
          await run("离线测量回网", () => planned, { queueAfter: rest });
          setResult(`已按雪板号合并 ${planned.applied.length} 条（同号取最晚）；跳过 ${planned.skipped.length} 条无效/重复`);
        }}>
          回网合并（按雪板号，同号取最晚）
        </button>
        <button disabled={queue.length === 0} onClick={() => store.removeQueue(queue.map((m) => m.id))}>
          清空缓存
        </button>
      </div>
      {result && <p className="flag flag-ok">{result}</p>}
    </section>
  );
}
