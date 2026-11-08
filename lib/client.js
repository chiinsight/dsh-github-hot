/**
 * dsh-github-hot —— 浏览器半侧（client half）
 *
 * ## 契约（与 dsh-pet / 官方插件一致）
 *   · 本文件由 DSH 当**普通副作用脚本**加载（`/plugins/dsh-github-hot/client.js`）：
 *     顶层**不能有 import / export**；
 *   · 必须调 `window.__ModuleLoader__.load({ id, factory })` 自我注册；
 *   · react / react-dom 由 factory 的 `require` 取得；factory 返回 `{ name, inject, apply }`。
 *
 * ## 这个插件的主打：可视化
 *
 * 三个视图，一套数据：
 *
 *   ① 卡片流（默认）—— 榜单像一排排「成绩卡」：大号涨星数、涨幅条、名次徽章、
 *      语言/许可证小标签。前三名金银铜，涨星量渲染成粗细不同的进度条。
 *   ② 详情视图    —— 点一张卡，右侧展开：项目独立简介 +
 *      **星数曲线（折线趋势图）**：从 SVG 解析出的真实星数，画成带面积填充的趋势图，
 *      标注起点/终点/期间涨了多少。
 *   ③ 大盘视图    —— 当前榜单的宏观统计：涨星分布、语言占比、涨幅分布（纯 CSS/内联 SVG）。
 *
 * 三个周期（日/周/月）在顶部一个分段器里切换，切换即换数据，不重载页面。
 *
 * ## 颜色
 * 全部走 DSH 设计 token（`--dsw-*`）并带兜底值；涨跌色用插件自己的局部变量
 * （只在 `.hp-root` 内定义，不碰全局，避免和皮肤插件打架）。
 */
