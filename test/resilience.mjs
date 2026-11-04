/**
 * 抗故障测试：模拟数据源各种「不讲理」的情况，确认插件不崩溃、不产出错误数据。
 *
 * 这类测试特别重要 —— 上线后你控制不了对方站点会返回什么。
 */
import { __internals } from '../lib/index.js';

const { parseCsv, parseWeeklyHtml, parseChartSvg, parseConclusion, parseWhatIsIt, parseAvatarUrl } = __internals;
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? ' | ' + extra : '')); } };

function noThrow(fn, label) {
  try {
    const r = fn();
    ok(true, label + '（返回 ' + (r === null ? 'null' : typeof r) + '）');
    return r;
  } catch (e) {
    ok(false, label + ' 抛异常', e.message);
    return undefined;
  }
}

console.log('[1] 空输入 / 残缺输入');
noThrow(() => parseCsv(''), 'CSV 空串');
noThrow(() => parseWeeklyHtml(''), '周榜空串');
noThrow(() => parseChartSvg(''), 'SVG 空串');
noThrow(() => parseConclusion(''), '简介空串');
noThrow(() => parseAvatarUrl(''), '头像空串');
noThrow(() => parseCsv('a,b\n'), 'CSV 只有表头');
noThrow(() => parseWeeklyHtml('<html></html>'), '周榜是空 HTML');

console.log('\n[2] 恶意/异常 HTML');
const attacks = [
  ['超长属性', '<div class="' + 'x'.repeat(100000) + '">y</div>'],
  ['嵌套注释', '<!--<!--' + '-->'.repeat(1000)],
  ['未闭合标签', '<div><span><a href="x">text'],
  ['脚本注入', '<script>alert(1)</script><p>hi</p>'],
  ['超多行', '<li data-testid="ranking-row-1">x</li>'.repeat(5000)],
];
for (const [name, html] of attacks) {
  noThrow(() => parseWeeklyHtml(html), '周榜解析：' + name);
  noThrow(() => parseConclusion(html), '简介解析：' + name);
}

console.log('\n[3] SVG 畸形数据');
const badSvgs = [
  ['无 path', '<svg><title>x</title></svg>'],
  ['path 无坐标', '<svg><path d="M"/></svg>'],
  ['坐标是 NaN', '<svg><path d="M1 NaN L2 NaN"/></svg>'],
  ['只有 M', '<svg><path d="M10 10"/></svg>'],
  ['负坐标', '<svg><path d="M-5 -5 L-10 -10 L-20 -3"/></svg>'],
  ['没有刻度', '<svg><path d="M1 1 L2 2 L3 3 L4 4"/></svg>'],
];
for (const [name, svg] of badSvgs) {
  const r = noThrow(() => parseChartSvg(svg), '曲线解析：' + name);
  // 解析不出来应该返回 null，而不是产出错误数据
  if (r !== undefined && r !== null) {
    const hasNaN = r.series && r.series.some((p) => !Number.isFinite(p.stars));
    ok(!hasNaN, '  没有产出 NaN 数据');
  }
}

console.log('\n[4] CSV 注入（公式注入 / 超长字段）');
const injected = parseCsv('a,b\n=cmd|calc,2\n' + 'x'.repeat(50000) + ',3');
ok(injected.length >= 2, 'CSV 注入内容能解析但不执行');
ok(typeof injected[1][0] === 'string', '公式被当作普通字符串');

console.log('\n[5] 极端数值');
const bigNum = parseCsv('a,b\n999999999999999999999,1');
ok(bigNum.length === 2, '超大数字不崩溃');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
