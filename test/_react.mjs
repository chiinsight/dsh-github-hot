/**
 * 测试辅助：定位本机已安装的 React 与 react-dom。
 *
 * ⚠️ 这里**不能写死绝对路径** —— 那会让测试绑死在某一台机器上，
 * 别人 clone 下来也跑不了。改为按 DSH 的目录约定动态查找：
 *   1. 环境变量 DSH_HOME
 *   2. $HOME/.dsh（DSH 默认位置）
 * 找得到就用，找不到就返回 null，让调用方跳过依赖 React 的测试。
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 在 pnpm 的 .pnpm 目录里找某个包的实体路径。 */
function findInPnpm(profileDir, pkgPrefix) {
  const pnpmDir = join(profileDir, 'node_modules', '.pnpm');
  if (!existsSync(pnpmDir)) return null;
  let names;
  try {
    names = readdirSync(pnpmDir);
  } catch {
    return null;
  }
  // 形如 react@18.3.1 或 react-dom@18.3.1_react@18.3.1
  const hit = names.find((n) => n.startsWith(pkgPrefix + '@'));
  if (!hit) return null;
  const pkgName = hit.split('@')[0];
  const candidate = join(pnpmDir, hit, 'node_modules', pkgName);
  return existsSync(candidate) ? candidate : null;
}

/**
 * 返回 { React, renderToString } 或 null（本机没装 React 时）。
 *
 * 注意：react 与 react-dom 必须从**各自**的目录解析 —— 从同一个入口 require
 * 会拿到两份不同的 React 副本，renderToString 会报 "Objects are not valid as a React child"。
 */
export function loadReact() {
  // 优先使用开发依赖，使测试不依赖本机 Harness 的安装布局。
  try {
    const require = createRequire(import.meta.url);
    return { React: require('react'), renderToString: require('react-dom/server').renderToString };
  } catch { /* 兼容只有宿主依赖的开发环境 */ }
  const home = dshHome();
  for (const profile of ['desktop', 'web', 'headless']) {
    const dir = join(home, 'profiles', profile);
    const reactPath = findInPnpm(dir, 'react');
    const domPath = findInPnpm(dir, 'react-dom');
    if (!reactPath || !domPath) continue;
    try {
      const reqReact = createRequire(join(reactPath, 'package.json'));
      const reqDom = createRequire(join(domPath, 'package.json'));
      const React = reqReact('react');
      const server = reqDom('react-dom/server');
      if (React && server && typeof server.renderToString === 'function') {
        return { React, renderToString: server.renderToString };
      }
    } catch {
      /* 换下一个 profile */
    }
  }
  return null;
}