(function () {
  /** 宿主路由前缀，必须与 lib/index.js 的 ROUTE_PREFIX 一致。 */
  const BASE = '/dsh-github-hot';
  const STYLE_ID = 'dsh-github-hot/styles';
  const PLUGIN_NAME = 'dsh-github-hot';

  /**
   * 折线上涨图标 —— 就一条折线 + 末端箭头，跟侧栏里「GitHub 热榜 / 趋势」同款画法。
   *
   * 之前那版是三条并行线 + 彩色 + 圆点，塞进 18px 的侧栏里糊成一团。
   * 单线条在这么小的尺寸下才认得出来，也才跟旁边两个插件看起来是一套的。
   */
  const LINE_ICON = (size) =>
    '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
    'xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M3 17.5 L8.5 12 L12 15.5 L21 6.5" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M15.5 6.5 L21 6.5 L21 12" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  /** 侧栏图标（走文字色，深浅主题自动适配）。 */
  const SIDEBAR_ICON_SVG = LINE_ICON(18);

  /** 关闭图标（×）：设置面板右上角。 */
  const CLOSE_ICON_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

  /** 齿轮图标：设置按钮用，走 currentColor 适配深浅主题。 */
  const GEAR_ICON_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="3.2" stroke="currentColor" stroke-width="2"/>' +
    '<path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9L5.3 5.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
    '</svg>';
  /** 面板标题图标，稍大一点。 */
  const BRAND_ICON_SVG = LINE_ICON(18);

  /** 榜单最多展示多少项。超过 20 条会变成信息噪音，所以硬性截断，不提供「再显示」。 */
  const MAX_ITEMS = 20;
  /** 统计页默认对比前几个（再多线就分不清了）。 */
  const DEFAULT_COMPARE = 10;
  /** 统计页最多允许同时对比几个。 */
  const MAX_COMPARE = 20;

  /* ============================================================ 工具函数 */

  /** 主题：dark（融入 DSH）/ paper（纸感贴纸）。存 localStorage，默认跟随深色。 */
  const THEME_KEY = 'dsh-github-hot:theme';
  function readTheme() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      return v === 'paper' ? 'paper' : 'dark';
    } catch (e) { return 'dark'; }
  }
  function writeTheme(t) {
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* 隐私模式忽略 */ }
  }

  /**
   * 语言偏好：zh = 等中文（不闪，但首屏要等模型几秒）
   *             en = 直接显示英文原文（快，不问模型）
   * 存在 localStorage 里，下次打开沿用。
   */
  const LANG_KEY = 'dsh-github-hot:lang';
  function readLang() {
    try {
      return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'zh';
    } catch (e) { return 'zh'; }
  }
  function writeLang(v) {
    try { localStorage.setItem(LANG_KEY, v); } catch (e) { /* 忽略 */ }
  }

  /* ---------------------------------------------------------------- 界面文案国际化 */

  /**
   * 界面文案表。
   *
   * 为什么集中在这里：切换语言时**整个界面**都要跟着变（不只是简介），
   * 散落在各组件里的中文字面量没法统一翻译。这里用键值对，组件通过 t() 取。
   *
   * 约定：
   *   · 键名用语义化的英文（title.summary 这种），不要用中文当键；
   *   · 占位符用 {n} 形式，通过 t('key', { n: 42 }) 填；
   *   · 中文/英文都必须写全，缺一个就会 fallback 到中文。
   */
  const COPY = {
    zh: {
      'brand.title': 'GitHub Hot',
      'brand.subtitle': '多项目涨星走势对比',
      'period.day': '日榜',
      'period.week': '周榜',
      'period.month': '月榜',
      'view.board': '榜单',
      'view.stats': '统计',
      'view.collection': '日榜遗珠',
      'collection.hint': '曾进日榜 TOP20，尚未观测到进入周榜；从本机已有快照开始持续积累。',
      'collection.count': '已积累 {n} 个项目',
      'collection.tagline': '短暂上榜，也值得被看见。',
      'collection.gainLabel': '上榜时日涨星',
      'collection.rankLabel': '日榜 #{n}',
      'collection.results': '共 {n} 个项目',
      'collection.open': '浏览合集 →',
      'collection.empty': '暂无项目，后续日榜更新时会自动积累。',
      'collection.search': '搜索项目名称',
      'collection.dates': '首次收录 {first} · 最近上日榜 {last}',
      'collection.snapshot': '最近上日榜时涨星 {n}，并非当前涨星',
      'collection.prev': '上一页',
      'collection.next': '下一页',
      'collection.page': '第 {page} / {pages} 页',
      'status.fetching': '正在拉取榜单数据…',
      'status.background': '正在拉取最新数据，当前先展示已有快照…',
      'status.delayed': '数据仍在拉取，请稍后点击刷新查看。',
      'status.partial': '部分榜单拉取失败，可切换榜单查看原因。',
      'lang.zh': '中',
      'lang.en': 'EN',
      'lang.tipZh': '当前显示中文。点击切到英文',
      'lang.tipEn': '当前显示英文。点击切回中文',
      'theme.dark': '深色',
      'theme.paper': '纸感',
      'theme.tipDark': '切到深色（融入界面）',
      'theme.tipPaper': '切到纸感贴纸风',
      'action.refresh': '刷新',
      'action.refreshing': '刷新中…',
      'action.close': '关闭',
      'status.updatedTo': '数据更新到 {date}',
      'status.today': '今日',
      'status.justNow': '刚刚',
      'status.minutesAgo': '{n} 分钟前',
      'status.hoursAgo': '{n} 小时前',
      'status.daysAgo': '{n} 天前',
      'board.newTitle': '新项目提醒',
      'board.newToday': '今天有 {n} 个新项目出现了！',
      'board.newNames': '分别是',
      'board.newEmpty': '今天暂无新项目出现',
      'board.newUnknown': '暂无法确认今日新增项目',
      'board.newDate': '按 {date} 日榜 TOP20 统计',
      'board.heroHint': '最高 {repo} 单项涨 {gain} 星',
      'board.statAvg': 'TOP20 平均',
      'board.statTop': '最高单项',
      'board.statCount': '展示条数',
      'board.countUnit': '{n} 个',
      'board.topGain': '本期最猛',
      'detail.introTitle': '项目简介',
      'detail.chartTitle': '星数曲线',
      'detail.loading': '加载中…',
      'detail.loadingIntro': '正在读取并翻译中…',
      'detail.noIntro': '暂无简介',
      'detail.noChart': '暂无星数曲线数据',
      'detail.chartError': '曲线读取失败：{msg}',
      'detail.readError': '读取失败：{msg}',
      'detail.sourceConclusion': '编辑结论',
      'detail.sourceOverview': '项目概览',
      'detail.sourceCredit': ' · 引用自 ',
      'detail.sourceLicense': '（CC BY 4.0）',
      'detail.translatedBy': ' · 中译由 DSH 模型生成，英文原文见下方',
      'detail.analysisUpdated': '分析更新于 {date}',
      'detail.kpiGained': '期间涨星',
      'detail.kpiStart': '起点星数',
      'detail.kpiEnd': '最新星数',
      'detail.chartStart': '起点 {n}',
      'detail.chartNow': '现在 {n}',
      'detail.linkGithub': '↗ GitHub',
      'detail.linkSource': '↗ hysenlabs',
      'card.newTip': '近 3 个榜单日内新增上榜',
      'card.translating': '译',
      'card.translatingTip': '中文翻译生成中',
      'stats.pickerTitle': '选择项目',
      'stats.pickTop': '前 {n}',
      'stats.pickAll': '全选',
      'stats.pickClear': '清空',
      'stats.chartTitle': '本期涨幅走势对比',
      'stats.axisHint': '纵轴：采样涨星（对称对数）',
      'stats.linearAxis': '纵轴：采样涨星（线性 · 自动）',
      'stats.gainTitle': '本期涨星对比',
      'stats.gainHint': '榜单原始涨星数 · 横条从零起算',
      'stats.sampleNote': '曲线由来源 SVG 还原，仅供趋势参考；各线从期内首个可用采样日起算，起始日见图例。精确涨星以上方榜单为准。坐标轴按当前所选项目自适应：同量级用线性，末端涨幅相差超过 10 倍用对称对数；头像引导线连接真实终点。',
      'stats.unknownWindow': '未获得榜单日期范围，以下展示历史采样曲线。',
      'stats.showAll': '展开全部 {n} 项',
      'stats.showLess': '收起',
      'stats.dailyTitle': '日涨星对比',
      'stats.dailyAxis': '纵轴：当日涨星数（线性）',
      'stats.dailyNote': '每个头像代表一个项目，位置越高，当日涨星越多；横轴按榜单名次排列。悬停或聚焦头像可查看项目及精确涨星数。',
      'stats.emptyHint': '勾选左侧项目后这里会画出它们的走势对比',
      'error.title': '取数失败',
      'error.hint': '检查网络连接，然后点右上角「刷新」。',
      'error.dailyHint': '数据每天更新一次，稍后重试即可。',
      'error.stale': '本次取数失败（{err}），显示的是 {when} 的数据。',
      'empty.noData': '暂无数据',
      'empty.notFetched': '暂未取到数据',
      'empty.partial': '暂未取到 · 显示 {n} 条',
      'misc.stars': '星',
      'misc.gainUnit': '涨',
      'misc.topByRank': '按名次看每个项目',
      'attribution': '',
      'glance.translating': '正在努力翻译成中文…',
      'plain.title': '小白一眼看懂',
      'plain.credit': '由 DSH 模型生成，仅供理解参考',
      'plain.loading': '正在用大白话解释…',
      'plain.slow': '生成较慢，可稍后重试。',
      'plain.failed': '暂时没能生成解释，请稍后重试。',
      'plain.source': '现有资料不足，暂时无法解释这个项目。',
      'plain.model': 'DSH 模型暂不可用，请检查宿主模型设置。',
      'plain.retry': '重新生成',
      'glance.title': '一眼看懂',
      'glance.what': '它是什么？',
      'glance.who': '适合谁用？',
      'glance.commercial': '可以商用吗？',
      'glance.maintained': '还在维护吗？',
      'glance.writtenIn': '用什么写的？',
      'glance.footer': '内容来自项目公开数据与编辑分析，不构成法律意见。',
      'settings.title': '设置',
      'settings.tip': '插件设置',
      'settings.version': '版本信息',
      'settings.current': '当前版本',
      'settings.latest': '最新版本',
      'settings.checking': '检查中…',
      'settings.upToDate': '已是最新',
      'settings.localAhead': '本地为开发版（npm 上最新为 v{v}）',
      'settings.hasUpdate': '有新版本',
      'settings.updateTip': '有新版本 v{v} 可用',
      'settings.updateHint': '升级命令：',
      'settings.checkNow': '立即检查',
      'settings.checkFailed': '检查失败：{msg}',
      'settings.noNetwork': '暂时无法连接 npm',
      'settings.close': '关闭',
      'settings.repo': '项目主页',
    },
    en: {
      'brand.title': 'GitHub Hot',
      'brand.subtitle': 'Multi-project star growth',
      'period.day': 'Daily',
      'period.week': 'Weekly',
      'period.month': 'Monthly',
      'view.board': 'Ranking',
      'view.stats': 'Stats',
      'view.collection': 'Daily discoveries',
      'collection.hint': 'Observed in the daily TOP20, not yet observed in the weekly ranking. Accumulated from snapshots on this device.',
      'collection.count': '{n} projects collected',
      'collection.tagline': 'Briefly trending, still worth discovering.',
      'collection.gainLabel': 'Daily gain when ranked',
      'collection.rankLabel': 'Daily #{n}',
      'collection.results': '{n} projects',
      'collection.open': 'Browse collection →',
      'collection.empty': 'No projects yet. Future daily rankings will build this collection.',
      'collection.search': 'Search project names',
      'collection.dates': 'First collected {first} · Last daily appearance {last}',
      'collection.snapshot': '{n} stars at last daily appearance, not a current gain',
      'collection.prev': 'Previous',
      'collection.next': 'Next',
      'collection.page': 'Page {page} / {pages}',
      'status.fetching': 'Fetching ranking data…',
      'status.background': 'Fetching the latest data; showing saved snapshots for now…',
      'status.delayed': 'Data is still being fetched. Click Refresh again shortly.',
      'status.partial': 'Some rankings could not be fetched. Select a ranking for details.',
      'lang.zh': '中',
      'lang.en': 'EN',
      'lang.tipZh': 'Showing Chinese. Click for English',
      'lang.tipEn': 'Showing English. Click for Chinese',
      'theme.dark': 'Dark',
      'theme.paper': 'Paper',
      'theme.tipDark': 'Switch to dark theme',
      'theme.tipPaper': 'Switch to paper sticker theme',
      'action.refresh': 'Refresh',
      'action.refreshing': 'Refreshing…',
      'action.close': 'Close',
      'status.updatedTo': 'Updated {date}',
      'status.today': 'Today',
      'status.justNow': 'just now',
      'status.minutesAgo': '{n} min ago',
      'status.hoursAgo': '{n} h ago',
      'status.daysAgo': '{n} d ago',
      'board.newTitle': 'New project alert',
      'board.newToday': '{n} new projects appeared today!',
      'board.newNames': 'Meet the newcomers',
      'board.newEmpty': 'No new projects today',
      'board.newUnknown': 'New project data is unavailable',
      'board.newDate': 'Based on the {date} daily TOP20',
      'board.heroHint': 'Top: {repo} with {gain} stars',
      'board.statAvg': 'TOP20 avg',
      'board.statTop': 'Top gainer',
      'board.statCount': 'Showing',
      'board.countUnit': '{n}',
      'board.topGain': 'Top gainer',
      'detail.introTitle': 'About',
      'detail.chartTitle': 'Star history',
      'detail.loading': 'Loading…',
      'detail.loadingIntro': 'Fetching and translating…',
      'detail.noIntro': 'No description yet',
      'detail.noChart': 'No star history available',
      'detail.chartError': 'Failed to load chart: {msg}',
      'detail.readError': 'Failed to load: {msg}',
      'detail.sourceConclusion': 'Editorial take',
      'detail.sourceOverview': 'Project overview',
      'detail.sourceCredit': ' · via ',
      'detail.sourceLicense': ' (CC BY 4.0)',
      'detail.translatedBy': '',
      'detail.analysisUpdated': 'Analysis updated {date}',
      'detail.kpiGained': 'Gained',
      'detail.kpiStart': 'Starting stars',
      'detail.kpiEnd': 'Current stars',
      'detail.chartStart': 'Start {n}',
      'detail.chartNow': 'Now {n}',
      'detail.linkGithub': '↗ GitHub',
      'detail.linkSource': '↗ hysenlabs',
      'card.newTip': 'New within the last 3 ranking days',
      'card.translating': 'zh',
      'card.translatingTip': 'Translating to Chinese',
      'stats.pickerTitle': 'Select projects',
      'stats.pickTop': 'Top {n}',
      'stats.pickAll': 'All',
      'stats.pickClear': 'Clear',
      'stats.chartTitle': 'Growth comparison',
      'stats.axisHint': 'Y-axis: sampled gain (symmetric log)',
      'stats.linearAxis': 'Y-axis: sampled gain (linear · auto)',
      'stats.gainTitle': 'Period star gains',
      'stats.gainHint': 'Original ranking values · bars start at zero',
      'stats.sampleNote': 'Trends are reconstructed from source SVGs. Each line starts at its first available sample in the period; see legend dates. Use the ranking above for exact gains. The axis adapts to selected projects: linear for comparable values, symmetric log when nonzero endpoint magnitudes differ by over 10×. Avatar guides connect to the true endpoints.',
      'stats.unknownWindow': 'Ranking dates are unavailable; historical samples are shown below.',
      'stats.showAll': 'Show all {n} projects',
      'stats.showLess': 'Show less',
      'stats.dailyTitle': 'Daily star gains',
      'stats.dailyAxis': 'Y-axis: daily stars gained (linear)',
      'stats.dailyNote': 'One avatar per project: higher means more stars gained that day. The x-axis follows ranking order. Hover or focus an avatar for its project and exact gain.',
      'stats.emptyHint': 'Select projects to compare their trends',
      'error.title': 'Failed to fetch',
      'error.hint': 'Check your network, then click "Refresh".',
      'error.dailyHint': 'Data updates once a day. Try again later.',
      'error.stale': 'Fetch failed ({err}). Showing data from {when}.',
      'empty.noData': 'No data',
      'empty.notFetched': 'Not fetched yet',
      'empty.partial': 'Partial · showing {n}',
      'misc.stars': 'stars',
      'misc.gainUnit': 'gain',
      'misc.topByRank': 'Each project by rank',
      'attribution': '',
      'glance.translating': 'Translating to Chinese…',
      'plain.title': 'In plain language',
      'plain.credit': 'Generated by the DSH model; for understanding only',
      'plain.loading': 'Preparing a plain-language explanation…',
      'plain.slow': 'Generation is taking longer. Try again shortly.',
      'plain.failed': 'Could not generate an explanation. Try again later.',
      'plain.source': 'Not enough source information to explain this project yet.',
      'plain.model': 'The DSH model is unavailable. Check the host model settings.',
      'plain.retry': 'Try again',
      'glance.title': 'At a glance',
      'glance.what': 'What is it?',
      'glance.who': 'Who is it for?',
      'glance.commercial': 'Can I use it commercially?',
      'glance.maintained': 'Is it still maintained?',
      'glance.writtenIn': 'What is it written in?',
      'glance.footer': 'Answers come from public project data and editorial analysis. Not legal advice.',
      'settings.title': 'Settings',
      'settings.tip': 'Plugin settings',
      'settings.version': 'Version',
      'settings.current': 'Current',
      'settings.latest': 'Latest',
      'settings.checking': 'Checking…',
      'settings.upToDate': 'Up to date',
      'settings.localAhead': 'Local dev build (npm latest v{v})',
      'settings.hasUpdate': 'Update available',
      'settings.updateTip': 'Version v{v} available',
      'settings.updateHint': 'Upgrade with:',
      'settings.checkNow': 'Check now',
      'settings.checkFailed': 'Check failed: {msg}',
      'settings.noNetwork': 'Cannot reach npm',
      'settings.close': 'Close',
      'settings.repo': 'Repository',
    },
  };

  /**
   * 取界面文案。找不到键时回退到中文，再找不到就返回键名本身
   * （返回键名而不是空串，便于发现漏翻的地方）。
   */
  function translate(lang, key, vars) {
    const table = COPY[lang] || COPY.zh;
    let text = table[key];
    if (text === undefined) text = COPY.zh[key];
    if (text === undefined) return key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.split('{' + k + '}').join(String(v));
      }
    }
    return text;
  }

  /**
   * 比较两个版本号（忽略预发布后缀）。返回 1/0/-1。
   * 与宿主侧 compareVersion 保持同一口径。
   */
  function cmpVersion(a, b) {
    const norm = (v) => String(v || '').split('-')[0].split('.').map((x) => Number(x) || 0);
    const pa = norm(a);
    const pb = norm(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const x = pa[i] || 0;
      const y = pb[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }

  /**
   * 紧凑数字格式：1000 以上一律走 k，避免卡片里「3,988」和「13.2k」混排显得参差。
   * 注意保留一位小数但去掉多余的 .0（3,988 → 4.0k → 4k）。
   */
  function fmtCount(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    const v = Number(n);
    const abs = Math.abs(v);
    if (abs >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (abs >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return v.toLocaleString('en-US');
  }

  /** 涨星数带正号，并分档给颜色。 */
  function gainTone(n) {
    if (n === null || n === undefined) return 'flat';
    return n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
  }

  function fmtPct(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    const v = Number(n);
    return (v > 0 ? '+' : '') + (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) + '%';
  }

  /**
   * 详情本地缓存（localStorage）。
   *
   * 为什么需要：后端虽然缓存了，但前端每次进入插件都会重建组件、重新请求一遍，
   * 用户看到的是「骨架 → 内容」的闪烁，感觉像在重新下载。这里把取回的详情按
   * 自然日存在浏览器里 —— 同一自然日再进来直接秒出，后台再静默核对一次。
   *
   * 只存到当天：数据源每天才更新一次，跨天必须重取，不能拿昨天的当今天。
   */
  const DETAILS_KEY = 'dsh-github-hot:details';
  const DETAILS_MAX = 60;

  function readDetailsCache() {
    try {
      const raw = localStorage.getItem(DETAILS_KEY);
      if (!raw) return {};
      const data = JSON.parse(raw);
      if (!data || data.day !== localDayKey() || !data.entries) return {}; // 跨天或格式不对 → 丢弃
      // 逐条校验结构：settled 必须是 true（否则会一直显示骨架），
      // 有曲线的必须每个点带 date（否则统计页画不出来）。不合格的直接丢掉重取。
      const out = {};
      for (const [repo, entry] of Object.entries(data.entries)) {
        if (!entry || entry.settled !== true) continue;
        const chart = entry.chart;
        if (chart && Array.isArray(chart.series)) {
          const okShape = chart.series.length === 0 || chart.series.every((p) => p && typeof p.date === 'string');
          if (!okShape) continue;
        }
        out[repo] = entry;
      }
      return out;
    } catch (e) {
      return {};
    }
  }

  function writeDetailsCache(entries) {
    try {
      // 只留最近的若干条，避免 localStorage 撑爆
      const all = Object.entries(entries || {});
      const keep = all.slice(-DETAILS_MAX);
      localStorage.setItem(DETAILS_KEY, JSON.stringify({ day: localDayKey(), entries: Object.fromEntries(keep) }));
    } catch (e) {
      /* 配额满/隐私模式：忽略，退化成纯内存 */
    }
  }

  /**
   * 数据源时区（Asia/Shanghai）下的日期串 YYYY-MM-DD。
   *
   * 前端也要用数据源时区判断「是不是同一天」：命令里的缓存是否失效、数据是否更新，
   * 都应该跟着**数据源**的日历走，而不是用户所在时区。否则纽约用户在晚上看到的
   * 「今天」和上海用户看到的不一样，缓存也会在奇怪的时间点失效。
   */
  const SOURCE_TZ = 'Asia/Shanghai';
  function localDayKey(ts) {
    const d = ts ? new Date(ts) : new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: SOURCE_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const g = (t) => (parts.find((x) => x.type === t) || {}).value;
    return g('year') + '-' + g('month') + '-' + g('day');
  }

  /**
   * 把数据日期说成一句人话：「11月3日」。
   * 日榜/月榜窗口的 end 是 YYYY-MM-DD；周榜拿 week 的周一开始日算周日。
   */
  /**
   * 把数据日期说成一句人话，例如「11月3日」。
   *
   * ⚠️ 不要用 new Date('2026-11-03') 再取本地月份 —— 那会按 UTC 解析，
   * 在 UTC-x 的时区里显示成「11月2日」。这里**直接切字符串**，日期串本来就是
   * 数据源的日期，不需要经过任何时区换算。
   */
  function dataDateText(board, lang) {
    const en = lang === 'en';
    if (!board) return en ? 'today' : '今日';
    const raw = board.window && board.window.end ? board.window.end : board.week;
    if (!raw) return en ? 'today' : '今日';
    const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return en ? 'today' : '今日';
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    /**
     * 日期写法按语言习惯分开 —— 直译会读着别扭：
     *   中文：2026年11月4日（先说年，量词用「年/月/日」）
     *   英文：Nov 4, 2026（月在前、日用序数直觉、年份放最后）
     * 两者都精确到年，不会出现「11月3日」这种看不出是哪年的写法。
     */
    if (en) {
      const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return MON[mo - 1] + ' ' + d + ', ' + y;
    }
    // 中文用紧凑写法「26.11.4」：两位年份 + 点分隔，一眼看完不占地方
    return String(y).slice(2) + '.' + mo + '.' + d;
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function ago(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const min = Math.floor(ms / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    const h = Math.floor(min / 60);
    if (h < 24) return h + ' 小时前';
    return Math.floor(h / 24) + ' 天前';
  }

  /** 简易 fetch JSON（带超时）。 */
  async function getJson(path) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(BASE + path, { signal: controller.signal, headers: { Accept: 'application/json' } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) {
        throw new Error(body.error || 'HTTP ' + response.status);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ============================================================ 样式表 */

  function ensureCss(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
/* ---------- 根容器：局部色板，不碰全局 --dsw-* ---------- */
/* ============================================================
   两套主题
   ============================================================
   .hp-dark  —— 深色：融进 DSH 原生界面（默认）
   .hp-paper —— 纸感贴纸风：暖米白纸 + 墨黑粗框 + 实体阴影

   两套只换变量，不改结构；所有组件都只读 --hp-* 变量，天然双主题。
   ============================================================ */
.hp-root{height:100%;display:flex;flex-direction:column;overflow:hidden;font-size:14px}

/* ---------- 深色主题（默认）---------- */
.hp-root.hp-dark{
  --hp-up:#e5484d;
  --hp-up-soft:rgba(229,72,77,.13);
  --hp-down:#30a46c;
  --hp-gold:#d9a52b;
  --hp-silver:#9aa4b2;
  --hp-bronze:#c07a3e;
  --hp-accent:#7b5cff;
  --hp-bg:var(--dsw-alias-bg-layer-1,#14161a);
  --hp-surface:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.035));
  --hp-surface-2:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.07));
  --hp-fg:var(--dsw-alias-label-primary,#e8eaed);
  --hp-fg-2:var(--dsw-alias-label-secondary,rgba(255,255,255,.72));
  --hp-fg-3:var(--dsw-alias-label-tertiary,rgba(255,255,255,.45));
  --hp-line:var(--dsw-alias-border-l2,rgba(255,255,255,.09));
  --hp-sep:var(--dsw-alias-separator-primary,rgba(255,255,255,.08));
  --hp-border:1px solid var(--hp-line);
  --hp-shadow:none;
  --hp-shadow-hover:0 8px 24px rgba(0,0,0,.28);
  --hp-card-bg:var(--hp-surface);
  --hp-radius:13px;
  /**
   * 弹层（设置面板）的底色：**必须不透明**。
   * 之前用了一个没定义的变量，回退到 transparent，面板直接透出下面的卡片内容。
   */
  --hp-panel:var(--dsw-alias-bg-layer-2,#1b1e24);
}

/* ---------- 纸感贴纸主题 ---------- */
.hp-root.hp-paper{
  --hp-up:#ff5c2b;
  --hp-up-soft:rgba(255,92,43,.14);
  --hp-down:#3f8f2e;
  --hp-gold:#ffd84d;
  --hp-silver:#cfc8bb;
  --hp-bronze:#ffb07a;
  --hp-accent:#ff5c2b;
  --hp-paper:#fff4dd;
  --hp-ink:#26201a;
  --hp-card:#fffdf7;
  --hp-bg:var(--hp-paper);
  --hp-surface:var(--hp-card);
  --hp-surface-2:#fff9ec;
  --hp-fg:var(--hp-ink);
  --hp-fg-2:#4a3f33;
  --hp-fg-3:#8a7a68;
  --hp-panel:var(--hp-card);
  --hp-line:var(--hp-ink);
  --hp-sep:rgba(38,32,26,.16);
  --hp-border:2px solid var(--hp-ink);
  --hp-shadow:4px 4px 0 var(--hp-ink);
  --hp-shadow-hover:6px 6px 0 var(--hp-ink);
  --hp-card-bg:var(--hp-card);
  --hp-radius:14px;
}

.hp-root{
  font-family:var(--dsw-font,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif);
  color:var(--hp-fg);
  background:var(--hp-bg);
}
.hp-root.hp-paper .hp-head{background:#fff9ec}
.hp-root.hp-paper .hp-seg{border:2px solid var(--hp-ink);box-shadow:2px 2px 0 var(--hp-ink);background:var(--hp-card)}
.hp-root.hp-paper .hp-brand-dot{box-shadow:none;border:2px solid var(--hp-ink)}
.hp-root.hp-paper{font-family:'Baloo 2',var(--dsw-font,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif)}
.hp-root.hp-paper .hp-num,.hp-root.hp-paper .hp-gain-v,.hp-root.hp-paper .hp-kpi-v{
  font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  letter-spacing:-.02em;
}
.hp-scroll{overflow:auto;flex:1;scrollbar-width:thin}
.hp-scroll::-webkit-scrollbar{width:8px;height:8px}
.hp-scroll::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(255,255,255,.12));border-radius:4px}

/* ---------- 顶栏 ---------- */
.hp-head{display:flex;align-items:center;gap:10px;padding:11px 18px;border-bottom:1px solid var(--hp-sep);flex-wrap:nowrap;overflow:hidden}
.hp-brand{display:flex;align-items:center;gap:8px;font-weight:650;font-size:14.5px;letter-spacing:.2px;flex:0 0 auto;white-space:nowrap}
.hp-brand-icon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px}
.hp-brand-icon svg{display:block}
/* 侧栏图标：与同侧栏其它插件一致，只吃文字色 */
.hp-side-icon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px}
.hp-side-icon svg{display:block}
.hp-brand-dot{width:9px;height:9px;border-radius:50%;background:linear-gradient(135deg,var(--hp-grad-a),var(--hp-grad-b));box-shadow:0 0 10px rgba(122,92,255,.7)}
.hp-brand-sub{font-size:10.5px;font-weight:400;color:var(--hp-fg-3);margin-left:2px;white-space:nowrap}
@media (max-width:1180px){.hp-brand-sub{display:none}}
@media (max-width:980px){.hp-head .hp-meta{display:none}}
.hp-seg{display:flex;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));border-radius:9px;padding:3px;gap:2px}
.hp-seg button{border:0;background:transparent;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.65));font:inherit;font-size:12.5px;padding:5px 11px;border-radius:7px;cursor:pointer;transition:all .16s}
.hp-seg button:hover{color:var(--dsw-alias-label-primary,#fff);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.hp-seg button.on{background:var(--dsw-alias-button-primary-fill,#4f7cff);color:#fff;font-weight:600}
.hp-root.hp-paper .hp-seg button{color:var(--hp-ink)}
.hp-root.hp-paper .hp-seg button.on{background:var(--hp-ink);color:var(--hp-gold);font-weight:800}
.hp-root.hp-paper .hp-seg button:hover:not(.on){background:#f0e6d2;color:var(--hp-ink)}
.hp-seg button:disabled{opacity:.45;cursor:default}
.hp-spacer{flex:1}
.hp-meta{font-size:12px;color:var(--hp-fg-3);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.hp-dot{width:6px;height:6px;border-radius:50%;display:inline-block;margin-right:5px}
.hp-dot.ok{background:#30a46c;box-shadow:0 0 6px rgba(48,164,108,.8)}
.hp-dot.bad{background:#e5484d}
.hp-dot.warn{background:#f5a524}
.hp-btn{border:1px solid var(--hp-line);background:var(--hp-surface);color:var(--hp-fg);font:inherit;font-size:12.5px;padding:5px 11px;white-space:nowrap;border-radius:8px;cursor:pointer;transition:all .16s}
.hp-btn:hover:not(:disabled){background:var(--hp-surface-2)}
.hp-root.hp-paper .hp-btn{border:2px solid var(--hp-ink);box-shadow:2px 2px 0 var(--hp-ink);font-weight:700}
.hp-root.hp-paper .hp-btn:hover:not(:disabled){transform:translate(-1px,-1px);box-shadow:3px 3px 0 var(--hp-ink)}
.hp-root.hp-paper .hp-btn:active:not(:disabled){transform:translate(1px,1px);box-shadow:1px 1px 0 var(--hp-ink)}
.hp-btn:disabled{opacity:.5;cursor:default}
.hp-btn.primary{background:var(--hp-accent);border-color:transparent;color:#fff;font-weight:600}
.hp-root.hp-paper .hp-btn.primary{background:var(--hp-gold);color:var(--hp-ink);border:2px solid var(--hp-ink)}

/* ---------- 空/错状态 ---------- */
.hp-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:70px 24px;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.5));text-align:center}
.hp-empty strong{color:var(--dsw-alias-label-secondary,rgba(255,255,255,.7));font-size:15px}
.hp-empty code{font-size:12px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));padding:2px 7px;border-radius:5px}
.hp-banner{margin:12px 20px 0;padding:10px 14px;border-radius:9px;font-size:12.5px;line-height:1.55}
.hp-fetch-status{display:flex;align-items:center;gap:9px;background:var(--hp-surface);color:var(--hp-fg-2);border:var(--hp-border)}
.hp-fetch-spinner{width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:hp-fetch-spin .8s linear infinite;flex-shrink:0}
@keyframes hp-fetch-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.hp-fetch-spinner{animation:none}}
.hp-new-project-title{font-size:clamp(20px,2.3vw,28px);font-weight:750;line-height:1.4;color:var(--hp-accent);margin:9px 0 14px;letter-spacing:-.4px}
.hp-new-project-list{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.hp-new-project-label{font-size:12px;color:var(--hp-fg-3);margin-right:2px}
.hp-new-project{display:inline-flex;align-items:center;gap:7px;max-width:100%;padding:6px 9px;background:var(--hp-surface-2);border:1px solid var(--hp-line);border-radius:8px;color:var(--hp-fg);font:inherit;font-size:12px;overflow-wrap:anywhere;cursor:pointer}
.hp-new-project:hover{border-color:var(--hp-accent)}
.hp-new-project:focus-visible{outline:2px solid var(--hp-accent);outline-offset:2px}
.hp-plain{margin-top:20px;padding-top:18px;border-top:1px solid var(--hp-sep)}
.hp-plain-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.hp-plain-head .hp-pane-title{margin-bottom:0;color:var(--hp-fg-2)}
.hp-plain-credit{font-size:10px;color:var(--hp-fg-3)}
.hp-plain-content{margin:14px 0 0;font-size:14px;line-height:1.8;color:var(--hp-fg-2);overflow-wrap:anywhere}
.hp-plain-state{font-size:12px;line-height:1.7;color:var(--hp-fg-3);padding:14px 0}
.hp-collection-preview{flex:1 1 280px;min-width:0;padding:16px 20px;border:var(--hp-border);border-radius:var(--hp-radius);background:var(--hp-card-bg);box-shadow:var(--hp-shadow)}
.hp-collection-heading{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.hp-collection-heading h2{margin:0;font-size:20px;font-weight:750;letter-spacing:-.3px}
.hp-collection-heading .hp-hero-k{margin:0;color:var(--hp-fg);font-size:13px;letter-spacing:0}
.hp-collection-count{padding:3px 8px;border:1px solid var(--hp-line);border-radius:7px;color:var(--hp-fg-2);font-size:11px;font-variant-numeric:tabular-nums;background:var(--hp-surface-2)}
.hp-collection-open{margin-left:auto;border:0;background:none;color:var(--hp-accent);font:inherit;font-size:12px;font-weight:650;padding:4px 0;cursor:pointer}
.hp-collection-tagline{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--hp-fg-2);margin:7px 0 12px;line-height:1.6}
.hp-collection-tagline span{font-size:10px;color:var(--hp-fg-3)}
.hp-collection-peeks{display:grid;gap:2px}
.hp-collection-peek{display:flex;align-items:center;gap:9px;width:100%;min-width:0;padding:7px 0;border:0;background:none;color:var(--hp-fg);font:inherit;text-align:left;cursor:pointer}
.hp-collection-peek+.hp-collection-peek{border-top:1px solid var(--hp-sep)}
.hp-collection-peek-name{flex:1;min-width:0;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hp-collection-peek-gain{font-size:13px;font-weight:700;color:var(--hp-up);font-variant-numeric:tabular-nums}
.hp-collection{padding:18px 20px 28px}
.hp-collection-intro{font-size:12px;line-height:1.7;color:var(--hp-fg-2);margin:9px 0 18px;max-width:760px}
.hp-collection-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.hp-collection-results{color:var(--hp-fg-3);font-size:12px}
.hp-collection-search{box-sizing:border-box;width:320px;max-width:100%;padding:9px 12px;border:var(--hp-border);border-radius:9px;background:var(--hp-card-bg);color:inherit;font:inherit;font-size:12px}
.hp-cards.hp-collection-grid{padding:0;grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr))}
.hp-card.hp-collection-row{min-width:0}
.hp-collection-meta{display:flex;flex-direction:column;gap:7px;margin-top:auto;padding-top:12px;color:var(--hp-fg-3);font-size:10.5px;line-height:1.6}
.hp-collection-meta .hp-chip{align-self:flex-start}
.hp-collection-pagination{display:flex;align-items:center;justify-content:flex-end;gap:12px;margin-top:20px;font-size:12px;color:var(--hp-fg-2);flex-wrap:wrap}
.hp-collection-preview button:focus-visible{outline:2px solid var(--hp-accent);outline-offset:3px;border-radius:5px}
@media(max-width:540px){.hp-collection-search{width:100%}.hp-collection-heading h2{font-size:18px}.hp-collection-preview{padding:14px 16px}.hp-collection-pagination{gap:8px}}
.hp-banner.err{background:rgba(229,72,77,.1);border:1px solid rgba(229,72,77,.35);color:#ff9ba0}
.hp-banner.warn{background:rgba(245,165,36,.1);border:1px solid rgba(245,165,36,.35);color:#ffcf80}

/* ---------- 榜单卡片流 ---------- */


/* ---------- 统计视图：多曲线对比 ---------- */
/* 上图下选：图表独占一行，勾选列表在下方横向铺开 */
.hp-dash{display:flex;flex-direction:column;gap:12px;padding:16px 18px 28px}
.hp-picker{border:var(--hp-border);border-radius:var(--hp-radius);background:var(--hp-card-bg);box-shadow:var(--hp-shadow);padding:11px 6px 8px;max-height:230px;overflow:auto}
/* 快捷选择按钮行 */
.hp-pick-actions{
  display:flex;align-items:center;gap:5px;flex-wrap:wrap;
  padding:0 10px 9px;margin-bottom:6px;border-bottom:1px solid var(--hp-sep);
}
.hp-pick-btn{
  padding:4px 10px;border-radius:7px;cursor:pointer;
  font-size:11px;font-weight:550;line-height:1.5;
  border:1px solid var(--hp-line);background:var(--hp-surface-2);color:var(--hp-fg-2);
  transition:background .14s,border-color .14s,color .14s;
}
.hp-pick-btn:hover:not(:disabled){background:var(--hp-surface);border-color:var(--hp-fg-3);color:var(--hp-fg)}
.hp-pick-btn:active:not(:disabled){transform:translateY(1px)}
.hp-pick-btn:disabled{opacity:.4;cursor:default}
.hp-pick-btn.clear{margin-left:auto;color:var(--hp-fg-3)}
.hp-pick-btn.clear:hover:not(:disabled){color:var(--hp-up);border-color:var(--hp-up)}
.hp-pick-sep{flex:1}
.hp-root.hp-paper .hp-pick-btn{border:1.5px solid var(--hp-ink);background:var(--hp-card);color:var(--hp-ink)}
.hp-root.hp-paper .hp-pick-btn.clear{border-color:rgba(38,32,26,.3)}

.hp-picker-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:1px 4px}
.hp-picker-title{display:flex;justify-content:space-between;align-items:baseline;font-size:11.5px;font-weight:650;color:var(--hp-fg-3);padding:0 10px 8px;border-bottom:1px solid var(--hp-sep);margin-bottom:6px}
.hp-picker-n{font-variant-numeric:tabular-nums}
.hp-pick{display:flex;align-items:center;gap:7px;padding:6px 10px;border-radius:8px;cursor:pointer;font-size:12.5px;transition:background .12s}
.hp-pick:hover{background:var(--hp-surface-2)}
.hp-pick input{accent-color:var(--hp-accent);margin:0;cursor:pointer}
.hp-pick-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--hp-sep)}
.hp-pick-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--hp-fg-2)}
.hp-pick.on .hp-pick-name{color:var(--hp-fg);font-weight:600}
.hp-pick-v{font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--hp-up);font-weight:650}
.hp-pick.no-data{opacity:.42;cursor:not-allowed}
.hp-mchart-panel{border:var(--hp-border);border-radius:var(--hp-radius);background:var(--hp-card-bg);box-shadow:var(--hp-shadow);padding:13px 15px 11px;min-width:0}
.hp-mchart-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;flex-wrap:wrap}
.hp-mchart-title{font-size:13px;font-weight:700;color:var(--hp-fg)}
.hp-mchart-hint{font-size:11px;color:var(--hp-fg-3)}
.hp-seg.tiny button{font-size:11.5px;padding:3px 9px}
.hp-mchart-svg{width:100%;height:auto;display:block}
/* 换榜单时图表淡入：直接替换会「啪」地跳一下 */
.hp-mchart{animation:hp-chart-in .32s cubic-bezier(.22,.61,.36,1)}
@keyframes hp-chart-in{
  from{opacity:0;transform:translateY(6px)}
  to{opacity:1;transform:translateY(0)}
}
@media (prefers-reduced-motion:reduce){.hp-mchart{animation:none}}
.hp-grid{stroke:var(--hp-sep);stroke-width:1;stroke-dasharray:3 4}
.hp-zero{stroke:var(--hp-fg-3);stroke-width:1.2}
.hp-axis{fill:var(--hp-fg-3);font-size:10.5px;font-family:ui-monospace,Menlo,monospace}
.hp-legend{display:flex;flex-wrap:wrap;gap:8px 14px;margin-top:9px;padding-top:9px;border-top:1px solid var(--hp-sep)}
.hp-legend-item{display:flex;align-items:center;gap:6px;border:0;background:transparent;color:var(--hp-fg-2);font:inherit;font-size:11.5px;cursor:pointer;padding:2px 4px;border-radius:6px;transition:all .12s}
.hp-legend-item:hover,.hp-legend-item.act{background:var(--hp-surface-2);color:var(--hp-fg)}
.hp-legend-line{width:16px;height:3px;border-radius:2px;flex:0 0 auto}
.hp-mchart-note{font-size:11px;color:var(--hp-fg-3);margin-top:9px;line-height:1.5}
.hp-gain-list{display:grid;gap:8px;margin-top:14px}
.hp-gain-row{display:grid;grid-template-columns:minmax(120px,1fr) minmax(80px,2fr) 78px;gap:12px;align-items:center;font-size:12px}
.hp-gain-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--hp-fg-2)}
.hp-gain-track{height:7px;background:var(--hp-sep);border-radius:3px;overflow:hidden}
.hp-gain-bar{height:100%;background:var(--hp-accent)}
.hp-gain-value{text-align:right;font-variant-numeric:tabular-nums;color:var(--hp-fg)}
@media(max-width:600px){.hp-gain-row{grid-template-columns:minmax(100px,1fr) minmax(40px,1fr) 64px;gap:8px}}


