import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const lines = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8').split('\n');
// COPY 从 102 行(1-based) 到 translate 之前
const block = lines.slice(101, 262).join('\n');
const factory = new Function(block + '\nreturn { COPY, translate };');
const { COPY, translate } = factory();

let pass = 0, fail = 0;
const ok = (c, msg, x) => { if (c) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg + (x ? ' | ' + x : '')); } };

console.log('[1] 字典完整性');
const zhKeys = Object.keys(COPY.zh), enKeys = Object.keys(COPY.en);
ok(zhKeys.length === enKeys.length, `键数一致 zh=${zhKeys.length} en=${enKeys.length}`);
const missing = zhKeys.filter(k => !enKeys.includes(k));
ok(missing.length === 0, '英文无缺键', missing.join(','));

console.log('\n[2] 关键文案');
for (const [k, z, e] of [['period.day','日榜','Daily'],['period.week','周榜','Weekly'],['view.board','榜单','Ranking'],['action.refresh','刷新','Refresh'],['detail.introTitle','项目简介','About'],['detail.chartTitle','星数曲线','Star history']]) {
  ok(translate('zh',k) === z, `${k} → ${z}`, translate('zh',k));
  ok(translate('en',k) === e, `${k} → ${e}`, translate('en',k));
}

console.log('\n[3] 占位符');
ok(translate('zh','status.updatedTo',{date:'11月3日'}) === '数据更新到 11月3日', '中文', translate('zh','status.updatedTo',{date:'11月3日'}));
ok(translate('en','status.updatedTo',{date:'Nov 3'}) === 'Updated Nov 3', '英文', translate('en','status.updatedTo',{date:'Nov 3'}));

console.log('\n[4] 默认语言应为中文');
const src = lines.join('\n');
ok(/return localStorage\.getItem\(LANG_KEY\) === 'en' \? 'en' : 'zh'/.test(src), '只有显式存 en 才用英文，否则默认中文');
ok(/catch \(e\) \{ return 'zh'; \}/.test(src), 'localStorage 不可用时也默认中文');

console.log('\n[5] 界面不再有硬编码的中文按钮文案');
for (const bad of ["'日榜'", "'周榜'", "'月榜'", "'榜单'", "'统计'", "'刷新'", "'深色'", "'纸感'", "'项目简介'", "'星数曲线'"]) {
  const inCopyTable = src.includes("'period.day': " + bad) || src.includes("'view.board': " + bad);
  ok(!new RegExp("h\\([^)]*" + bad.replace(/'/g, "\\'")).test(src), '无硬编码 ' + bad);
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
