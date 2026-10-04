import "./styles.css";

const project = {
  "sourceNo": 6,
  "id": "hxyfront-62004",
  "port": 62004,
  "title": "滑雪板调校维护",
  "domain": "滑雪装备调校",
  "prompt": "我想做一个面向滑雪板调校店的装备维护前端系统，技师可以记录雪板品牌、长度、板型、刃角、打蜡类型、底板损伤、修补位置和客户偏好。页面需要有维护工单列表、刃角参数表、底板损伤标记区、完工状态筛选和客户历史维护记录。",
  "palette": [
    "#0369a1",
    "#14b8a6",
    "#f97316"
  ],
  "metrics": [
    "待维护",
    "完工工单",
    "平均刃角",
    "底板修补"
  ],
  "filters": [
    "全地域",
    "公园板",
    "竞速板",
    "粉雪板"
  ],
  "fields": [
    "雪板品牌",
    "长度",
    "板型",
    "刃角",
    "打蜡类型",
    "底板损伤"
  ],
  "records": [
    [
      "ORD-106",
      "Burton 156",
      "侧刃88°，底刃1°",
      "已打低温蜡"
    ],
    [
      "ORD-112",
      "竞速板165",
      "底板划痕12cm",
      "待补P-Tex"
    ],
    [
      "ORD-118",
      "粉雪板158",
      "客户偏好弱咬雪",
      "待交付"
    ]
  ]
};

function App() {
  return (
    <main className="app">
      <section className="hero">
        <p>{project.id} · 源提示词{project.sourceNo} · Port {project.port}</p>
        <h1>{project.title}</h1>
        <span>{project.prompt}</span>
      </section>

      <section className="metrics">
        {project.metrics.map((metric: string, index: number) => (
          <article key={metric}>
            <small>{metric}</small>
            <strong>{[86, 14, 7, 32][index] ?? 12}</strong>
          </article>
        ))}
      </section>

      <section className="workspace">
        <aside className="panel">
          <h2>{project.domain}筛选</h2>
          <div className="chips">
            {project.filters.map((item: string) => (
              <button key={item}>{item}</button>
            ))}
          </div>
        </aside>

        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>专业字段</p>
              <h2>新增记录</h2>
            </div>
            <button className="primary">保存草稿</button>
          </div>
          <div className="field-grid">
            {project.fields.map((field: string) => (
              <label key={field}>
                <span>{field}</span>
                <input placeholder={"填写" + field} />
              </label>
            ))}
          </div>
        </section>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>历史记录</p>
            <h2>近期工作台</h2>
          </div>
          <button>导出摘要</button>
        </div>
        <div className="records">
          {project.records.map((record: string[], index: number) => (
            <article key={record.join("-")}>
              <b>{String(index + 1).padStart(2, "0")}</b>
              <div>
                <h3>{record[0]}</h3>
                <p>{record.slice(1).join(" · ")}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

export default App;
