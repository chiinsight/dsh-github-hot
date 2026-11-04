# dsh-github-hot

给 DeepSeek Harness 的 **GitHub 涨星榜**插件：日/周/月三榜切换，展示每期涨星 **TOP20**，主打可视化。

## 功能

- **日榜 / 周榜 / 月榜** 顶部一键切换，无需刷新页面
- **榜单视图**：每个项目一张卡片，含涨星数、名次徽章、语言与许可证标签、涨星曲线缩略图
- **详情**：点开任意项目，展示项目简介、星数历史曲线、期间涨星 / 起点星数 / 最新星数
- **统计视图**：把选中的多个项目曲线叠在一起对比（对数纵轴），勾选列表可切换对比对象
- **双主题**：深色（融入 DSH）与纸感贴纸风，右上角切换

## 数据来源

榜单数据来自 [Hysen Labs](https://hysenlabs.com) 的公开页面，无需 API key：

| 用途 | 地址 | 形式 |
|---|---|---|
| 日榜 / 月榜 | `/data/star-growth-24h.csv`、`/data/star-growth-30d.csv` | CSV |
| 周榜 TOP10 | `/weekly/{YYYY-MM-DD}` | HTML 解析 |
| 星数曲线 | `/chart/{slug}.svg` | SVG 路径解析 |
| 项目简介 | `/projects/{slug}` | HTML 解析 |

数据按 [CC BY 4.0](https://hysenlabs.com/ranking-methodology) 授权使用，界面底部与详情页均保留署名与外链。

## 安装

```bash
dsh plugin --profile desktop add dsh-github-hot
```

或从本地目录安装：

```bash
dsh plugin --profile desktop add /path/to/dsh-github-hot
```

安装后重启 DeepSeek Harness，左侧栏出现「GitHub Hot」入口。

## 行为说明

1. **取数失败不编造**：某榜单取不到时明确显示失败原因与快照时间，不会用旧数据冒充新数据。
2. **简介不编造**：没有对应分析时显示「暂无简介」，不使用模型生成内容替代原文。
3. **解析失败即报错**：周榜 HTML 或曲线 SVG 无法解析时整段标记失败，不做模糊推断。
4. **周榜依赖页面结构**：上游页面改版可能导致周榜失效，此时更新 `parseWeeklyHtml` 即可；日榜与月榜走 CSV，稳定性更高。

## 缓存与请求频率

上游数据每天更新一次，因此缓存按自然日而非分钟设计：

| 内容 | 缓存位置 | 有效期 |
|---|---|---|
| 榜单 | 磁盘 `$DSH_HOME/dsh-github-hot/cache.json` | 跨自然日失效 |
| 项目详情与曲线 | 同上 | 跨自然日失效 |
| 简介中译 | 磁盘 `zh.json` | 原文变更时才重译 |
| 项目头像 | 磁盘 `avatars/`（上限 400） | 7 天 |
| 前端详情 | 浏览器 localStorage | 跨自然日失效 |

界面不做分钟级轮询，仅在页面跨过零点时静默刷新。出网请求按 host 分队列、限制并发，同一 URL 在途去重。

## 开发

```bash
npm test    # 运行全部测试（部分用例会访问上游站点）
```

| 测试 | 覆盖内容 |
|---|---|
| `parsers` | CSV / 周榜 HTML / 曲线 SVG 解析（对线上真实响应） |
| `detail` | 项目页简介提取 |
| `client` / `render` | 浏览器半侧注册契约与首帧渲染 |
| `visual` | 真实组件 + 真实数据的同构渲染 |
| `baseline` | 多曲线对比的基准日计算 |
| `avatar` | 头像 CDN 获取与磁盘缓存 |
| `cache` / `uicache` / `persist` | 缓存命中、前端缓存与跨重启持久化 |
| `smooth` | 曲线平滑算法 |
| `timezone` | 多时区日期一致性 |
| `lang` | 语言切换行为 |
| `concurrency` | 按 host 的并发调度 |
| `hardening` | 路径穿越、CSV 边界、缓存结构校验 |
| `resilience` | 畸形输入下的降级行为 |

## 许可

MIT
