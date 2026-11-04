/**
 * 设置按钮与更新提醒测试。
 *
 * 需求：
 *   · 顶栏有设置按钮（刷新按钮旁边）
 *   · 面板里显示当前版本 / 最新版本
 *   · 有新版本时按钮变色
 *   · 检查频率：每天一次（不能每次开面板都打请求）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { __internals } from '../lib/index.js';

const src = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');
const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x ? ' | ' + x : '')); } };

console.log('[1] 后端版本检查接口');
ok(/if \(path === '\/update'\)/.test(host), '/update 路由存在');
ok(/const UPDATE_TTL_MS = 24 \* 60 \* 60 \* 1000/.test(host), '缓存 24 小时（每天查一次）');
ok(/registry\.npmjs\.org\/' \+ name \+ '\/latest/.test(host), '查询 npm latest');
ok(/hasUpdate: latest \? compareVersion\(latest, VERSION\) > 0/.test(host), '计算 hasUpdate');

console.log('\n[2] 版本比较');
const { compareVersion } = __internals;
ok(compareVersion('0.3.0', '0.2.0') === 1, '0.3.0 > 0.2.0');
ok(compareVersion('0.2.0', '0.3.0') === -1, '0.2.0 < 0.3.0');
ok(compareVersion('0.2.0', '0.2.0') === 0, '相同版本');
ok(compareVersion('0.10.0', '0.9.0') === 1, '0.10.0 > 0.9.0（两位数）');
ok(compareVersion('1.0.0', '0.99.99') === 1, '跨大版本');
ok(compareVersion('0.2.1', '0.2.1-beta') === 0, '忽略预发布后缀');

console.log('\n[3] 前端设置按钮');
ok(/hp-settings-btn/.test(src), '设置按钮有独立 class');
ok(/GEAR_ICON_SVG/.test(src), '有齿轮图标');
ok(/t\('settings\.title'\)/.test(src), '按钮文案走 i18n');
ok(/hp-btn-update/.test(src), '有新版高亮样式类');
ok(/hp-update-dot/.test(src), '有更新提示小圆点');

console.log('\n[4] 有新版本时按钮变色');
ok(/updateInfo && updateInfo\.hasUpdate \? ' hp-btn-update' : ''/.test(src), '按 hasUpdate 切换 class');
ok(/\.hp-btn\.hp-btn-update\{[\s\S]{0,120}color:var\(--hp-accent\)/.test(src), '高亮时用强调色');
ok(/@keyframes hp-pulse/.test(src), '小圆点有脉冲动画');
ok(/prefers-reduced-motion[\s\S]{0,80}hp-update-dot\{animation:none\}/.test(src), '尊重系统减少动效偏好');

console.log('\n[5] 设置面板内容');
ok(/settings\.current/.test(src), '显示当前版本');
ok(/settings\.latest/.test(src), '显示最新版本');
ok(/settings\.upToDate/.test(src), '已最新时给提示');
ok(/dsh plugin --profile desktop add dsh-github-hot@/.test(src), '给出升级命令');
ok(/settings\.checkNow/.test(src), '有「立即检查」按钮');
ok(/settings\.repo/.test(src), '有项目主页链接');

console.log('\n[6] 每天只检查一次');
ok(/dsh-github-hot:update/.test(src), '有本地缓存键');
ok(/saved\.day === today/.test(src), '按日期判断是否复用缓存');
ok(/localDayKey\(\)/.test(src), '用数据源时区算「今天」');

console.log('\n[7] 面板可关闭');
ok(/hp-settings-mask/.test(src), '有遮罩层');
ok(/e\.target === e\.currentTarget/.test(src), '点遮罩关闭');
ok(/hp-settings-x/.test(src), '有关闭按钮');

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