/* ---------- 头像 ---------- */
.hp-avatar{flex:0 0 auto;border-radius:9px;object-fit:cover;background:var(--hp-surface-2);display:block}
.hp-root.hp-paper .hp-avatar{border:2px solid var(--hp-ink)}
.hp-avatar-fb{display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:700;border-radius:9px;flex:0 0 auto;user-select:none}

/* ---------- 右侧操作区 ---------- */
/* 未译时的提示条：低调但明确，告诉用户「在翻了」而不是卡住 */
.hp-tr-hint{
  display:block;margin-bottom:4px;font-size:11px;font-weight:600;
  color:var(--hp-accent);opacity:.9;letter-spacing:.01em;
}
.hp-tr-hint::after{content:'';display:inline-block;width:10px;text-align:left;animation:hp-dots 1.2s steps(4,end) infinite}
@keyframes hp-dots{0%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}}
@media (prefers-reduced-motion:reduce){.hp-tr-hint::after{animation:none;content:'…'}}
.hp-glance-a.pending{opacity:.86}

/* ---------- 详情页「一眼看懂」问答表 ---------- */
.hp-glance{margin:0;padding:0;display:flex;flex-direction:column}
.hp-glance-row{
  display:grid;grid-template-columns:132px 1fr;gap:14px;
  padding:11px 0;border-bottom:1px dashed var(--hp-sep);
}
.hp-glance-row:first-child{padding-top:2px}
.hp-glance-row:last-child{border-bottom:none;padding-bottom:2px}
.hp-glance-q{
  font-size:11.5px;font-weight:600;color:var(--hp-fg-3);
  line-height:1.5;margin:0;
}
.hp-glance-a{
  margin:0;font-size:12.5px;line-height:1.65;color:var(--hp-fg);
  /* 答案完整显示，不截断 —— 截断会丢掉「能不能商用」这类关键信息 */
  overflow-wrap:anywhere;
}
.hp-root.hp-paper .hp-glance-q{color:var(--hp-ink);opacity:.62}
.hp-root.hp-paper .hp-glance-row{border-bottom:1px dashed rgba(38,32,26,.22)}
@media (max-width:760px){
  .hp-glance-row{grid-template-columns:1fr;gap:3px}
}

/* ---------- 设置按钮与面板 ---------- */
.hp-settings-btn{display:inline-flex;align-items:center;gap:6px;position:relative}
.hp-gear{display:inline-flex;align-items:center;opacity:.75}
.hp-settings-btn:hover .hp-gear{opacity:1}
.hp-btn.hp-btn-update{
  border-color:var(--hp-accent);color:var(--hp-accent);font-weight:600;
  background:color-mix(in srgb, var(--hp-accent) 12%, transparent);
}
.hp-update-dot{
  width:7px;height:7px;border-radius:50%;background:var(--hp-accent);display:inline-block;
  box-shadow:0 0 0 0 color-mix(in srgb, var(--hp-accent) 60%, transparent);
  animation:hp-pulse 1.8s ease-out infinite;
}
@keyframes hp-pulse{
  0%{box-shadow:0 0 0 0 color-mix(in srgb, var(--hp-accent) 60%, transparent)}
  70%{box-shadow:0 0 0 7px transparent}
  100%{box-shadow:0 0 0 0 transparent}
}
@media (prefers-reduced-motion:reduce){.hp-update-dot{animation:none}}
/* ---------- 设置面板（重新设计）---------- */
.hp-settings-mask{
  position:fixed;inset:0;z-index:70;display:flex;align-items:flex-start;justify-content:flex-end;
  padding:54px 20px 0;background:rgba(10,12,16,.46);backdrop-filter:blur(4px);
  animation:hp-fade .14s ease-out;
}
.hp-root.hp-paper .hp-settings-mask{background:rgba(38,32,26,.38)}
@keyframes hp-fade{from{opacity:0}to{opacity:1}}

.hp-settings{
  width:340px;max-width:calc(100vw - 40px);max-height:calc(100vh - 92px);overflow:auto;
  background:var(--hp-panel,#1b1e24);
  border:1px solid var(--hp-line);border-radius:16px;
  box-shadow:0 24px 64px rgba(0,0,0,.5),0 2px 8px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.04);
  position:relative;z-index:1;
  animation:hp-rise .2s cubic-bezier(.22,.61,.36,1);
}
.hp-root.hp-paper .hp-settings{
  background:var(--hp-card);border:2px solid var(--hp-ink);
  box-shadow:7px 7px 0 var(--hp-ink);
}
@keyframes hp-rise{from{opacity:0;transform:translateY(-8px) scale(.97)}to{opacity:1;transform:none}}

/* 头部 */
.hp-set-head{
  display:flex;align-items:center;justify-content:space-between;
  padding:15px 18px 12px;
}
.hp-set-title{font-size:14px;font-weight:650;letter-spacing:.01em;color:var(--hp-fg)}
.hp-set-x{
  display:inline-flex;align-items:center;justify-content:center;
  width:26px;height:26px;border-radius:8px;border:none;cursor:pointer;
  background:transparent;color:var(--hp-fg-3);transition:background .15s,color .15s;
}
.hp-set-x:hover{background:var(--hp-surface-2);color:var(--hp-fg)}

/* 版本对比卡片：当前 → 最新 并排 */
.hp-set-ver{
  display:flex;align-items:center;gap:10px;
  margin:0 18px;padding:13px 15px;border-radius:12px;
  background:var(--hp-surface-2);
}
.hp-root.hp-paper .hp-set-ver{background:#fff9ec;border:1.5px solid rgba(38,32,26,.1)}
.hp-set-ver-item{flex:1;min-width:0}
.hp-set-ver-k{font-size:10.5px;color:var(--hp-fg-3);margin-bottom:3px;letter-spacing:.02em}
.hp-set-ver-v{
  font-family:ui-monospace,'SF Mono',Menlo,monospace;
  font-size:16px;font-weight:650;color:var(--hp-fg);line-height:1.2;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.hp-set-ver-v.new{color:var(--hp-accent)}
.hp-set-ver-arrow{color:var(--hp-fg-3);font-size:13px;opacity:.55;flex:0 0 auto}

/* 状态条 */
.hp-set-note{
  display:flex;align-items:center;gap:7px;flex-wrap:wrap;
  margin:12px 18px 0;font-size:11.5px;line-height:1.5;color:var(--hp-fg-2);
}
.hp-set-note.ok{color:var(--hp-down)}
.hp-set-note.update{color:var(--hp-accent);font-weight:600}
.hp-set-note.local{color:var(--hp-fg-2)}
.hp-set-note.warn{color:var(--hp-up)}
.hp-set-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;background:currentColor}

/* 升级命令 */
.hp-set-cmd{margin:10px 18px 0}
.hp-set-cmd-k{font-size:10.5px;color:var(--hp-fg-3);margin-bottom:5px}
.hp-set-cmd code{
  display:block;padding:9px 11px;border-radius:9px;
  background:var(--hp-surface-2);border:1px solid var(--hp-sep);
  font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:10.5px;
  line-height:1.6;word-break:break-all;color:var(--hp-fg);
}
.hp-root.hp-paper .hp-set-cmd code{background:#fff9ec}

/* 底部操作 */
.hp-set-foot{display:flex;gap:8px;padding:16px 18px 17px}
.hp-set-btn{
  flex:1;padding:8px 12px;border-radius:9px;cursor:pointer;
  font-size:11.5px;font-weight:550;text-align:center;text-decoration:none;
  border:1px solid var(--hp-line);background:var(--hp-surface-2);color:var(--hp-fg);
  transition:background .15s,border-color .15s,transform .1s;
}
.hp-set-btn:hover:not(:disabled){background:var(--hp-surface);border-color:var(--hp-fg-3)}
.hp-set-btn:active:not(:disabled){transform:translateY(1px)}
.hp-set-btn:disabled{opacity:.55;cursor:default}
.hp-set-btn.ghost{background:transparent;color:var(--hp-fg-2)}
.hp-set-btn.ghost:hover{color:var(--hp-fg)}
.hp-root.hp-paper .hp-set-btn{border:1.5px solid var(--hp-ink);box-shadow:2px 2px 0 var(--hp-ink);background:var(--hp-card)}
.hp-root.hp-paper .hp-set-btn.ghost{box-shadow:none;border-color:rgba(38,32,26,.35)}

/* ---------- 数据署名（CC BY 4.0 要求，放右下角不干扰主视觉）---------- */
.hp-attr{
  display:flex;justify-content:flex-end;align-items:center;gap:5px;
  padding:10px 22px 12px;margin-top:auto;
  font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  font-size:10px;letter-spacing:.02em;
  color:var(--hp-fg-3);opacity:.6;
  transition:opacity .18s;
}
.hp-attr:hover{opacity:.95}
.hp-attr-dot{opacity:.5;margin:0 1px}
.hp-attr a{
  color:inherit;text-decoration:none;
  border-bottom:1px solid transparent;transition:border-color .18s;
}
.hp-attr a:hover{border-bottom-color:currentColor}
/* 纸感主题下用墨色细线，不突兀 */
.hp-root.hp-paper .hp-attr{opacity:.55}
.hp-root.hp-paper .hp-attr:hover{opacity:.85}
.hp-actions{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;flex:0 0 auto;margin-left:auto}
.hp-head .hp-meta{flex:1 1 auto;min-width:0;justify-content:flex-end;overflow:hidden;white-space:nowrap}
/* ---------- 简介：中文优先 ---------- */
.hp-zh-pending{display:inline-block;margin-left:6px;font-size:10px;padding:0 4px;border-radius:4px;background:var(--hp-surface-2);color:var(--hp-fg-3);vertical-align:middle}
.hp-desc.zh{font-family:var(--dsw-font,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif);letter-spacing:.01em;line-height:1.65}
.hp-intro.zh{font-size:13.5px;line-height:1.75;color:var(--hp-fg)}
.hp-intro-en{font-size:12px;line-height:1.65;color:var(--hp-fg-3);margin-top:10px;padding-top:9px;border-top:1px dashed var(--hp-sep)}
@media(max-width:900px){
  .hp-head{flex-wrap:wrap;overflow:visible}
  .hp-head .hp-spacer{display:none}
  .hp-head>.hp-actions{flex:1 1 auto;flex-wrap:wrap;margin-left:0}
}

/* ---------- 首屏主角（先给答案）---------- */
.hp-hero{display:flex;gap:18px;align-items:stretch;padding:18px 20px 6px;flex-wrap:wrap}
.hp-hero-main{flex:1 1 320px;min-width:260px;border:var(--hp-border);border-radius:var(--hp-radius);background:var(--hp-card-bg);box-shadow:var(--hp-shadow);padding:16px 20px 15px}
.hp-hero-k{font-size:11.5px;font-weight:600;letter-spacing:.06em;color:var(--hp-fg-3);margin-bottom:2px}
.hp-hero-v{font-size:clamp(34px,5vw,52px);font-weight:800;line-height:1.04;letter-spacing:-.03em;color:var(--hp-up);font-variant-numeric:tabular-nums}
.hp-hero-sub{font-size:12.5px;color:var(--hp-fg-2);margin-top:7px}
.hp-hero-side{display:grid;grid-template-columns:repeat(3,minmax(96px,1fr));gap:10px;flex:0 1 auto}
.hp-stat-card{border:var(--hp-border);border-radius:11px;padding:10px 13px;background:var(--hp-surface);box-shadow:var(--hp-shadow);min-width:96px;display:flex;flex-direction:column;justify-content:center}
.hp-stat-k{font-size:10.5px;color:var(--hp-fg-3);margin-bottom:3px;white-space:nowrap}
.hp-stat-v{font-size:17px;font-weight:750;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
/* 纸感主题：三张统计卡上色，像便签 */
.hp-root.hp-paper .hp-stat-card.rose{background:#ffb9cc}
.hp-root.hp-paper .hp-stat-card.sky{background:#a5dcff}
.hp-root.hp-paper .hp-stat-card.sun{background:#ffd84d}
.hp-root.hp-paper .hp-hero-main{background:var(--hp-card)}

.hp-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px;padding:16px 20px 28px}
.hp-card{position:relative;border:var(--hp-border);border-radius:var(--hp-radius);padding:13px 15px 11px;display:flex;flex-direction:column;background:var(--hp-card-bg);box-shadow:var(--hp-shadow);cursor:pointer;transition:transform .14s ease,box-shadow .14s,border-color .14s;overflow:hidden}
.hp-card:hover{transform:translateY(-2px);box-shadow:var(--hp-shadow-hover)}
.hp-root.hp-dark .hp-card:hover{border-color:rgba(122,92,255,.5)}
.hp-card.sel{box-shadow:0 0 0 2px var(--hp-accent),var(--hp-shadow-hover)}
.hp-card.top1{background:linear-gradient(135deg,rgba(217,165,43,.13),var(--hp-card-bg) 55%)}
.hp-card.top2{background:linear-gradient(135deg,rgba(154,164,178,.12),var(--hp-card-bg) 55%)}
.hp-card.top3{background:linear-gradient(135deg,rgba(192,122,62,.13),var(--hp-card-bg) 55%)}
/* 纸感主题下前三名用实色贴纸，而不是渐变 */
.hp-root.hp-paper .hp-card.top1{background:linear-gradient(135deg,#fff6d6,#fffdf7 60%)}
.hp-root.hp-paper .hp-card.top2{background:linear-gradient(135deg,#f3f1ec,#fffdf7 60%)}
.hp-root.hp-paper .hp-card.top3{background:linear-gradient(135deg,#ffeadb,#fffdf7 60%)}
.hp-card-head{display:flex;align-items:flex-start;gap:11px}
/* 新面孔徽章：小而醒目，不抢涨星数的主视觉 */
.hp-new{
  display:inline-flex;align-items:center;justify-content:center;
  margin-left:7px;padding:0 6px;height:16px;
  border-radius:5px;
  font-size:9px;font-weight:800;letter-spacing:.06em;line-height:1;
  font-family:ui-monospace,'SF Mono',Menlo,monospace;
  color:#fff;background:var(--hp-up);
  vertical-align:middle;
  box-shadow:0 1px 4px color-mix(in srgb, var(--hp-up) 40%, transparent);
  animation:hp-new-in .28s cubic-bezier(.22,.61,.36,1);
}
@keyframes hp-new-in{from{opacity:0;transform:scale(.8)}to{opacity:1;transform:none}}
/* 纸感主题：贴纸风，加墨色描边和实体阴影 */
.hp-root.hp-paper .hp-new{
  color:var(--hp-ink);background:var(--hp-gold);
  border:1.5px solid var(--hp-ink);
  box-shadow:1.5px 1.5px 0 var(--hp-ink);
}
@media (prefers-reduced-motion:reduce){.hp-new{animation:none}}

.hp-rank{flex:0 0 auto;width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;background:var(--hp-surface-2);color:var(--hp-fg-2)}
.hp-root.hp-paper .hp-rank{border:2px solid var(--hp-ink);box-shadow:2px 2px 0 var(--hp-ink)}
.hp-rank.r1{background:linear-gradient(135deg,#e8b53a,#c9901f);color:#2a1c00;box-shadow:0 2px 10px rgba(217,165,43,.45)}
.hp-rank.r2{background:linear-gradient(135deg,#c8d0da,#95a0ad);color:#1d242c}
.hp-rank.r3{background:linear-gradient(135deg,#d4945a,#a9652f);color:#2a1400}
.hp-title{flex:1;min-width:0}
.hp-name{font-size:14.5px;font-weight:650;letter-spacing:.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hp-name .owner{color:var(--hp-fg-3);font-weight:450}
.hp-sub{font-size:11.5px;color:var(--hp-fg-3);margin-top:3px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.hp-chip{font-size:10.5px;padding:1px 7px;border-radius:999px;background:var(--hp-surface-2);color:var(--hp-fg-2);white-space:nowrap}
.hp-root.hp-paper .hp-chip{border:1.5px solid var(--hp-ink);background:#fff;font-weight:600}
.hp-root.hp-paper .hp-chip.pct{background:var(--hp-gold)}
.hp-root.hp-paper .hp-chip.lic{background:#a5dcff}
.hp-gain{text-align:right;font-variant-numeric:tabular-nums;flex:0 0 auto;padding-left:6px}
.hp-gain-v{font-size:21px;font-weight:780;line-height:1.05;letter-spacing:-.5px}
.hp-gain-v.up{color:var(--hp-up)}
.hp-root.hp-dark .hp-gain-v.up{text-shadow:0 0 18px rgba(229,72,77,.35)}
.hp-gain-v.flat{color:var(--hp-fg-2)}
.hp-gain-s{font-size:10.5px;color:var(--hp-fg-3);margin-top:2px}
/* 简介：取不到就整块不渲染，所以这里**不设 min-height**，避免空灰色占位 */
.hp-desc{margin:9px 0 0;font-size:12.5px;line-height:1.6;color:var(--hp-fg-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.hp-desc-loading{margin-top:10px;display:flex;flex-direction:column;gap:5px}
.hp-desc-loading i{display:block;height:8px;border-radius:4px;background:linear-gradient(100deg,var(--hp-surface-2) 30%,var(--hp-sep) 50%,var(--hp-surface-2) 70%);background-size:220% 100%;animation:hp-shimmer 1.4s infinite linear}
.hp-desc-loading i:last-child{width:62%}
/* 卡片底部：右下角迷你走势 */
.hp-card-foot{display:flex;justify-content:flex-end;margin-top:6px;margin-bottom:-2px}
.hp-spark{width:132px;height:34px;opacity:.85;transition:opacity .16s}
.hp-card:hover .hp-spark{opacity:1}
.hp-card-loading{height:120px;border-radius:var(--hp-radius);border:var(--hp-border);background:linear-gradient(100deg,var(--hp-surface) 30%,var(--hp-surface-2) 50%,var(--hp-surface) 70%);background-size:220% 100%;animation:hp-shimmer 1.5s infinite linear}
@keyframes hp-shimmer{0%{background-position:130% 0}100%{background-position:-30% 0}}
.hp-more{display:flex;justify-content:center;padding:0 20px 30px}

/* ---------- 详情面板 ---------- */
.hp-detail{margin:16px 20px 28px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.09));border-radius:15px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.035));overflow:hidden}
.hp-detail-head{display:flex;align-items:center;gap:12px;padding:15px 18px;border-bottom:1px solid var(--dsw-alias-separator-primary,rgba(255,255,255,.07))}
.hp-detail-head .hp-name{font-size:16px}
.hp-close{margin-left:auto;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.5));font-size:19px;cursor:pointer;line-height:1;padding:4px 7px;border-radius:7px}
.hp-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:#fff}
.hp-detail-body{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(240px,.85fr);gap:0}
@media (max-width:820px){.hp-detail-body{grid-template-columns:1fr}}
.hp-pane{padding:16px 18px}
.hp-pane + .hp-pane{border-left:1px solid var(--dsw-alias-separator-primary,rgba(255,255,255,.07))}
@media (max-width:820px){.hp-pane + .hp-pane{border-left:0;border-top:1px solid var(--dsw-alias-separator-primary,rgba(255,255,255,.07))}}
.hp-pane-title{font-size:11px;font-weight:650;letter-spacing:.09em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.42));margin-bottom:9px;display:flex;align-items:center;gap:7px}
.hp-pane-title::after{content:'';flex:1;height:1px;background:var(--dsw-alias-separator-primary,rgba(255,255,255,.07))}
.hp-intro{font-size:13px;line-height:1.68;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.78))}
.hp-intro.none{color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.4));font-style:italic}
.hp-srcline{font-size:11px;margin-top:9px;line-height:1.5;color:var(--hp-fg-3)}
.hp-srcline a{color:inherit;text-decoration:none;border-bottom:1px dotted currentColor}
.hp-srcline a:hover{color:var(--hp-fg)}
.hp-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:14px}
.hp-kpi{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.07));border-radius:9px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.18))}
.hp-kpi-k{font-size:10.5px;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.4));margin-bottom:3px}
.hp-kpi-v{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.hp-kpi-v.up{color:var(--hp-up)}
.hp-links{display:flex;gap:8px;flex-wrap:wrap;margin-top:13px}
.hp-link{font-size:12px;padding:5px 11px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));color:var(--dsw-alias-label-secondary,rgba(255,255,255,.72));text-decoration:none;transition:all .15s}
.hp-link:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:#fff}

/* ---------- 趋势图 ---------- */
.hp-chart{width:100%;height:auto;display:block;overflow:visible}
.hp-chart-wrap{position:relative;margin-top:2px}
.hp-chart-empty{font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.4));padding:22px 0;text-align:center;font-style:italic}
.hp-chart-legend{display:flex;justify-content:space-between;font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.45));font-variant-numeric:tabular-nums;margin-top:5px}

