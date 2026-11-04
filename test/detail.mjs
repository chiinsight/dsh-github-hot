/** 验证项目分析页的简介解析。 */
import { __internals } from '../lib/index.js';
const { parseConclusion, parseWhatIsIt } = __internals;
const UA = { 'User-Agent': 'dsh-hysen-pulse/test' };

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? ' | ' + extra : '')); } };

for (const slug of ['morluto-rea', 'nutlope-hallmark', 'pbakaus-impeccable']) {
  console.log('\n[' + slug + ']');
  const html = await (await fetch('https://hysenlabs.com/projects/' + slug, { headers: UA })).text();
  const concl = parseConclusion(html);
  const what = parseWhatIsIt(html);
  ok(!!concl, '编辑结论解析到（' + (concl ? concl.length : 0) + ' 字）');
  ok(!!what, 'What is it 解析到（' + (what ? what.length : 0) + ' 字）');
  if (concl) console.log('    结论: ' + concl.slice(0, 120) + '…');
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
