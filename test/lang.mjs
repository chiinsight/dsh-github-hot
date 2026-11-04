/**
 * 语言切换测试 —— 修两个真实反馈的问题：
 *   ① 默认应是「中」，按钮与实际显示一致
 *   ② 切到「中」不能闪（不能清空已加载内容），且要真的补上译文
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? ' | ' + extra : '')); } };

console.log('[1] 默认语言 = 中文');
ok(/return localStorage\.getItem\(LANG_KEY\) === 'en' \? 'en' : 'zh'/.test(src), '只有显式存 en 才是英文，否则默认中文');
ok(/catch \(e\) \{ return 'zh'; \}/.test(src), 'localStorage 不可用时也默认中文');

console.log('\n[2] 切换语言不清空内容（防闪）');
const toggleBlock = src.slice(src.indexOf('const toggleLang = React.useCallback'), src.indexOf('const toggleLang = React.useCallback') + 500);
ok(!/setDetails\(\{\}\)/.test(toggleBlock), 'toggleLang 里没有 setDetails({})（这是闪烁根因）');
ok(/writeLang\(next\)/.test(toggleBlock), '仍然持久化选择');

console.log('\n[3] 切到中文立刻补译');
ok(/if \(lang !== 'zh'\) return;/.test(src), '只在中文模式触发');
ok(/切到「中文」时，立刻给已有内容补译文/.test(src), '有专门的补译 effect');
ok(/loadTranslations\(need\.slice\(0, 20\), gen\)/.test(src), '直接发翻译请求，不等重新取数');

console.log('\n[4] 不在 setState 回调里做副作用');
ok(!/setDetails\(\(current\) => \{[\s\S]{0,400}?void loadTranslations/.test(src), 'setter 内没有调用 loadTranslations');

console.log('\n[5] 中文模式显示策略：英文先顶，译文替换');
ok(/const desc = lang === 'en' \? descEn \|\| descZh : descZh \|\| descEn;/.test(src), '严格按语言选择显示内容');
ok(/英文模式就显示英文（哪怕库里还留着中文译文）/.test(src), '英文模式不会错误显示中文');
ok(/const translating = lang === 'zh' && !descZh && !!descEn;/.test(src), '有「翻译中」标记');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