/* ---------- 头像 ---------- */
.hp-avatar{flex:0 0 auto;border-radius:9px;object-fit:cover;background:var(--hp-surface-2);display:block}
.hp-root.hp-paper .hp-avatar{border:2px solid var(--hp-ink)}
.hp-avatar-fb{display:inline-flex;align-items:center;justify-content:center;color:#fff;font-weight:700;border-radius:9px;flex:0 0 auto;user-select:none}

/* ---------- 右侧操作区 ---------- */
.hp-actions{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;flex:0 0 auto;margin-left:auto}
.hp-head .hp-meta{flex:1 1 auto;min-width:0;justify-content:flex-end;overflow:hidden;white-space:nowrap}
/* ---------- 简介：中文优先 ---------- */
.hp-zh-pending{display:inline-block;margin-left:6px;font-size:10px;padding:0 4px;border-radius:4px;background:var(--hp-surface-2);color:var(--hp-fg-3);vertical-align:middle}
.hp-desc.zh{font-family:var(--dsw-font,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif);letter-spacing:.01em;line-height:1.65}
.hp-intro.zh{font-size:13.5px;line-height:1.75;color:var(--hp-fg)}
.hp-intro-en{font-size:12px;line-height:1.65;color:var(--hp-fg-3);margin-top:10px;padding-top:9px;border-top:1px dashed var(--hp-sep)}

/* ---------- 首屏主角（先给答案）---------- */
.hp-hero{display:flex;gap:18px;align-items:stretch;padding:18px 20px 6px;flex-wrap:wrap}
.hp-hero-main{flex:1 1 320px;min-width:260px;border:var(--hp-border);border-radius:var(--hp-radius);background:var(--hp-card-bg);box-shadow:var(--hp-shadow);padding:16px 20px 15px}
.hp-hero-k{font-size:11.5px;font-weight:600;letter-spacing:.06em;color:var(--hp-fg-3);margin-bottom:2px}
.hp-hero-v{font-size:clamp(34px,5vw,52px);font-weight:800;line-height:1.04;letter-spacing:-.03em;color:var(--hp-up);font-variant-numeric:tabular-nums}
.hp-hero-sub{font-size:12.5px;color:var(--hp-fg-2);margin-top:7px}
.hp-hero-side{display:grid;grid-template-columns:repeat(3,minmax(96px,1fr));gap:10px;flex:0 1 auto}
.hp-stat-card{border:var(--hp-border);border-radius:11px;padding:10px 13px;background:var(--hp-surface);box-shadow:var(--hp-shadow);min-width:96px;display:flex;flex-direction:column;justify-content:center}
.hp-stat-k{font-size:10.5px;color:var(--hp-fg-3);margin-bottom:3px;white-space:nowrap}
.hp-stat-v{font-size:17px;font-weight:750;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
/* 纸感主题：三张统计卡上色，像便签 */
.hp-root.hp-paper .hp-stat-card.rose{background:#ffb9cc}
.hp-root.hp-paper .hp-stat-card.sky{background:#a5dcff}
.hp-root.hp-paper .hp-stat-card.sun{background:#ffd84d}
.hp-root.hp-paper .hp-hero-main{background:var(--hp-card)}

.hp-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px;padding:16px 20px 28px}
.hp-card{position:relative;border:var(--hp-border);border-radius:var(--hp-radius);padding:13px 15px 11px;display:flex;flex-direction:column;background:var(--hp-card-bg);box-shadow:var(--hp-shadow);cursor:pointer;transition:transform .14s ease,box-shadow .14s,border-color .14s;overflow:hidden}
.hp-card:hover{transform:translateY(-2px);box-shadow:var(--hp-shadow-hover)}
.hp-root.hp-dark .hp-card:hover{border-color:rgba(122,92,255,.5)}
.hp-card.sel{box-shadow:0 0 0 2px var(--hp-accent),var(--hp-shadow-hover)}
.hp-card.top1{background:linear-gradient(135deg,rgba(217,165,43,.13),var(--hp-card-bg) 55%)}
.hp-card.top2{background:linear-gradient(135deg,rgba(154,164,178,.12),var(--hp-card-bg) 55%)}
.hp-card.top3{background:linear-gradient(135deg,rgba(192,122,62,.13),var(--hp-card-bg) 55%)}
/* 纸感主题下前三名用实色贴纸，而不是渐变 */
.hp-root.hp-paper .hp-card.top1{background:linear-gradient(135deg,#fff6d6,#fffdf7 60%)}
.hp-root.hp-paper .hp-card.top2{background:linear-gradient(135deg,#f3f1ec,#fffdf7 60%)}
.hp-root.hp-paper .hp-card.top3{background:linear-gradient(135deg,#ffeadb,#fffdf7 60%)}
.hp-card-head{display:flex;align-items:flex-start;gap:11px}
.hp-rank{flex:0 0 auto;width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;background:var(--hp-surface-2);color:var(--hp-fg-2)}
.hp-root.hp-paper .hp-rank{border:2px solid var(--hp-ink);box-shadow:2px 2px 0 var(--hp-ink)}
.hp-rank.r1{background:linear-gradient(135deg,#e8b53a,#c9901f);color:#2a1c00;box-shadow:0 2px 10px rgba(217,165,43,.45)}
.hp-rank.r2{background:linear-gradient(135deg,#c8d0da,#95a0ad);color:#1d242c}
.hp-rank.r3{background:linear-gradient(135deg,#d4945a,#a9652f);color:#2a1400}
.hp-title{flex:1;min-width:0}
.hp-name{font-size:14.5px;font-weight:650;letter-spacing:.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hp-name .owner{color:var(--hp-fg-3);font-weight:450}
.hp-sub{font-size:11.5px;color:var(--hp-fg-3);margin-top:3px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.hp-chip{font-size:10.5px;padding:1px 7px;border-radius:999px;background:var(--hp-surface-2);color:var(--hp-fg-2);white-space:nowrap}
.hp-root.hp-paper .hp-chip{border:1.5px solid var(--hp-ink);background:#fff;font-weight:600}
.hp-root.hp-paper .hp-chip.pct{background:var(--hp-gold)}
.hp-root.hp-paper .hp-chip.lic{background:#a5dcff}
.hp-gain{text-align:right;font-variant-numeric:tabular-nums;flex:0 0 auto;padding-left:6px}
.hp-gain-v{font-size:21px;font-weight:780;line-height:1.05;letter-spacing:-.5px}
.hp-gain-v.up{color:var(--hp-up)}
.hp-root.hp-dark .hp-gain-v.up{text-shadow:0 0 18px rgba(229,72,77,.35)}
.hp-gain-v.flat{color:var(--hp-fg-2)}
.hp-gain-s{font-size:10.5px;color:var(--hp-fg-3);margin-top:2px}
/* 简介：取不到就整块不渲染，所以这里**不设 min-height**，避免空灰色占位 */
.hp-desc{margin:9px 0 0;font-size:12.5px;line-height:1.6;color:var(--hp-fg-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.hp-desc-loading{margin-top:10px;display:flex;flex-direction:column;gap:5px}
.hp-desc-loading i{display:block;height:8px;border-radius:4px;background:linear-gradient(100deg,var(--hp-surface-2) 30%,var(--hp-sep) 50%,var(--hp-surface-2) 70%);background-size:220% 100%;animation:hp-shimmer 1.4s infinite linear}
.hp-desc-loading i:last-child{width:62%}
/* 卡片底部：右下角迷你走势 */
.hp-card-foot{display:flex;justify-content:flex-end;margin-top:6px;margin-bottom:-2px}
.hp-spark{width:132px;height:34px;opacity:.85;transition:opacity .16s}
.hp-card:hover .hp-spark{opacity:1}
.hp-card-loading{height:120px;border-radius:var(--hp-radius);border:var(--hp-border);background:linear-gradient(100deg,var(--hp-surface) 30%,var(--hp-surface-2) 50%,var(--hp-surface) 70%);background-size:220% 100%;animation:hp-shimmer 1.5s infinite linear}
@keyframes hp-shimmer{0%{background-position:130% 0}100%{background-position:-30% 0}}
.hp-more{display:flex;justify-content:center;padding:0 20px 30px}

/* ---------- 详情面板 ---------- */
.hp-detail{margin:16px 20px 28px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.09));border-radius:15px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.035));overflow:hidden}
.hp-detail-head{display:flex;align-items:center;gap:12px;padding:15px 18px;border-bottom:1px solid var(--dsw-alias-separator-primary,rgba(255,255,255,.07))}
.hp-detail-head .hp-name{font-size:16px}
.hp-close{margin-left:auto;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.5));font-size:19px;cursor:pointer;line-height:1;padding:4px 7px;border-radius:7px}
.hp-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:#fff}
.hp-detail-body{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(240px,.85fr);gap:0}
@media (max-width:820px){.hp-detail-body{grid-template-columns:1fr}}
.hp-pane{padding:16px 18px}
.hp-pane + .hp-pane{border-left:1px solid var(--dsw-alias-separator-primary,rgba(255,255,255,.07))}
@media (max-width:820px){.hp-pane + .hp-pane{border-left:0;border-top:1px solid var(--dsw-alias-separator-primary,rgba(255,255,255,.07))}}
.hp-pane-title{font-size:11px;font-weight:650;letter-spacing:.09em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.42));margin-bottom:9px;display:flex;align-items:center;gap:7px}
.hp-pane-title::after{content:'';flex:1;height:1px;background:var(--dsw-alias-separator-primary,rgba(255,255,255,.07))}
.hp-intro{font-size:13px;line-height:1.68;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.78))}
.hp-intro.none{color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.4));font-style:italic}
.hp-srcline{font-size:11px;margin-top:9px;line-height:1.5;color:var(--hp-fg-3)}
.hp-srcline a{color:inherit;text-decoration:none;border-bottom:1px dotted currentColor}
.hp-srcline a:hover{color:var(--hp-fg)}
.hp-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:14px}
.hp-kpi{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.07));border-radius:9px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.18))}
.hp-kpi-k{font-size:10.5px;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.4));margin-bottom:3px}
.hp-kpi-v{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.hp-kpi-v.up{color:var(--hp-up)}
.hp-links{display:flex;gap:8px;flex-wrap:wrap;margin-top:13px}
.hp-link{font-size:12px;padding:5px 11px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));color:var(--dsw-alias-label-secondary,rgba(255,255,255,.72));text-decoration:none;transition:all .15s}
.hp-link:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:#fff}

/* ---------- 趋势图 ---------- */
.hp-chart{width:100%;height:auto;display:block;overflow:visible}
.hp-chart-wrap{position:relative;margin-top:2px}
.hp-chart-empty{font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.4));padding:22px 0;text-align:center;font-style:italic}
.hp-chart-legend{display:flex;justify-content:space-between;font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.45));font-variant-numeric:tabular-nums;margin-top:5px}

