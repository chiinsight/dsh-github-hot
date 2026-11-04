/**
 * 浏览器半侧契约测试：在 vm 里模拟 DSH 的 __ModuleLoader__，
 * 校验 client.js 能注册、能 apply 两个挂载点、能渲染不崩。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? ' | ' + extra : '')); } };

// ---- 极简 DOM / React 替身 ----
const styles = [];
const doc = {
  getElementById: (id) => styles.find((s) => s.id === id) || null,
  createElement: (tag) => ({ tag, id: '', textContent: '' }),
  head: { appendChild: (el) => styles.push(el) },
};

function makeReact() {
  const createElement = (type, props, ...children) => ({ type, props: props || {}, children });
  const hooks = [];
  let cursor = 0;
  const React = {
    createElement,
    useState: (init) => { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init;
      return [hooks[i], (v) => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }]; },
    useEffect: (fn) => { cursor++; }, // 不执行副作用（不真的发请求）
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
    Fragment: 'Fragment',
  };
  return React;
}

// ---- 加载 client.js ----
let registered = null;
const sandbox = {
  console,
  document: doc,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, boards: [] }) }),
  AbortController,
  window: {
    __ModuleLoader__: { load: (def) => { registered = def; } },
  },
};
sandbox.window.window = sandbox.window;
sandbox.globalThis = sandbox;

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

console.log('\n[1] 注册');
ok(registered !== null, '调用了 __ModuleLoader__.load');
ok(registered && registered.id === 'dsh-github-hot', 'id = dsh-github-hot');
ok(typeof registered.factory === 'function', 'factory 是函数');

console.log('\n[2] 模块形状');
const React = makeReact();
const mod = registered.factory((name) => {
  if (name === 'react') return React;
  throw new Error('未预期的 require: ' + name);
});
ok(mod.name === 'dsh-github-hot', 'name 一致');
ok(Array.isArray(mod.inject) && mod.inject.includes('slots'), 'inject 含 slots');
ok(typeof mod.apply === 'function', '有 apply');

console.log('\n[3] 挂载点');
const mounts = [];
const ctx = {
  slots: {
    inject: (slotName, gen) => { mounts.push(slotName); const it = gen(); try { it.next(); } catch (e) {} },
    register: (spec) => { return () => {}; },
  },
};
mod.apply(ctx);
ok(mounts.includes('main'), '注册了 main（主面板）');
ok(mounts.includes('sidebar.panellist'), '注册了 sidebar.panellist（侧栏入口）');

console.log('\n[4] 样式注入');
ok(styles.length === 1 && styles[0].id === 'dsh-github-hot/styles', '样式表注入一次');
ok(styles[0].textContent.includes('.hp-card'), '样式含卡片类');
ok(styles[0].textContent.includes('.hp-chart'), '样式含图表类');

console.log('\n[5] 渲染不崩');
// 抓 Panel 组件：main 注册时的第二个参数
let PanelComp = null;
const ctx2 = {
  slots: {
    inject: (slotName, gen) => { const it = gen(); const r = it.next(); if (slotName === 'main' && r.value) PanelComp = r.value; },
    register: (spec, comp) => { return () => {}; },
  },
};
// register 的第二个参数就是组件；上面 gen() 已把组件交给 register
mod.apply(ctx2);
ok(PanelComp !== null, '拿到了 Panel 组件');

if (PanelComp) {
  let tree;
  try { tree = PanelComp(); ok(true, '首次渲染不抛错'); }
  catch (e) { ok(false, '首次渲染抛错', e.message); }

  if (tree) {
    ok(tree.props.className === 'hp-root', '根节点 class = hp-root');
    const texts = [];
    const walk = (node) => {
      if (node === null || node === undefined) return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return; }
      if (node.children) node.children.forEach(walk);
    };
    walk(tree);
    const joined = texts.join(' ');
    ok(joined.includes('日榜') && joined.includes('周榜') && joined.includes('月榜'), '三个周期按钮都在');
    ok(joined.includes('卡片') && joined.includes('大盘'), '两个视图切换都在');
    ok(joined.includes('数据来自') || joined.includes('加载'), '底部有数据署名');
  }
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