`;
    doc.head.appendChild(style);
  }

  /* ============================================================ 图表组件 */

  /**
   * 把一串点连成**平滑曲线**（Catmull-Rom 转三次贝塞尔）。
   *
   * 为什么不用折线：星数快照之间是每天一个点，直连会是一串生硬的折角，
   * 看不出「加速 / 放缓」的趋势形状。平滑后曲线读起来更像行情图。
   *
   * 注意：平滑只是**画法**，不改变数据点位置 —— 点仍然落在原坐标上。
   */
  function smoothPath(points) {
    if (!points || points.length === 0) return '';
    if (points.length === 1) return 'M' + points[0][0] + ' ' + points[0][1];
    if (points.length === 2) return 'M' + points[0][0] + ' ' + points[0][1] + ' L' + points[1][0] + ' ' + points[1][1];
    let d = 'M' + points[0][0] + ' ' + points[0][1];
    for (let i = 0; i < points.length - 1; i += 1) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || p2;
      // 控制点系数 1/6 是 Catmull-Rom → 贝塞尔的经典换算
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ' C' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) +
           ' ' + c2x.toFixed(1) + ' ' + c2y.toFixed(1) +
           ' ' + p2[0] + ' ' + p2[1];
    }
    return d;
  }

  /**
   * 星数曲线：带面积填充、端点标记、起止标注。
   *
   * 注意：这是**组件**，必须用 `h(StarChart, { chart })` 渲染，
   * 不能直接调用 —— 直接调用返回的 React 元素会被当成普通对象塞进子节点而报错。
   */
  function StarChart(props) {
    const { React, chart } = props;
    const h = React.createElement;
    if (!chart || !Array.isArray(chart.series) || chart.series.length < 3) {
      const t = (k, v) => translate(props.lang, k, v);
      return h('div', { className: 'hp-chart-empty' }, t('detail.noChart'));
    }
    const W = 560;
    const H = 190;
    const PAD = { l: 8, r: 8, t: 12, b: 24 };
    const series = chart.series;
    const xs = series.map((p) => p.x);
    const ys = series.map((p) => p.stars);
    const xmin = Math.min(...xs);
    const xmax = Math.max(...xs);
    const ymin = Math.min(...ys);
    const ymax = Math.max(...ys);
    const spanX = xmax - xmin || 1;
    const spanY = ymax - ymin || 1;
    const px = (x) => PAD.l + ((x - xmin) / spanX) * (W - PAD.l - PAD.r);
    const py = (v) => H - PAD.b - ((v - ymin) / spanY) * (H - PAD.t - PAD.b);

    const line = series.map((p, i) => (i === 0 ? 'M' : 'L') + px(p.x).toFixed(1) + ' ' + py(p.stars).toFixed(1)).join(' ');
    const area = line + ' L' + px(xmax).toFixed(1) + ' ' + (H - PAD.b) + ' L' + px(xmin).toFixed(1) + ' ' + (H - PAD.b) + ' Z';

    const first = ys[0];
    const last = ys[ys.length - 1];
    const gained = last - first;
    const label = (p) => (p && p.label ? p.label : '');

    return h(
      'div',
      { className: 'hp-chart-wrap' },
      h(
        'svg',
        { className: 'hp-chart', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'xMidYMid meet', role: 'img' },
        h(
          'defs',
          null,
          h(
            'linearGradient',
            { id: 'hp-area-grad', x1: '0', y1: '0', x2: '0', y2: '1' },
            h('stop', { offset: '0%', stopColor: '#e5484d', stopOpacity: '0.42' }),
            h('stop', { offset: '100%', stopColor: '#e5484d', stopOpacity: '0.02' }),
          ),
        ),
        // 水平网格
        [0, 0.25, 0.5, 0.75, 1].map((t, i) => {
          const y = (H - PAD.b) - t * (H - PAD.t - PAD.b);
          const v = ymin + t * spanY;
          return h(
            'g',
            { key: 'g' + i },
            h('line', { x1: PAD.l, x2: W - PAD.r, y1: y, y2: y, stroke: 'rgba(255,255,255,.07)', strokeDasharray: '3 4' }),
            h('text', { x: W - PAD.r, y: y - 3, textAnchor: 'end', fontSize: '9.5', fill: 'rgba(255,255,255,.32)' }, fmtCount(v)),
          );
        }),
        // 面积 + 曲线
        h('path', { d: area, fill: 'url(#hp-area-grad)' }),
        h('path', { d: line, fill: 'none', stroke: '#e5484d', strokeWidth: '2', strokeLinejoin: 'round', strokeLinecap: 'round' }),
        // 端点
        h('circle', { cx: px(xs[0]), cy: py(first), r: '3.2', fill: '#e5484d' }),
        h('circle', { cx: px(xmax), cy: py(last), r: '4', fill: '#e5484d', stroke: '#fff', strokeWidth: '1.4' }),
        // x 轴标签
        (chart.xLabels || []).map((lab, i) =>
          h('text', { key: 'x' + i, x: px(lab.x), y: H - 7, textAnchor: 'middle', fontSize: '9.5', fill: 'rgba(255,255,255,.32)' }, label(lab)),
        ),
      ),
      h(
        'div',
        { className: 'hp-chart-legend' },
        h('span', null, (props.lang === 'en'
          ? 'Start ' + fmtCount(first)
          : '起点 ' + fmtCount(first))),
        h('span', { style: { color: '#ff8a90', fontWeight: 650 } }, '+' + fmtCount(gained) + ' ★'),
        h('span', null, (props.lang === 'en'
          ? 'Now ' + fmtCount(last)
          : '现在 ' + fmtCount(last))),
      ),
    );
  }

  /* ============================================================ 卡片 */

  /**
   * 仓库所有者头像。
   *
   * 走宿主代理接口（/avatar），不是直连 github.com —— 一张卡一次外网请求太快烧钱了。
   * 取不到时退化成「首字母块」，与 GitHub 自己的降级行为一致，不会出现破图标。
   */
  function Avatar(props) {
    const { React, repository, size } = props;
    const h = React.createElement;
    const owner = String(repository || '').split('/')[0] || '?';
    const px = size || 34;
    const [failed, setFailed] = React.useState(false);
    const initial = owner.replace(/^[^a-zA-Z0-9]/, '').slice(0, 1).toUpperCase() || '?';
    // 用固定色相区分不同 owner，避免整屏同色
    let hue = 0;
    for (let i = 0; i < owner.length; i += 1) hue = (hue * 31 + owner.charCodeAt(i)) % 360;
    if (failed) {
      return h(
        'span',
        {
          className: 'hp-avatar hp-avatar-fb',
          style: { width: px, height: px, background: 'hsl(' + hue + ' 45% 38%)', fontSize: Math.round(px * 0.42) },
          title: owner,
        },
        initial,
      );
    }
    // 优先用 /batch 里内联的 data URI（不发额外请求）；
    // 没有才退回 /avatar 接口（每个项目一个请求，只在详情页等少数场景发生）。
    const inline = props.src || null;
    return h('img', {
      className: 'hp-avatar',
      src: inline || BASE + '/avatar?repo=' + encodeURIComponent(repository || owner),
      width: px,
      height: px,
      alt: owner,
      loading: 'lazy',
      onError: () => setFailed(true),
    });
  }

  /**
   * 迷你走势：卡片右下角的一小段星数曲线。
   * 没有曲线数据时**什么都不画** —— 绝不画一条假的水平线充数。
   */
  function Sparkline(props) {
    const { React, chart, tone } = props;
    const h = React.createElement;
    if (!chart || !Array.isArray(chart.series) || chart.series.length < 3) return null;
    const W = 132;
    const H = 34;
    const ys = chart.series.map((p) => p.stars);
    const ymin = Math.min(...ys);
    const ymax = Math.max(...ys);
    const span = ymax - ymin || 1;
    const pts = chart.series.map((p, i) =>
      ((i / (chart.series.length - 1)) * W).toFixed(1) + ',' + (H - 2 - ((p.stars - ymin) / span) * (H - 6)).toFixed(1),
    );
    const color = tone === 'gold' ? '#e8b53a' : '#e5484d';
    return h(
      'svg',
      { className: 'hp-spark', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      h('polyline', { points: pts.join(' '), fill: 'none', stroke: color, strokeWidth: '1.6', strokeLinejoin: 'round', strokeLinecap: 'round', opacity: '0.9' }),
      h('circle', { cx: W, cy: (H - 2 - ((ys[ys.length - 1] - ymin) / span) * (H - 6)).toFixed(1), r: '2.4', fill: color }),
    );
  }

  /**
   * 一张成绩卡。
   *
   * 视觉重心刻意放在**涨星数**上（大号、涨色、带光晕），名次徽章与仓库名次之；
   * 简介只显示两行、取不到就**整块不渲染**（不留「暂无简介」那种灰色占位）；
   * 右下角用迷你走势代替进度条 —— 有曲线才画，没有就不占位。
   */
  function Card(props) {
    const { React } = props;
    const h = React.createElement;
    const { item, maxGain, isSel, onSelect, detail } = props;
    const archived = props.archived === true;
    const isTop = !archived && item.rank <= 3;
    const cls = 'hp-card' + (archived ? ' hp-collection-row' : '') + (isTop ? ' top' + item.rank : '') + (isSel ? ' sel' : '');
    const [owner, repo] = item.repository.split('/');
    const share = maxGain > 0 ? Math.round((item.starsGained / maxGain) * 100) : 0;
    /**
     * 简介显示策略（优先避免等待与空白）：
     *
     *   · 有译文       → 显示中文
     *   · 没译文但有英文 → **先显示英文**（不让用户对着骨架干等模型）
     *   · 什么都没有    → 骨架
     *
     * 之前选「中文」时会等译文、期间显示骨架，结果点了中文要等十几秒才出字 ——
     * 那个体验很差。现在英文秒到就先给内容，中文来了原地替换。
     * 英文模式下也一样，只是不再触发翻译。
     */
    const descZh = detail && detail.descZh ? detail.descZh : null;
    const descEn = detail && detail.desc ? detail.desc : null;
    const lang = props.lang === 'en' ? 'en' : 'zh';
    /**
     * 严格按语言选：英文模式就显示英文（哪怕库里还留着中文译文），
     * 中文模式优先中文、没译文时先用英文顶着。
     * 之前写成 `descZh || descEn`，结果英文模式下也会显示中文 —— 与按钮状态矛盾。
     */
    const desc = lang === 'en' ? descEn || descZh : descZh || descEn;
    // 中文模式下有英文但还没译文 → 标记「翻译中」，界面上给个小提示
    const translating = lang === 'zh' && !descZh && !!descEn;
    return h(
      'article',
      {
        className: cls,
        onClick: () => onSelect(item),
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(item); } },
        role: 'button',
        tabIndex: 0,
        title: item.repository + (desc ? '\n' + desc : ''),
      },
      // ── 顶部：名次 + 仓库名 + 涨星 ──
      h(
        'div',
        { className: 'hp-card-head' },
        h(Avatar, { React, repository: item.repository, size: isTop ? 40 : 34, src: detail && detail.avatar }),
        !archived ? h('div', { className: 'hp-rank' + (isTop ? ' r' + item.rank : '') }, item.rank) : null,
        h(
          'div',
          { className: 'hp-title' },
          h(
            'div',
            { className: 'hp-name' },
            h('span', { className: 'owner' }, owner + '/'),
            repo,
            /**
             * 新面孔徽章：名次变化列为空 → 昨天不在榜。
             * 用一个小 pill 标出来，扫一眼就能看到今天有哪些新项目冲上来了。
             */
            !archived && item.isNew ? h('span', { className: 'hp-new', title: translate(props.lang, 'card.newTip') }, 'NEW') : null,
          ),
          h(
            'div',
            { className: 'hp-sub' },
            item.language ? h('span', { className: 'hp-chip' }, item.language) : null,
            item.growthPct !== null ? h('span', { className: 'hp-chip pct' }, fmtPct(item.growthPct)) : null,
            item.license ? h('span', { className: 'hp-chip lic' }, item.license) : null,
          ),
        ),
        h(
          'div',
          { className: 'hp-gain' },
          h('div', { className: 'hp-gain-v ' + gainTone(item.starsGained) }, (item.starsGained >= 0 ? '+' : '') + fmtCount(item.starsGained)),
          h('div', { className: 'hp-gain-s' }, archived ? translate(props.lang, 'collection.gainLabel') : share >= 60 ? translate(props.lang, 'board.topGain') : item.endStars ? fmtCount(item.endStars) + ' stars' : ''),
        ),
      ),
      // ── 简介：有才渲染 ──
      desc
        ? h('p', { className: 'hp-desc' + (descZh ? ' zh' : '') }, desc,
            translating ? h('span', { className: 'hp-zh-pending', title: translate(props.lang, 'card.translatingTip') }, translate(props.lang, 'card.translating')) : null)
        : // 还没取完：骨架；取完了却什么都没有（没有该项目分析）：留空不占位
          detail && detail.settled
          ? null
          : h('div', { className: 'hp-desc-loading' }, h('i'), h('i')),
      archived ? h('div', { className: 'hp-collection-meta' },
        item.rank ? h('span', { className: 'hp-chip' }, translate(props.lang, 'collection.rankLabel', { n: item.rank })) : null,
        h('span', null, translate(props.lang, 'collection.dates', { first: item.firstDay, last: item.lastDay }))) : null,
      // ── 底部：迷你走势 ──
      detail && detail.chart
        ? h('div', { className: 'hp-card-foot' }, h(Sparkline, { React, chart: detail.chart, tone: isTop ? 'gold' : 'red' }))
        : null,
    );
  }

  /* ============================================================ 详情视图 */

  function PlainExplanation({ React, repository, lang }) {
    const h = React.createElement;
    const [result, setResult] = React.useState({ status: 'pending' });
    const [attempt, setAttempt] = React.useState(0);
    React.useEffect(() => {
      let alive = true, timer = null;
      const controller = new AbortController();
      const deadline = setTimeout(() => {
        alive = false;
        controller.abort();
        setResult({ status: 'error', reason: 'timeout' });
      }, 10000);
      setResult({ status: 'pending' });
      const poll = async (first) => {
        try {
          const response = await fetch(BASE + '/explain?repo=' + encodeURIComponent(repository) + '&lang=' + lang + (first && attempt > 0 ? '&retry=1' : ''),
            { signal: controller.signal, headers: { Accept: 'application/json' } });
          const body = await response.json();
          if (!alive) return;
          if (!response.ok || !['ready', 'pending', 'error'].includes(body.status) || (body.status === 'ready' && (!body.explanation || typeof body.explanation.what !== 'string'))) throw new Error('generation');
          if (body.status === 'pending') timer = setTimeout(() => void poll(false), 1000);
          else { clearTimeout(deadline); setResult(body); }
        } catch {
          if (alive) { clearTimeout(deadline); setResult({ status: 'error' }); }
        }
      };
      void poll(true);
      return () => { alive = false; clearTimeout(timer); clearTimeout(deadline); controller.abort(); };
    }, [repository, lang, attempt]);
    const t = (key) => translate(lang, key);
    const ready = result.status === 'ready' && result.explanation;
    return h('section', { className: 'hp-plain', 'aria-label': t('plain.title') },
      h('div', { className: 'hp-plain-head' }, h('div', { className: 'hp-pane-title' }, t('plain.title')),
        h('span', { className: 'hp-plain-credit' }, t('plain.credit'))),
      ready ? h('p', { className: 'hp-plain-content' }, result.explanation.what)
        : h('div', { className: 'hp-plain-state', role: 'status' },
          t(result.status === 'pending' ? 'plain.loading' : result.reason === 'timeout' ? 'plain.slow' : result.reason === 'source' ? 'plain.source' : result.reason === 'model' ? 'plain.model' : 'plain.failed')),
      result.status === 'error' ? h('button', { className: 'hp-btn', onClick: () => setAttempt((n) => n + 1) }, t('plain.retry')) : null);
  }

  function Detail(props) {
    const { React } = props;
    const h = React.createElement;
    const { item, detail, loading, error, onClose } = props;
    if (!item) return null;
    const [owner, repo] = item.repository.split('/');
    const d = detail || {};
    return h(
      'div',
      { className: 'hp-detail' },
      h(
        'div',
        { className: 'hp-detail-head' },
        h(Avatar, { React, repository: item.repository, size: 40 }),
        h('div', { className: 'hp-rank' + (item.rank <= 3 ? ' r' + item.rank : '') }, item.rank),
        h(
          'div',
          { className: 'hp-title' },
          h(
            'div',
            { className: 'hp-name' },
            h('span', { className: 'owner' }, owner + ' / '),
            repo,
            item.isNew ? h('span', { className: 'hp-new', title: translate(props.lang, 'card.newTip') }, 'NEW') : null,
          ),
          h(
            'div',
            { className: 'hp-sub' },
            item.language ? h('span', { className: 'hp-chip' }, item.language) : null,
            item.license ? h('span', { className: 'hp-chip' }, item.license) : null,
            d.analysisUpdated ? h('span', { style: { opacity: 0.7 } }, translate(props.lang, 'detail.analysisUpdated', { date: d.analysisUpdated })) : null,
          ),
        ),
        h('div', { className: 'hp-gain', style: { marginLeft: 'auto' } },
          h('div', { className: 'hp-gain-v ' + gainTone(item.starsGained) }, (item.starsGained >= 0 ? '+' : '') + fmtCount(item.starsGained)),
          h('div', { className: 'hp-gain-s' }, item.endStars ? fmtCount(item.endStars) + ' 星' : ''),
        ),
        h('button', { className: 'hp-close', onClick: onClose, title: '关闭' }, '×'),
      ),
      h(
        'div',
        { className: 'hp-detail-body' },
        // 左：一眼看懂（结构化问答）
        h(
          'div',
          { className: 'hp-pane' },
          h('div', { className: 'hp-pane-title' }, translate(props.lang, 'glance.title')),
          loading
            ? h('div', { className: 'hp-intro none' }, translate(props.lang, 'detail.loadingIntro'))
            : (() => {
                /**
                 * 把 glance 的问答渲染成表格式。
                 *
                 * 只显示一段「What is it?」会把「能不能商用」「还在维护吗」这些
                 * 用户最关心的信息丢掉，而且长段落还会被截断。改成一组问答，
                 * 每条答案完整显示（不截断），扫一眼就知道项目底细。
                 *
                 * 问题文本按语言映射到本地化标题；映射不到的原样显示（保证不漏内容）。
                 */
                const items = Array.isArray(d.glance) ? d.glance : [];
                if (items.length === 0) {
                  return d.desc
                    ? h('div', { className: 'hp-intro' }, d.desc)
                    : h('div', { className: 'hp-intro none' }, error ? translate(props.lang, 'detail.readError', { msg: error }) : translate(props.lang, 'detail.noIntro'));
                }
                /**
                 * 只展示这三条。
                 *
                 * 「可以商用吗」「还在维护吗」去掉了：前者是法律判断、后者是会过期的
                 * 时效信息，放在这个面板里容易被当成保证。项目主页/许可证标签已经
                 * 足够回答这两个问题，想深究的人可以点 ↗ hysenlabs 看原文。
                 */
                const QMAP = {
                  'what is it?': 'glance.what',
                  'who is it for?': 'glance.who',
                  'what is it written in?': 'glance.writtenIn',
                };
                // 只保留这三条；译文按原始下标对齐（glanceZh 与 items 等长）
                const zhList = Array.isArray(d.glanceZh) ? d.glanceZh : [];
                const show = items
                  .map((qa, idx) => ({ qa, idx }))
                  .filter(({ qa }) => QMAP[String(qa.q).trim().toLowerCase()]);
                return h(
                  'dl',
                  { className: 'hp-glance' },
                  ...show.map(({ qa, idx }) => {
                    const key = QMAP[String(qa.q).trim().toLowerCase()];
                    const label = translate(props.lang, key) || qa.q;
                    /**
                     * 中文模式下优先显示译文；没译文就先用英文顶着（不空白、不等待）。
                     * 英文模式始终显示原文。
                     */
                    const zh = zhList[idx];
                    const answer = props.lang === 'en' ? qa.a : (zh || qa.a);
                    // 中文模式但这条还没译文 → 在答案上方标一行「正在努力翻译」
                    const pending = props.lang !== 'en' && !zh;
                    return h(
                      'div',
                      { className: 'hp-glance-row', key: idx },
                      h('dt', { className: 'hp-glance-q' }, label),
                      h(
                        'dd',
                        { className: 'hp-glance-a' + (pending ? ' pending' : '') },
                        pending ? h('span', { className: 'hp-tr-hint' }, translate(props.lang, 'glance.translating')) : null,
                        answer,
                      ),
                    );
                  }),
                );
              })(),
          /**
           * 简介的来源说明。
           *
           * 合规要点：这段文字是转载的第三方分析（CC BY 4.0），必须让读者知道
           * 它不是本项目原创。所以明确写出「引用自 Hysen Labs」并带上链接，
           * 同时说明中译是谁做的、原文在哪。
           */
          d.glance && d.glance.length > 0
            ? h(
                'div',
                { className: 'hp-srcline' },
                translate(props.lang, 'glance.footer'),
                ' ',
                h('a', { href: item.hysenUrl || 'https://hysenlabs.com', target: '_blank', rel: 'noreferrer' }, 'Hysen Labs · CC BY 4.0'),
              )
            : null,
          h(
            'div',
            { className: 'hp-kpis' },
            h('div', { className: 'hp-kpi' }, h('div', { className: 'hp-kpi-k' }, translate(props.lang, 'detail.kpiGained')), h('div', { className: 'hp-kpi-v up' }, '+' + fmtCount(item.starsGained))),
            h('div', { className: 'hp-kpi' }, h('div', { className: 'hp-kpi-k' }, translate(props.lang, 'detail.kpiStart')), h('div', { className: 'hp-kpi-v' }, fmtCount(item.startStars))),
            h('div', { className: 'hp-kpi' }, h('div', { className: 'hp-kpi-k' }, translate(props.lang, 'detail.kpiEnd')), h('div', { className: 'hp-kpi-v' }, fmtCount(item.endStars))),
          ),
          h(
            'div',
            { className: 'hp-links' },
            h('a', { className: 'hp-link', href: item.githubUrl, target: '_blank', rel: 'noreferrer' }, '↗ GitHub'),
            // 数据源详情页外链：直接标出站点名，用户一眼知道点过去是什么
            item.hysenUrl
              ? h('a', { className: 'hp-link', href: item.hysenUrl, target: '_blank', rel: 'noreferrer' }, '↗ hysenlabs')
              : null,
          ),
        ),
        // 右：曲线
        h(
          'div',
          { className: 'hp-pane' },
          h('div', { className: 'hp-pane-title' }, translate(props.lang, 'detail.chartTitle')),
          loading || d.chartPending
            ? h('div', { className: 'hp-chart-empty' }, translate(props.lang, 'detail.loading'))
            : h(StarChart, { React, lang: props.lang, chart: d.chart }),
          // 只有真的失败了才报错；pending 时上面已经显示「加载中」，不重复报
          d.chartError && !d.chart && !d.chartPending
            ? h('div', { className: 'hp-chart-empty' }, translate(props.lang, 'detail.chartError', { msg: d.chartError }))
            : null,
          h(PlainExplanation, { key: item.repository + ':' + props.lang, React, repository: item.repository, lang: props.lang === 'en' ? 'en' : 'zh' }),
        ),
      ),
    );
  }

  /* ============================================================ 大盘视图 */

  /** 多曲线对比用的色板（8 条以内，之后循环）。 */
  const SERIES_COLORS = ['#3a6fe0', '#30a46c', '#e8b53a', '#e5484d', '#7b5cff', '#12a594', '#f76b15', '#8e4ec6'];

  function comparisonSamples(chart, start, end) {
    const byDate = new Map();
    for (const p of chart && Array.isArray(chart.series) ? chart.series : []) {
      const ts = p && Date.parse(p.date);
      if (!Number.isFinite(ts) || !Number.isFinite(p.stars)) continue;
      if (Number.isFinite(start) && ts < start) continue;
      if (Number.isFinite(end) && ts > end) continue;
      byDate.set(p.date, p);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * 统计视图 —— 多项目星数曲线对比。
   *
   * 先用榜单原始数值比较本期涨星，再用期内采样曲线观察趋势。
   * 曲线按真实日期对齐；来源是 SVG 还原值，不能替代榜单精确值。
   */
  function Dashboard(props) {
    const { React } = props;
    const h = React.createElement;
    const { rows, charts, lang, periodKey } = props;
    const isDaily = periodKey === 'day';
    const windowStart = props.window && props.window.start ? Date.parse(props.window.start) : NaN;
    const windowEnd = props.window && props.window.end ? Date.parse(props.window.end) : NaN;

    // 选项给全部（最多 20 条榜单），默认对比前 10 个 —— 再多线会糊成一团
    const [picked, setPicked] = React.useState(() => new Set((rows || []).slice(0, DEFAULT_COMPARE).map((r) => r.repository)));
    const [hover, setHover] = React.useState(null);
    const [showAllGains, setShowAllGains] = React.useState(false);

    // 数据换了一批（切榜单）时重置选择
    React.useEffect(() => {
      setPicked(new Set((rows || []).slice(0, DEFAULT_COMPARE).map((r) => r.repository)));
    }, [rows]);

    const toggle = (repo) => {
      setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(repo)) next.delete(repo);
        else if (next.size < MAX_COMPARE) next.add(repo);
        return next;
      });
    };

    /**
     * 批量勾选：0 = 清空，其他 = 选中名次最前的 n 个。
     *
     * 只选**有曲线的**项目 —— 没曲线的勾上也不会画线，等于白勾，
     * 用户会以为按钮没生效。
     */
    const onPickPreset = React.useCallback((n) => {
      if (!n || n <= 0) {
        setPicked(new Set());
        return;
      }
      const candidates = (rows || []).filter((r) => {
        if (isDaily) return true;
        // charts[repo] 是 { series: [...] }，曲线数组在 .series 上（不是对象本身）
        const c = charts && charts[r.repository];
        return Array.isArray(c && c.series) && comparisonSamples(c, windowStart, windowEnd).length >= 2;
      });
      setPicked(new Set(candidates.slice(0, Math.min(n, MAX_COMPARE)).map((r) => r.repository)));
    }, [rows, charts, windowStart, windowEnd, isDaily]);

    // 只用榜单周期内的实际采样点；不补造缺失的日期或星数。
    const seriesList = React.useMemo(() => {
      const raw = [];
      for (const row of rows || []) {
        if (!picked.has(row.repository)) continue;
        const chart = charts && charts[row.repository];
        if (!chart || !Array.isArray(chart.series)) continue;
        const points = comparisonSamples(chart, windowStart, windowEnd);
        if (points.length < 2) continue;
        const baseStars = points[0].stars;
        raw.push({
          repo: row.repository,
          color: SERIES_COLORS[(rows || []).indexOf(row) % SERIES_COLORS.length],
          points: points.map((p) => ({ date: p.date, stars: p.stars, gained: p.stars - baseStars })),
          baseDate: points[0].date,
          row,
        });
      }
      return raw;
    }, [rows, charts, picked, windowStart, windowEnd]);

    // 对称对数保留掉星；普通 log(max(0, v)) 会把所有负增长画成零。
    const LOG_BASE = 1;
    const logV = (v) => Math.sign(v) * Math.log10(Math.abs(v) + LOG_BASE);
    const signed = (v) => (v > 0 ? '+' : '') + fmtCount(v);
    const frame = React.useMemo(() => {
      if (seriesList.length === 0) return null;
      let minDate = Infinity;
      let maxDate = -Infinity;
      let minV = Infinity;
      let maxV = -Infinity;
      for (const s of seriesList) {
        for (const p of s.points) {
          const t = Date.parse(p.date);
          if (t < minDate) minDate = t;
          if (t > maxDate) maxDate = t;
          const v = p.gained;
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
      }
      const magnitudes = seriesList.map((s) => Math.abs(s.points[s.points.length - 1].gained)).filter((v) => v > 0);
      const useLog = magnitudes.length > 1 && Math.max(...magnitudes) / Math.min(...magnitudes) > 10;
      if (!useLog) {
        const rawStep = Math.max(1, (maxV - minV) / 4);
        const unit = Math.pow(10, Math.floor(Math.log10(rawStep)));
        const step = [1, 2, 5, 10].find((n) => n * unit >= rawStep) * unit;
        const lo = Math.floor(Math.min(0, minV) / step) * step;
        const hi = Math.max(lo + step, Math.ceil(Math.max(0, maxV) / step) * step);
        return { minDate, maxDate, minV, maxV, lo, hi, step, useLog };
      }
      const loRaw = logV(minV);
      const hiRaw = logV(maxV);
      const pad = Math.max(0.12, (hiRaw - loRaw) * 0.06);
      const lo = loRaw - pad;
      const hi = hiRaw > loRaw ? hiRaw + pad : loRaw + 1;
      return { minDate, maxDate, minV, maxV, lo, hi, useLog };
    }, [seriesList]);

    const ready = rows && rows.length > 0;
    const maxGain = Math.max(1, ...(rows || []).map((r) => Math.abs(r.starsGained)));

    // ── 左栏：项目勾选列表 ──
    const picker = h(
      'aside',
      { className: 'hp-picker' },
      // 快捷按钮需要回调，见下方 onPickPreset
      h('div', { className: 'hp-picker-title' }, translate(props.lang, 'stats.pickerTitle'), h('span', { className: 'hp-picker-n' }, picked.size + ' / ' + MAX_COMPARE)),
      /**
       * 快捷选择：一次勾 5 个 / 10 个 / 全部，或者一键清空。
       * 20 个项目逐个点太累，这里按「名次顺序」批量选中（前 N 名通常才是最值得比的）。
       */
      h('div', { className: 'hp-pick-actions' },
        h('button', {
          className: 'hp-pick-btn',
          onClick: () => onPickPreset(5),
        }, translate(props.lang, 'stats.pickTop', { n: 5 })),
        h('button', {
          className: 'hp-pick-btn',
          onClick: () => onPickPreset(10),
        }, translate(props.lang, 'stats.pickTop', { n: 10 })),
        h('button', {
          className: 'hp-pick-btn',
          onClick: () => onPickPreset(MAX_COMPARE),
        }, translate(props.lang, 'stats.pickAll')),
        h('span', { className: 'hp-pick-sep' }),
        h('button', {
          className: 'hp-pick-btn clear',
          onClick: () => onPickPreset(0),
          disabled: picked.size === 0,
        }, translate(props.lang, 'stats.pickClear')),
      ),
      h(
        'div',
        { className: 'hp-picker-list' },
        (rows || []).map((row) => {
          const on = picked.has(row.repository);
          // charts 是 details[repo] = { desc, chart, ... }，曲线在 .chart.series
          const hasChart = isDaily || comparisonSamples(charts && charts[row.repository], windowStart, windowEnd).length >= 2;
          const color = seriesList.find((s) => s.repo === row.repository)?.color;
          return h(
            'label',
            { key: row.repository, className: 'hp-pick' + (on ? ' on' : '') + (hasChart ? '' : ' no-data') },
            h('input', {
              type: 'checkbox',
              checked: on,
              disabled: !hasChart && !on,
              onChange: () => toggle(row.repository),
            }),
            h('span', { className: 'hp-pick-dot', style: color ? { background: color } : undefined }),
            h(Avatar, { React, repository: row.repository, size: 18 }),
            h('span', { className: 'hp-pick-name', title: row.repository }, row.repository),
            h('span', { className: 'hp-pick-v' }, '+' + fmtCount(row.starsGained)),
          );
        }),
      ),
    );

    // ── 右栏：多曲线图 ──
    const W = 760;
    const H = isDaily ? 340 : Math.max(340, seriesList.length * 22 + 48);
    const PAD = { l: 54, r: isDaily ? 16 : 52, t: 18, b: 30 };
    let chartNode = null;
    if (isDaily && picked.size > 0) {
      const dailyRows = (rows || []).filter((r) => picked.has(r.repository));
      const rawMin = Math.min(0, ...dailyRows.map((r) => r.starsGained));
      const rawMax = Math.max(1, ...dailyRows.map((r) => r.starsGained));
      const tickBase = Math.pow(10, Math.floor(Math.log10((rawMax - rawMin) / 4)));
      const tickStep = Math.max(1, Math.ceil((rawMax - rawMin) / 4 / tickBase) * tickBase);
      const min = Math.floor(rawMin / tickStep) * tickStep;
      const max = Math.ceil(rawMax / tickStep) * tickStep;
      const span = max - min;
      const py = (value) => H - PAD.b - (value - min) / span * (H - PAD.t - PAD.b - 18);
      const px = (row) => PAD.l + ((dailyRows.indexOf(row) + 0.5) / dailyRows.length) * (W - PAD.l - PAD.r);
      const hovered = dailyRows.find((r) => r.repository === hover);
      chartNode = h('div', { className: 'hp-mchart' },
        h('svg', { viewBox: '0 0 ' + W + ' ' + H, className: 'hp-mchart-svg', role: 'img', 'aria-label': translate(lang, 'stats.dailyTitle') },
          Array.from({ length: Math.round(span / tickStep) + 1 }, (_, i) => min + i * tickStep).map((value) => {
            return h('g', { key: value },
              h('line', { x1: PAD.l, x2: W - PAD.r, y1: py(value), y2: py(value), className: value === 0 ? 'hp-zero' : 'hp-grid' }),
              h('text', { x: PAD.l - 8, y: py(value) + 3.5, textAnchor: 'end', className: 'hp-axis' }, signed(value)),
            );
          }),
          dailyRows.map((row) => {
            const x = px(row), y = py(row.starsGained);
            const owner = row.repository.split('/')[0];
            const label = row.repository + ' · ' + (row.starsGained > 0 ? '+' : '') + row.starsGained.toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN');
            const color = SERIES_COLORS[rows.indexOf(row) % SERIES_COLORS.length];
            const clipId = 'hp-daily-av-' + row.rank;
            return h('g', { key: row.repository, tabIndex: 0, role: 'img', 'aria-label': label,
              onMouseEnter: () => setHover(row.repository), onMouseLeave: () => setHover(null),
              onFocus: () => setHover(row.repository), onBlur: () => setHover(null),
              opacity: hover && hover !== row.repository ? 0.35 : 1 },
              h('title', null, label),
              h('defs', null, h('clipPath', { id: clipId }, h('circle', { cx: x, cy: y, r: 11 }))),
              h('circle', { cx: x, cy: y, r: 12, fill: color }),
              h('text', { x, y: y + 3.5, textAnchor: 'middle', fill: '#fff', fontSize: 10 }, owner.slice(0, 1).toUpperCase()),
              h('image', { className: 'hp-daily-avatar', href: BASE + '/avatar?owner=' + encodeURIComponent(owner), x: x - 11, y: y - 11, width: 22, height: 22, clipPath: 'url(#' + clipId + ')', preserveAspectRatio: 'xMidYMid slice' }),
              h('circle', { cx: x, cy: y, r: 12, fill: 'none', stroke: color, strokeWidth: hover === row.repository ? 3 : 1.5 }),
              h('text', { x, y: H - 9, textAnchor: 'middle', className: 'hp-axis' }, '#' + row.rank),
            );
          }),
          hovered ? h('text', { x: W / 2, y: 15, textAnchor: 'middle', className: 'hp-axis' }, hovered.repository + ' · ' + (hovered.starsGained > 0 ? '+' : '') + hovered.starsGained.toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN')) : null,
        ),
      );
    } else if (isDaily || seriesList.length === 0) {
      chartNode = h('div', { className: 'hp-chart-empty' }, translate(props.lang, 'stats.emptyHint'));
    } else if (frame) {
      const { minDate, maxDate, minV, maxV, lo, hi, step, useLog } = frame;
      const spanX = maxDate - minDate || 1;
      const px = (date) => PAD.l + ((Date.parse(date) - minDate) / spanX) * (W - PAD.l - PAD.r);
      /** 值 → 屏幕 y（对数）。 */
      const py = (v) => H - PAD.b - (((useLog ? logV(v) : v) - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
      const val = (p) => p.gained;

      /**
       * y 轴刻度取「10 的整数次幂」：1 / 10 / 100 / 1k / 10k / 100k / 1M…
       * 只保留落在可视范围内的那些，最多 7 条 —— 这就是对数图的读法。
       */
      const decadeTicks = [];
      if (lo <= 0 && hi >= 0) decadeTicks.push({ value: 0, y: py(0) });
      for (let e = 0; e <= 7; e += 1) {
        const value = Math.pow(10, e);
        if (logV(value) >= lo - 0.001 && logV(value) <= hi + 0.001) {
          decadeTicks.push({ value, y: py(value) });
        }
        if (logV(-value) >= lo - 0.001 && logV(-value) <= hi + 0.001) {
          decadeTicks.push({ value: -value, y: py(-value) });
        }
      }
      // 范围太窄（一个量级以内）时补中间刻度，避免只有一条线
      const gridLines = !useLog
        ? Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => ({ value: lo + i * step, y: py(lo + i * step) }))
        : decadeTicks.length >= 2
        ? decadeTicks
        : [0, 0.25, 0.5, 0.75, 1].map((t) => {
            const target = lo + t * (hi - lo);
            const value = Math.sign(target) * (Math.pow(10, Math.abs(target)) - LOG_BASE);
            return { value, y: py(value) };
          });

      // x 轴日期刻度（5 个）
      const tickDates = [...new Set([0, 0.25, 0.5, 0.75, 1].map((t) =>
        new Date(minDate + t * spanX).toISOString().slice(0, 10)))];
      const xTicks = tickDates.map((date) => {
        const ts = Date.parse(date);
        const d = new Date(ts);
        // 用 UTC 取月/日，避免本地时区把刻度挪一天
        return { x: px(new Date(ts).toISOString().slice(0, 10)), label: (d.getUTCMonth() + 1) + '/' + d.getUTCDate() };
      });

      // 曲线终点保持真实坐标，只把头像移到右侧等间距排布，用引导线关联。
      const endpointLabels = seriesList.map((s) => {
        const last = s.points[s.points.length - 1];
        return { s, cx: px(last.date), cy: py(last.gained), labelY: py(last.gained) };
      }).sort((a, b) => a.cy - b.cy);
      for (let i = 0; i < endpointLabels.length; i++) {
        endpointLabels[i].labelY = Math.max(endpointLabels[i].cy, PAD.t + 10, i ? endpointLabels[i - 1].labelY + 22 : 0);
      }
      if (endpointLabels.length) {
        endpointLabels.at(-1).labelY = Math.min(endpointLabels.at(-1).labelY, H - PAD.b - 10);
        for (let i = endpointLabels.length - 2; i >= 0; i--) {
          endpointLabels[i].labelY = Math.min(endpointLabels[i].labelY, endpointLabels[i + 1].labelY - 22);
        }
      }

      chartNode = h(
        'div',
        // key 里带周期：换榜单时整个图重建一次，配 CSS 淡入，避免生硬跳变
        { className: 'hp-mchart', key: 'chart-' + periodKey },
        h(
          'svg',
          { viewBox: '0 0 ' + W + ' ' + H, className: 'hp-mchart-svg', role: 'img' },
          // 网格
          gridLines.map((g, i) =>
            h(
              'g',
              { key: 'g' + i },
              h('line', { x1: PAD.l, x2: W - PAD.r, y1: g.y, y2: g.y, className: 'hp-grid' }),
              h('text', { x: PAD.l - 8, y: g.y + 3.5, textAnchor: 'end', className: 'hp-axis' },
                signed(g.value)),
            ),
          ),
          // x 轴
          xTicks.map((t, i) => h('text', { key: 'x' + i, x: t.x, y: H - 9, textAnchor: 'middle', className: 'hp-axis' }, t.label)),
          // 零线（涨幅模式下有意义）
          minV < 0 && maxV > 0
            ? h('line', { x1: PAD.l, x2: W - PAD.r, y1: py(0), y2: py(0), className: 'hp-zero' })
            : null,
          // 每条曲线
          seriesList.map((s) => {
            const d = s.points.map((p, i) => (i ? 'L' : 'M') + px(p.date).toFixed(1) + ' ' + py(val(p)).toFixed(1)).join(' ');
            const dim = hover !== null && hover !== s.repo;
            return h('path', {
              d,
              fill: 'none',
              stroke: s.color,
              strokeDasharray: [undefined, '6 4', '2 3'][Math.floor((rows || []).findIndex((r) => r.repository === s.repo) / SERIES_COLORS.length)],
              strokeWidth: hover === s.repo ? 2.8 : 1.9,
              strokeLinejoin: 'round',
              strokeLinecap: 'round',
              opacity: dim ? 0.22 : 1,
              // 换榜单时让线「重新画一遍」，视觉上说明数据换了
              className: 'hp-series',
              key: 'p-' + s.repo + '-' + periodKey,
              style: { transition: 'opacity .15s, stroke-width .15s' },
            });
          }),
          // 末端圆点
          // 每条线末端用**项目头像**代替圆点（像行情软件在线尾标品牌）。
          // 用 <clipPath> 裁成圆形；头像可能加载失败，失败时退化成同色圆点，绝不出现空白。
          endpointLabels.map(({ s, cx: trueX, cy: trueY, labelY }, i) => {
            const cx = W - 14;
            const cy = labelY;
            const r = 9;
            const owner = String(s.repo).split('/')[0] || '?';
            const clipId = 'hp-av-' + i;
            const dim = hover !== null && hover !== s.repo;
            return h(
              'g',
              { key: 'end' + s.repo, opacity: dim ? 0.25 : 1, style: { transition: 'opacity .15s' },
                tabIndex: 0, role: 'img', 'aria-label': s.repo + ' · ≈' + signed(s.points.at(-1).gained),
                onMouseEnter: () => setHover(s.repo), onMouseLeave: () => setHover(null),
                onFocus: () => setHover(s.repo), onBlur: () => setHover(null) },
              h('title', null, s.repo + ' · ≈' + signed(s.points.at(-1).gained)),
              h('line', { className: 'hp-endpoint-link', x1: trueX, y1: trueY, x2: cx - r, y2: cy, stroke: s.color, strokeWidth: 1, opacity: 0.6 }),
              h('circle', { className: 'hp-endpoint-dot', cx: trueX, cy: trueY, r: 2.3, fill: s.color }),
              h(
                'defs',
                null,
                h('clipPath', { id: clipId }, h('circle', { cx, cy, r })),
              ),
              // 白色描边：让头像从深色/米色底上都浮出来
              h('circle', { cx, cy, r: r + 1.6, fill: 'var(--hp-card-bg, #fff)', opacity: 0.9 }),
              h('circle', { cx, cy, r, fill: s.color, opacity: 0.18 }),
              h('image', {
                className: 'hp-endpoint-avatar',
                href: BASE + '/avatar?owner=' + encodeURIComponent(owner),
                x: cx - r,
                y: cy - r,
                width: r * 2,
                height: r * 2,
                clipPath: 'url(#' + clipId + ')',
                preserveAspectRatio: 'xMidYMid slice',
              }),
              h('circle', { cx, cy, r, fill: 'none', stroke: s.color, strokeWidth: 1.6 }),
            );
          }),
        ),
        // 图例
        h(
          'div',
          { className: 'hp-legend' },
          seriesList.map((s) =>
            h(
              'button',
              {
                key: s.repo,
                className: 'hp-legend-item' + (hover === s.repo ? ' act' : ''),
                onMouseEnter: () => setHover(s.repo),
                onMouseLeave: () => setHover(null),
                onFocus: () => setHover(s.repo),
                onBlur: () => setHover(null),
                onClick: () => toggle(s.repo),
                title: s.repo + ' · ' + s.baseDate + ' → ' + s.points[s.points.length - 1].date,
              },
              h('span', { className: 'hp-legend-line', style: { background: s.color } }),
              h('span', null, s.repo + ' · ' + s.baseDate + ' · ≈' + signed(s.points[s.points.length - 1].gained)),
            ),
          ),
        ),
      );
    }

    // 上图下选：先给结论（走势图），再给操作（勾选）
    return h(
      'div',
      { className: 'hp-dash' },
      isDaily ? null : h('section', { className: 'hp-mchart-panel' },
        h('div', { className: 'hp-mchart-title' }, translate(lang, 'stats.gainTitle')),
        h('div', { className: 'hp-mchart-hint' }, translate(lang, 'stats.gainHint')),
        h('div', { className: 'hp-gain-list' }, (showAllGains ? rows || [] : (rows || []).slice(0, 5)).map((row) =>
          h('div', { className: 'hp-gain-row', key: row.repository },
            h('span', { className: 'hp-gain-name', title: row.repository }, row.rank + '. ' + row.repository),
            h('div', { className: 'hp-gain-track' }, h('div', { className: 'hp-gain-bar', style: { width: (Math.abs(row.starsGained) / maxGain * 100) + '%' } })),
            h('span', { className: 'hp-gain-value' }, (row.starsGained > 0 ? '+' : '') + row.starsGained.toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN')),
          ),
        )),
        rows && rows.length > 5 ? h('button', { className: 'hp-pick-btn', style: { marginTop: 12 }, onClick: () => setShowAllGains((v) => !v) },
          translate(lang, showAllGains ? 'stats.showLess' : 'stats.showAll', { n: rows.length })) : null,
      ),
      h(
        'section',
        { className: 'hp-mchart-panel' },
        h(
          'div',
          { className: 'hp-mchart-head' },
          h('div', { className: 'hp-mchart-title' }, translate(props.lang, isDaily ? 'stats.dailyTitle' : 'stats.chartTitle')),
          // 不再放「总星数 / 本期涨幅」切换：上面的「日/周/月」已经决定了周期，
          // 这里再让人选一次量纲就是重复决策。统一看「相对起点涨了多少」——
          // 它才是「谁这段涨得猛」的可比量（总星数比的是历史体量，与周期无关）。
          h('div', { className: 'hp-mchart-hint' }, translate(props.lang, isDaily ? 'stats.dailyAxis' : frame && !frame.useLog ? 'stats.linearAxis' : 'stats.axisHint')),
        ),
        !Number.isFinite(windowStart) || !Number.isFinite(windowEnd)
          ? h('div', { className: 'hp-mchart-note' }, translate(lang, 'stats.unknownWindow'))
          : h('div', { className: 'hp-mchart-note' }, props.window.start + ' → ' + props.window.end),
        chartNode,
        h(
          'div',
          { className: 'hp-mchart-note' },
          translate(lang, isDaily ? 'stats.dailyNote' : 'stats.sampleNote'),
        ),
      ),
      ready ? picker : null,
    );
  }

  /* ============================================================ 主面板 */

  function factory(require) {
    const React = require('react');
    const h = React.createElement;

    function Panel() {
      const [view, setView] = React.useState('cards'); // cards | dash
      const [period, setPeriod] = React.useState('day');
      const [boards, setBoards] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [refreshing, setRefreshing] = React.useState(false);
      const [refreshDelayed, setRefreshDelayed] = React.useState(false);
      const [collection, setCollection] = React.useState([]);
      const [collectionQuery, setCollectionQuery] = React.useState('');
      const [collectionPage, setCollectionPage] = React.useState(0);
      const [error, setError] = React.useState(null);
      const [selected, setSelected] = React.useState(null);
      const [detail, setDetail] = React.useState(null);
      const [detailLoading, setDetailLoading] = React.useState(false);
      const [detailError, setDetailError] = React.useState(null);
      const detailRequestRef = React.useRef(0);
      const [theme, setTheme] = React.useState(readTheme);
      const [lang, setLang] = React.useState(readLang);
      /**
       * 设置面板开关，以及「有没有新版本」。
       *
       * 更新检查每天最多一次（后端 /update 自己有 24h 缓存，这里再挡一层
       * localStorage，避免每次开面板都打请求）。
       * 有新版时设置按钮变高亮色，让用户一眼看到。
       */
      const [showSettings, setShowSettings] = React.useState(false);
      const [updateInfo, setUpdateInfo] = React.useState(null);
      const [lastFetch, setLastFetch] = React.useState(null);
      /** { [repository]: { desc, chart } } —— 列表页卡片的简介与迷你走势 */
      const [details, setDetails] = React.useState(readDetailsCache);

      /**
       * 后台补新完成后的静默重拉定时器。
       * 有新的一天首次打开时，宿主先给昨天的缓存并标记 refreshing，
       * 前端过几秒再拉一次，把数据悄悄换成今天的 —— 用户不用手动刷新。
       */
      const refreshTimerRef = React.useRef(null);
      /** 本次打开已经重拉过几次（最多 10 次，避免上游滞后时无限轮询） */
      const refreshTriesRef = React.useRef(0);

      const loadBoards = React.useCallback(async (silent) => {
        setLoading(true);
        setRefreshDelayed(false);
        if (!silent) {
          refreshTriesRef.current = 0;
          if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current);
          refreshTimerRef.current = null;
        }
        setError(null);
        try {
          const body = await getJson('/boards');
          setBoards(body.boards || []);
          setCollection(body.collection || []);
          setRefreshing(body.refreshing === true);
          setRefreshDelayed(body.refreshing === true && refreshTriesRef.current >= 10);
          setLastFetch(body.fetchedAt || null);
          /**
           * 宿主返回 refreshing=true 说明这次给的是历史缓存、后台正在抓新的。
           * 8 秒后静默再拉一次；只在当前没有待执行的重拉时才排队，
           * 避免多条请求叠加或无限循环。
           */
          if (body.refreshing && refreshTimerRef.current === null && refreshTriesRef.current < 10) {
            refreshTriesRef.current += 1;
            refreshTimerRef.current = setTimeout(() => {
              refreshTimerRef.current = null;
              void loadBoards(true);
            }, 8000);
          }
        } catch (e) {
          setRefreshing(false);
          setError(String(e && e.message ? e.message : e));
        } finally {
          setLoading(false);
        }
      }, []);

      // 卸载时清掉待执行的重拉，避免组件没了还在跑
      React.useEffect(() => () => {
        if (refreshTimerRef.current !== null) {
          clearTimeout(refreshTimerRef.current);
          refreshTimerRef.current = null;
        }
      }, []);

      /**
       * 给当前可见的卡片批量补详情（简介 + 曲线），只取**还没有**的那些。
       * 宿主侧串行取、单条失败不影响其它；这里失败就静默跳过，卡片自动退回「无简介」形态。
       */
      /**
       * 详情加载：**缓存优先，后台更新**（stale-while-revalidate）。
       *
       * 加载行为分两步：
       *   ① 先从本地缓存把已有的（英文 + 中文）直接摆上屏 —— 不闪骨架、不等网络；
       *   ② 然后**不管有没有缓存**都去后台问一次，拿回新描述就更新。
       *
       * 注意：不能「有缓存就直接返回」，否则缓存永远不刷新，
       * 源站更新了描述也看不到。有缓存时同样需要发起更新请求。
       *
       * 并发控制：同一批 repo 在同一时刻只发一次请求（避免 effect 抖动打爆）。
       */
      /**
       * 分批加载详情 —— **先给前几屏，再补后面的**。
       *
       * 之前是一次性请求 20 个项目的简介+曲线+头像，再等翻译，
       * 结果首屏要等很久才出现内容。现在拆成 6 个一批：
       *   · 第 1 批（1~6）回来就立刻渲染，用户马上看到东西；
       *   · 后台接着请求 7~12、13~18、19~20，每批回来就补上。
       *
       * 关键：`known` 只用来判断「已经有的不用重复翻」，**不影响要不要发请求** ——
       * 有缓存也照样刷新（stale-while-revalidate）。
       */
      /**
       * 统一补中文译文：只翻还没有译文的那几条。
       * 单独抽出来，是因为它要在「所有数据批次取完」之后才跑，
       * 而且失败不该影响已显示的内容。
       */
      const loadTranslations = React.useCallback(async (needZh, gen) => {
        if (!needZh || needZh.length === 0) return;
        try {
          const tr = await getJson('/translate?repos=' + needZh.map(encodeURIComponent).join(',') + '&limit=20');
          if (generationRef.current !== gen) return;
          const zhMap = {};
          for (const it of tr.items || []) {
            if (it.descZh) zhMap[it.repository] = it.descZh;
          }
          if (Object.keys(zhMap).length > 0) {
            setDetails((prev) => {
              const merged = { ...prev };
              for (const [repo, descZh] of Object.entries(zhMap)) {
                if (merged[repo]) merged[repo] = { ...merged[repo], descZh };
              }
              return merged;
            });
          }
        } catch (e) {
          /* 翻译失败：留在英文原文 */
        }
      }, []);

      const inflightRef = React.useRef(new Set());
      const generationRef = React.useRef(0);
      const CHUNK = 6; // 每批条数：一屏 3 行卡片，够快看到结果

      const loadDetails = React.useCallback(async (repos, known, wantLang, attempt = 0) => {
        if (!repos || repos.length === 0) return;
        const list = repos.slice(0, 20);
        const gen = generationRef.current;
        const pendingCharts = [];

        // 把 20 个切成若干 6 个一批
        const chunks = [];
        for (let i = 0; i < list.length; i += CHUNK) chunks.push(list.slice(i, i + CHUNK));

        for (let ci = 0; ci < chunks.length; ci += 1) {
          // 每批开始前检查代际：用户中途换了榜单/语言，剩下的批次直接放弃
          if (generationRef.current !== gen) return;
          const chunk = chunks[ci];
          const batchKey = gen + '|' + wantLang + '|' + chunk.join(',');
          if (inflightRef.current.has(batchKey)) continue;
          inflightRef.current.add(batchKey);
          try {
            const q = chunk.map(encodeURIComponent).join(',');
            const noZh = wantLang === 'en' ? '&translate=0' : '';
            const body = await getJson('/batch?repos=' + q + '&limit=' + chunk.length + noZh);
            if (generationRef.current !== gen) return;

            // 这一批回来就立刻合并 → 界面马上多出 6 张有内容的卡
            const next = {};
            for (const it of body.items || []) {
              if (it.chartPending) pendingCharts.push(it.repository);
              next[it.repository] = {
                desc: it.desc,
                descZh: it.descZh,
                chart: it.chart,
                descSource: it.descSource,
                avatar: it.avatar || null,
                settled: true,
              };
            }
            setDetails((prev) => {
              const merged = { ...prev };
              for (const [repo, fresh] of Object.entries(next)) {
                const old = prev[repo];
                const keepOld = !fresh.desc && old && old.desc;
                merged[repo] = keepOld
                  ? { ...old, chart: fresh.chart || old.chart, avatar: fresh.avatar || old.avatar, settled: true }
                  : { ...fresh, descZh: fresh.descZh || (old && old.desc === fresh.desc && old.descZh) || null };
              }
              return merged;
            });
            if (wantLang === 'zh') {
              const needZh = chunk.filter((r) => {
                const entry = next[r] || known[r];
                return entry && entry.desc && !entry.descZh;
              });
              if (needZh.length > 0) void loadTranslations(needZh, gen);
            }
          } catch (e) {
            if (generationRef.current !== gen) return;
            // 这一批失败：把还没取过的标成 settled，避免永远转圈
            const fallback = {};
            for (const r of chunk) {
              if (!known[r]) fallback[r] = { desc: null, descZh: null, chart: null, settled: true };
            }
            if (Object.keys(fallback).length > 0) {
              setDetails((prev) => ({ ...fallback, ...prev }));
            }
          } finally {
            inflightRef.current.delete(batchKey);
          }
        }
        if (pendingCharts.length > 0 && attempt < 3 && generationRef.current === gen) {
          setTimeout(() => {
            if (generationRef.current === gen) void loadDetails(pendingCharts, known, wantLang, attempt + 1);
          }, 2500);
        }
      }, [loadTranslations]);

      React.useEffect(() => () => {
        generationRef.current += 1;
        detailRequestRef.current += 1;
      }, []);

      React.useEffect(() => {
        void loadBoards(false);
        // 数据源每天只更新一次，所以不做分钟级轮询；只在**跨天**时自动静默刷新一次。
        // 判断方式：记住首次加载那天的日期，页面开着跨过零点才重新取。
        let openedDay = localDayKey();
        const timer = setInterval(() => {
          if (localDayKey() !== openedDay) {
            openedDay = localDayKey();
            void loadBoards(true);
          }
        }, 60 * 1000);
        return () => clearInterval(timer);
      }, [loadBoards]);

      const board = React.useMemo(() => {
        if (!boards) return null;
        return boards.find((b) => b.id === period) || boards[0] || null;
      }, [boards, period]);

      const openDetail = React.useCallback(async (item) => {
        const request = ++detailRequestRef.current;
        setSelected(item);
        setDetail(null);
        setDetailError(null);
        setDetailLoading(true);
        try {
          const body = await getJson('/detail?repo=' + encodeURIComponent(item.repository) + (lang === 'en' ? '&translate=0' : ''));
          if (request !== detailRequestRef.current) return;
          setDetail(body.detail || null);
        } catch (e) {
          if (request !== detailRequestRef.current) return;
          setDetailError(String(e && e.message ? e.message : e));
        } finally {
          if (request === detailRequestRef.current) setDetailLoading(false);
        }
      }, [lang]);

      const collectionMatches = React.useMemo(() => collection.filter((item) =>
        item.repository.toLowerCase().includes(collectionQuery.trim().toLowerCase())), [collection, collectionQuery]);
      const collectionPages = Math.max(1, Math.ceil(collectionMatches.length / MAX_ITEMS));
      const currentCollectionPage = Math.min(collectionPage, collectionPages - 1);
      const collectionVisible = collectionMatches.slice(currentCollectionPage * MAX_ITEMS, (currentCollectionPage + 1) * MAX_ITEMS);
      const rows = board && Array.isArray(board.rows) ? board.rows : [];
      const maxGain = React.useMemo(() => rows.reduce((m, r) => Math.max(m, r.starsGained || 0), 0), [rows]);
      /** 只看前 20 —— 再多就是噪音，所以这里硬截断。 */
      const visible = React.useMemo(() => rows.slice(0, MAX_ITEMS), [rows]);
      const dailyBoard = boards && boards.find((b) => b.id === 'day');
      const newProjects = dailyBoard && Array.isArray(dailyBoard.rows)
        ? dailyBoard.rows.slice(0, MAX_ITEMS).filter((item) => item.isNewToday === true) : [];
      /** { repo: chart } —— 只挑出真正有曲线的那些，图表组件不认识 desc 之类 */
      const chartMap = React.useMemo(() => {
        const out = {};
        for (const [repo, entry] of Object.entries(details || {})) {
          if (entry && entry.chart && Array.isArray(entry.chart.series)) out[repo] = entry.chart;
        }
        return out;
      }, [details]);

      /**
       * 可见项目变了（换榜单/换周期）或语言变了 → 去取一次详情。
       *
       * ⚠️ 这里**只依赖项目列表与语言**，不依赖 details —— 否则
       * 「取回 → setDetails → 触发 effect → 又取回」会转圈。
       * 是否有缓存由 loadDetails 内部判断（有缓存也照样更新，见它的注释）。
       */
      const repoListKey = (view === 'collection' ? collectionVisible : visible).map((r) => r.repository).join('|');

      // details 的最新值放 ref 里：effect 要读它判断「哪些还没有」，
      // 但不能把它写进依赖（否则取回→setDetails→再取回 会转圈）。
      const detailsRef = React.useRef(details);
      React.useEffect(() => { detailsRef.current = details; }, [details]);

      React.useEffect(() => {
        if (!repoListKey) return;
        // 每次换榜单/语言：代际 +1，让在途的旧请求作废
        generationRef.current += 1;
        void loadDetails(repoListKey.split('|'), detailsRef.current, lang);
      }, [repoListKey, lang, loadDetails]);

      /**
       * 榜单出来后就通知宿主**按排名顺序预翻译**。
       *
       * 用户此刻看到的是英文；等他点开第 1 名时，第 2、3、4 名正在依次翻译。
       * 只在中文模式下触发（英文模式不需要译文，省模型额度）。
       */
      React.useEffect(() => {
        if (lang !== 'zh') return;
        if (!repoListKey) return;
        const key = 'dsh-github-hot:prewarm:' + localDayKey() + ':' + repoListKey.slice(0, 80);
        try {
          if (localStorage.getItem(key) === '1') return; // 今天这批已经预热过
          localStorage.setItem(key, '1');
        } catch (e) { /* 忽略 */ }
        const q = encodeURIComponent(repoListKey.split('|').join(','));
        void getJson('/prewarm?repos=' + q + '&limit=20').catch(() => {});
      }, [repoListKey, lang]);

      const explanationCandidates = (view === 'collection' ? collectionVisible : visible).slice()
        .sort((a, b) => (b.endStars || 0) - (a.endStars || 0)).slice(0, 3);
      const explanationWarmKey = explanationCandidates.map((item) => item.repository + ':' + (details[item.repository]?.desc || '')).join('|');
      React.useEffect(() => {
        if (!explanationCandidates.length || !explanationCandidates.some((item) => details[item.repository]?.desc)) return;
        const repos = explanationCandidates.map((item) => item.repository).join(',');
        void getJson('/explain-prewarm?lang=' + lang + '&repos=' + encodeURIComponent(repos)).catch(() => {});
      }, [explanationWarmKey, lang]);

      // 详情变化就落本地缓存（节流交给浏览器，量很小）
      React.useEffect(() => {
        if (Object.keys(details).length > 0) writeDetailsCache(details);
      }, [details]);

      /** 切换语言：换偏好、清掉已缓存的详情（否则拿的还是旧语言那批），再重取一次。 */
      /**
       * 切换语言。
       *
       * ⚠️ 这里**不能清空 details**：清空会让所有卡片回到骨架并重新请求，
       * 表现为切换瞬间内容全消失。
       *
       * 正确做法：保留已有内容（英文/中文都在 details 里），只改变「显示哪一份」，
       * 需要译文时由 effect 触发补译。内容不清空 → 不闪。
       */
      const toggleLang = React.useCallback(() => {
        setLang((cur) => {
          const next = cur === 'zh' ? 'en' : 'zh';
          writeLang(next);
          return next;
        });
      }, []);

      /**
       * 版本检查：打开面板时查一次，结果按天缓存。
       *
       * 只在「今天还没查过」时发请求；查失败不影响任何功能。
       */
      React.useEffect(() => {
        let alive = true;
        const UPDATE_KEY = 'dsh-github-hot:update';
        const today = localDayKey();
        try {
          const raw = localStorage.getItem(UPDATE_KEY);
          if (raw) {
            const saved = JSON.parse(raw);
            /**
             * 缓存只用来**先把上一次的结果画出来**，不能当作当天的最终答案。
             *
             * 之前命中当天缓存就直接 return，不再向宿主确认 —— 结果升级到新版后，
             * 面板仍拿着旧记录说「有新版本」，设置按钮一直亮红灯，直到第二天。
             * 现在照常发一次请求（宿主侧有 24h 缓存，几乎不花代价），拿到就覆盖。
             */
            if (saved && saved.latest) setUpdateInfo(saved);
          }
        } catch (e) { /* 忽略 */ }

        getJson('/update')
          .then((r) => {
            if (!alive || !r || !r.latest) return;
            const next = { day: today, current: r.current, latest: r.latest, hasUpdate: r.hasUpdate };
            setUpdateInfo(next);
            try { localStorage.setItem(UPDATE_KEY, JSON.stringify(next)); } catch (e) { /* 忽略 */ }
          })
          .catch(() => { /* 检查失败静默 */ });

        return () => { alive = false; };
      }, []);

      /** 手动再查一次（点「立即检查」）。 */
      const recheckUpdate = React.useCallback(() => {
        setUpdateInfo((cur) => ({ ...(cur || {}), checking: true }));
        getJson('/update?force=1')
          .then((r) => {
            const next = { day: localDayKey(), current: r.current, latest: r.latest, hasUpdate: r.hasUpdate, error: r.error || null };
            setUpdateInfo(next);
            try { localStorage.setItem('dsh-github-hot:update', JSON.stringify(next)); } catch (e) { /* 忽略 */ }
          })
          .catch((e) => setUpdateInfo((cur) => ({ ...(cur || {}), checking: false, error: String(e && e.message ? e.message : e) })));
      }, []);

      /**
       * 切到「中文」时，立刻给已有内容补译文 —— **不等重新取数**。
       *
       * 为什么单独做：切语言时数据已经在了（英文简介在 details 里），
       * 如果等 loadDetails 重新跑一遍批次才去翻译，会绕一大圈还可能被代际作废。
       * 这里直接看「哪些有英文没中文」，发一次翻译请求就够了。
       */
      React.useEffect(() => {
        if (lang !== 'zh') return;
        const gen = generationRef.current;
        const need = [];
        for (const [repo, entry] of Object.entries(detailsRef.current || {})) {
          if (entry && entry.desc && !entry.descZh) need.push(repo);
        }
        if (need.length > 0) void loadTranslations(need.slice(0, 20), gen);
      }, [lang, loadTranslations]);

      const toggleTheme = React.useCallback(() => {
        setTheme((cur) => {
          const next = cur === 'paper' ? 'dark' : 'paper';
          writeTheme(next);
          return next;
        });
      }, []);

      // 界面文案统一走 t()，切换语言时整个界面跟着变
      const t = (key, vars) => translate(lang, key, vars);
      const periodLabel = board ? board.label : '—';
      const dataOk = board && board.ok;
      const dataStale = board && !board.ok && board.staleAt;

      const header = h(
        'div',
        { className: 'hp-head' },
        h('div', { className: 'hp-brand' },
          h('span', { className: 'hp-brand-icon', dangerouslySetInnerHTML: { __html: BRAND_ICON_SVG } }),
          'GitHub Hot',
          ),
        h('div', { className: 'hp-spacer' }),
        // 右侧操作区：周期切换 → 视图切换 → 主题 → 刷新
        h(
          'div',
          { className: 'hp-actions' },
          h(
            'div',
            { className: 'hp-seg' },
            h('button', { className: period === 'day' ? 'on' : '', onClick: () => setPeriod('day') }, t('period.day')),
            h('button', { className: period === 'week' ? 'on' : '', onClick: () => setPeriod('week') }, t('period.week')),
            h('button', { className: period === 'month' ? 'on' : '', onClick: () => setPeriod('month') }, t('period.month')),
          ),
          h(
            'div',
            { className: 'hp-seg' },
            h('button', { className: view === 'cards' ? 'on' : '', onClick: () => setView('cards'), title: t('misc.topByRank') }, t('view.board')),
            h('button', { className: view === 'dash' ? 'on' : '', onClick: () => setView('dash') }, t('view.stats')),
            h('button', { className: view === 'collection' ? 'on' : '', onClick: () => setView('collection') }, t('view.collection')),
          ),
        ),
        // 一句话说清「数据是哪天的」。不再罗列取回时刻与起止日期 —— 那对读的人没有意义。
        h(
          'div',
          { className: 'hp-meta' },
          h(
            'span',
            { title: lastFetch ? '本机取回于 ' + fmtTime(lastFetch) : '' },
            h('span', { className: 'hp-dot ' + (dataOk ? 'ok' : dataStale ? 'warn' : 'bad') }),
            dataOk
              ? t('status.updatedTo', { date: dataDateText(board, lang) })
              : dataStale
                ? t('error.stale', { err: '', when: ago(board.staleAt) }).replace('（）', '').replace('()', '')
                : t('empty.notFetched'),
          ),
        ),
        h(
          'div',
          { className: 'hp-actions' },
          h(
            'button',
            {
              className: 'hp-btn hp-lang-btn',
              onClick: toggleLang,
              title: lang === 'zh' ? t('lang.tipZh') : t('lang.tipEn'),
            },
            lang === 'zh' ? t('lang.zh') : t('lang.en'),
          ),
          h(
            'button',
            { className: 'hp-btn hp-theme-btn', onClick: toggleTheme, title: theme === 'paper' ? t('theme.tipDark') : t('theme.tipPaper') },
            theme === 'paper' ? '◐ ' + t('theme.dark') : '◑ ' + t('theme.paper'),
          ),
          h(
            'button',
            {
              // 有新版本时按钮变高亮（hp-btn-update），提示用户点进来
              className: 'hp-btn hp-settings-btn' + (updateInfo && updateInfo.hasUpdate ? ' hp-btn-update' : ''),
              onClick: () => setShowSettings((v) => !v),
              title: updateInfo && updateInfo.hasUpdate
                ? t('settings.updateTip', { v: updateInfo.latest })
                : t('settings.tip'),
            },
            h('span', { className: 'hp-gear', dangerouslySetInnerHTML: { __html: GEAR_ICON_SVG } }),
            t('settings.title'),
            updateInfo && updateInfo.hasUpdate ? h('span', { className: 'hp-update-dot' }) : null,
          ),
          h('button', { className: 'hp-btn', onClick: () => void loadBoards(false), disabled: loading || (refreshing && !refreshDelayed) }, loading || (refreshing && !refreshDelayed) ? t('action.refreshing') : t('action.refresh')),
        ),
      );

      let body;
      if (loading && !boards) {
        body = h(
          'div',
          { className: 'hp-cards' },
          Array.from({ length: 6 }, (_, i) => h('div', { className: 'hp-card-loading', key: i })),
        );
      } else if (error && !boards) {
        body = h(
          'div',
          { className: 'hp-empty' },
          h('strong', null, t('error.title')),
          h('div', null, error),
          h('div', null, t('error.hint')),
        );
      } else if (view === 'collection') {
        body = h('section', { className: 'hp-collection' },
          h('div', { className: 'hp-collection-heading' },
            h('h2', null, t('view.collection')),
            h('span', { className: 'hp-collection-count' }, t('collection.count', { n: collection.length }))),
          h('p', { className: 'hp-collection-intro' }, t('collection.hint')),
          h('div', { className: 'hp-collection-toolbar' },
            h('span', { className: 'hp-collection-results', role: 'status' }, t('collection.results', { n: collectionMatches.length })),
            h('input', { className: 'hp-collection-search', type: 'search', value: collectionQuery,
              placeholder: t('collection.search'), 'aria-label': t('collection.search'),
              onChange: (event) => { setCollectionQuery(event.target.value); setCollectionPage(0); } })),
          collectionVisible.length === 0 ? h('p', { className: 'hp-collection-intro' }, t('collection.empty')) : null,
          h('div', { className: 'hp-cards hp-collection-grid' }, collectionVisible.map((item) =>
            h(Card, { key: item.repository, React, lang, item, archived: true,
              detail: details[item.repository] || null,
              isSel: selected && selected.repository === item.repository,
              onSelect: (it) => void openDetail(it) }))),
          h('nav', { className: 'hp-collection-pagination', 'aria-label': t('view.collection') },
            h('button', { className: 'hp-btn', disabled: currentCollectionPage === 0, onClick: () => setCollectionPage(currentCollectionPage - 1) }, t('collection.prev')),
            h('span', null, t('collection.page', { page: currentCollectionPage + 1, pages: collectionPages })),
            h('button', { className: 'hp-btn', disabled: currentCollectionPage + 1 >= collectionPages, onClick: () => setCollectionPage(currentCollectionPage + 1) }, t('collection.next'))));
      } else if (!dataOk && rows.length === 0) {
        body = h(
          'div',
          { className: 'hp-empty' },
          h('strong', null, periodLabel + ' 暂时拿不到'),
          h('div', null, board && board.error ? String(board.error) : '未知原因'),
          h('div', null, '数据每天更新一次，稍后重试即可。'),
        );
      } else if (view === 'dash') {
        // 统计只看展示的那一批，与榜单页口径一致。
        // details 是 { repo: { desc, chart } }，这里抽成 { repo: chart } 再传 —— 图表组件只认曲线。
        body = h(Dashboard, { React, rows: visible, charts: chartMap, lang, periodKey: period, window: board && board.window });
      } else {
        body = h(
          'div',
          null,
          // ── 最新日榜新增提醒，与延续三天的 NEW 徽章分开计算 ──
          h(
            'div',
            { className: 'hp-hero' },
            h(
              'div',
              { className: 'hp-hero-main' },
              h('div', { className: 'hp-hero-k' }, t('board.newTitle')),
              h('div', { className: 'hp-new-project-title' }, t(!dailyBoard || !dailyBoard.ok ? 'board.newUnknown' : newProjects.length ? 'board.newToday' : 'board.newEmpty', { n: newProjects.length })),
              dailyBoard && dailyBoard.ok && newProjects.length > 0 ? h('div', { className: 'hp-new-project-list' },
                h('span', { className: 'hp-new-project-label' }, t('board.newNames')),
                newProjects.map((item) => h('button', { key: item.repository, className: 'hp-new-project', onClick: () => void openDetail(item) },
                  h(Avatar, { React, repository: item.repository, size: 22, src: details[item.repository] && details[item.repository].avatar }),
                  item.repository))) : null,
              dailyBoard ? h('div', { className: 'hp-hero-sub' }, t('board.newDate', { date: dataDateText(dailyBoard, lang) })) : null,
            ),
            h(
              'div',
              { className: 'hp-collection-preview' },
              h('div', { className: 'hp-collection-heading' },
                h('div', { className: 'hp-hero-k' }, t('view.collection')),
                h('span', { className: 'hp-collection-count' }, collection.length),
                h('button', { className: 'hp-collection-open', onClick: () => setView('collection') }, t('collection.open'))),
              h('p', { className: 'hp-collection-tagline' }, t('collection.tagline'), h('span', null, t('collection.gainLabel'))),
              h('div', { className: 'hp-collection-peeks' }, collection.slice(0, 3).map((item) =>
                h('button', { key: item.repository, className: 'hp-collection-peek', onClick: () => void openDetail(item),
                  title: t('collection.snapshot', { n: (item.starsGained >= 0 ? '+' : '') + fmtCount(item.starsGained) }) },
                  h(Avatar, { React, repository: item.repository, size: 25, src: details[item.repository] && details[item.repository].avatar }),
                  h('span', { className: 'hp-collection-peek-name' }, item.repository),
                  h('span', { className: 'hp-collection-peek-gain' }, (item.starsGained >= 0 ? '+' : '') + fmtCount(item.starsGained))))),
            ),
          ),
          h(
            'div',
            { className: 'hp-cards' },
            visible.map((item) =>
              h(Card, {
                key: item.repository + ':' + item.rank,
                React,
                lang,
                detail: details[item.repository] || null,
                item,
                maxGain,
                isSel: selected && selected.repository === item.repository,
                onSelect: (it) => void openDetail(it),
              }),
            ),
          ),
        );
      }

      return h(
        'div',
        { className: 'hp-root hp-' + theme },
        header,
        loading || refreshing || (boards && boards.some((b) => !b.ok)) ? h('div', { className: 'hp-banner hp-fetch-status', role: 'status', 'aria-live': 'polite' },
          loading || (refreshing && !refreshDelayed) ? h('span', { className: 'hp-fetch-spinner', 'aria-hidden': true }) : null,
          loading ? t('status.fetching') : refreshDelayed ? t('status.delayed') : refreshing ? t('status.background') : t('status.partial')) : null,
        error && boards ? h('div', { className: 'hp-banner err', role: 'alert' }, error) : null,
        dataStale ? h('div', { className: 'hp-banner warn' }, t('error.stale', { err: board.error, when: ago(board.staleAt) })) : null,
        selected ? h(Detail, { React, lang, item: selected, detail, loading: detailLoading, error: detailError, onClose: () => { detailRequestRef.current += 1; setSelected(null); } }) : null,
        /**
         * 设置面板：点顶栏齿轮弹出，浮在内容之上。
         * 目前只放版本信息与更新提示，后续功能（显示偏好、缓存管理）加在这里。
         */
        showSettings
          ? h(
              'div',
              { className: 'hp-settings-mask', onClick: (e) => { if (e.target === e.currentTarget) setShowSettings(false); } },
              h(
                'div',
                { className: 'hp-settings' },
                // 头部：标题 + 关闭
                h('div', { className: 'hp-set-head' },
                  h('span', { className: 'hp-set-title' }, t('settings.title')),
                  h('button', { className: 'hp-set-x', onClick: () => setShowSettings(false), title: t('settings.close'), 'aria-label': t('settings.close') },
                    h('span', { dangerouslySetInnerHTML: { __html: CLOSE_ICON_SVG } })),
                ),
                // 版本卡片：当前版本是大字号主信息，与 npm 版本并排对比
                h('div', { className: 'hp-set-ver' },
                  h('div', { className: 'hp-set-ver-item' },
                    h('div', { className: 'hp-set-ver-k' }, t('settings.current')),
                    h('div', { className: 'hp-set-ver-v' }, updateInfo && updateInfo.current ? updateInfo.current : '—'),
                  ),
                  h('div', { className: 'hp-set-ver-arrow' }, '→'),
                  h('div', { className: 'hp-set-ver-item' },
                    h('div', { className: 'hp-set-ver-k' }, t('settings.latest')),
                    h('div', {
                      className: 'hp-set-ver-v' + (updateInfo && updateInfo.hasUpdate ? ' new' : ''),
                    }, updateInfo && updateInfo.checking ? '…' : (updateInfo && updateInfo.latest ? updateInfo.latest : '—')),
                  ),
                ),
                // 状态条：一眼看出「要不要升级」
                (() => {
                  if (!updateInfo || !updateInfo.latest) {
                    return updateInfo && updateInfo.error
                      ? h('div', { className: 'hp-set-note warn' }, t('settings.checkFailed', { msg: updateInfo.error }))
                      : h('div', { className: 'hp-set-note' }, t('settings.checking'));
                  }
                  if (updateInfo.hasUpdate) {
                    return h('div', { className: 'hp-set-note update' },
                      h('span', { className: 'hp-update-dot' }),
                      h('span', null, t('settings.updateTip', { v: updateInfo.latest })));
                  }
                  const cmp = cmpVersion(updateInfo.current, updateInfo.latest);
                  if (cmp > 0) {
                    return h('div', { className: 'hp-set-note local' },
                      h('span', { className: 'hp-set-dot ok' }),
                      h('span', null, t('settings.localAhead', { v: updateInfo.latest })));
                  }
                  return h('div', { className: 'hp-set-note ok' },
                    h('span', { className: 'hp-set-dot ok' }),
                    h('span', null, t('settings.upToDate')));
                })(),
                // 升级命令（仅在有新版时出现）
                updateInfo && updateInfo.hasUpdate
                  ? h('div', { className: 'hp-set-cmd' },
                      h('div', { className: 'hp-set-cmd-k' }, t('settings.updateHint')),
                      h('code', null, 'dsh plugin --profile desktop add dsh-github-hot@' + updateInfo.latest))
                  : null,
                // 底部操作
                h('div', { className: 'hp-set-foot' },
                  h('button', {
                    className: 'hp-set-btn',
                    onClick: () => void recheckUpdate(),
                    disabled: updateInfo && updateInfo.checking,
                  }, updateInfo && updateInfo.checking ? t('settings.checking') : t('settings.checkNow')),
                  h('a', {
                    className: 'hp-set-btn ghost',
                    href: 'https://github.com/chiinsight/dsh-github-hot',
                    target: '_blank', rel: 'noreferrer',
                  }, t('settings.repo') + ' ↗'),
                ),
              ),
            )
          : null,
        h('div', { className: 'hp-scroll' }, body),
        /**
         * 数据署名 —— **不是装饰，是法律要求**。
         *
         * 榜单数据来自 Hysen Labs，按 CC BY 4.0 授权：可以免费用，但必须
         *   · credit（署名）：写出 Hysen Labs
         *   · link（链接）：链到来源页
         * 去掉这行就是侵权。放在底部小字，不影响主视觉。
         */
        h(
          'footer',
          { className: 'hp-attr', title: '榜单数据来自 Hysen Labs，按 CC BY 4.0 许可使用' },
          h('a', { href: 'https://hysenlabs.com', target: '_blank', rel: 'noreferrer' }, 'Hysen Labs'),
          h('span', { className: 'hp-attr-dot' }, '·'),
          'CC BY 4.0',
        ),
        selected
          ? h('div', { className: 'hp-scroll', style: { flex: '0 0 auto', maxHeight: 0 } })
          : null,
      );
    }

    return {
      name: PLUGIN_NAME,
      inject: ['slots'],
      apply(ctx) {
        try {
          ensureCss(document);
        } catch (e) {
          console.warn('[dsh-github-hot] 样式注入失败：' + (e instanceof Error ? e.message : String(e)));
        }
        ctx.slots.inject('main', function* () {
          yield ctx.slots.register({ name: 'main', key: PLUGIN_NAME, order: 45 }, Panel);
        });
        ctx.slots.inject('sidebar.panellist', function* () {
          yield ctx.slots.register(
            { name: 'sidebar.panellist', id: PLUGIN_NAME, order: 45, label: () => 'GitHub Hot' },
            function SidebarIcon() {
              // 用内联 SVG 线条图标，而不是 emoji —— 侧栏里其它插件都是线条图标，
              // 一个彩色 emoji 摆进去会显眼得突兀。
              // 三条并行上升线：与「GitHub 热榜 / GitHub 趋势」的单折线同风格，但图形不同。
              return h('span', {
                className: 'hp-side-icon',
                title: 'GitHub Hot · 多项目涨星走势对比',
                dangerouslySetInnerHTML: { __html: SIDEBAR_ICON_SVG },
              });
            },
          );
        });
      },
    };
  }

  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({ id: PLUGIN_NAME, factory });
  }

  // 仅供测试：把这些纯渲染组件挂在全局名下一个不冲突的键上，
  // 测试脚本可以直接对**真实组件**做同构渲染断言，而不是复制一份等价逻辑去测。
  if (typeof globalThis !== 'undefined') {
    globalThis.__DSH_HYSEN_PULSE_TEST__ = { StarChart, Card, Detail, Dashboard, fmtCount, fmtPct, gainTone };
  }
})();
