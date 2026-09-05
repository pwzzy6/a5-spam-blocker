// ==UserScript==
// @name         S1 a5 内容屏蔽器
// @namespace    https://github.com/pwzzy6/a5-spam-blocker
// @version      0.1.4
// @description  折叠 stage1st（S1）帖子页中包含 a5（哎小呜）内容的楼层与引用块，点击可展开
// @author       pwzzy6
// @match        https://stage1st.com/2b/*
// @run-at       document-end
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      fastly.jsdelivr.net
// @connect      cdn.jsdelivr.net
// @updateURL    https://fastly.jsdelivr.net/gh/pwzzy6/a5-spam-blocker@main/s1-a5-blocker.user.js
// @downloadURL  https://fastly.jsdelivr.net/gh/pwzzy6/a5-spam-blocker@main/s1-a5-blocker.user.js
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ============ 纯函数（供单测复用） ============

  // 当前版本；必须与头部 @version 一致（单测有一致性校验）
  const SCRIPT_VERSION = '0.1.4';

  // 更新检查源（国内可直连的 jsDelivr 双域名，任一可达即止）；
  // 请求前按 UPDATE_HOSTS 白名单校验 host，只放行 https + 这两个域名
  const UPDATE_HOSTS = ['fastly.jsdelivr.net', 'cdn.jsdelivr.net'];
  const UPDATE_PATH = '/gh/pwzzy6/a5-spam-blocker@main/s1-a5-blocker.user.js';
  const DOWNLOAD_URL = 'https://fastly.jsdelivr.net' + UPDATE_PATH;
  const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000;

  // 版本比较：点分数字段逐一数值比较，段数不同按 0 补齐；
  // 格式异常一律返回 false（宁可漏提醒，不误弹更新）
  function isNewerVersion(remote, local) {
    const parse = function (v) {
      return typeof v === 'string' && /^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null;
    };
    const a = parse(remote), b = parse(local);
    if (!a || !b) return false;
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (d > 0) return true;
      if (d < 0) return false;
    }
    return false;
  }

  // 归一化：NFKC 折叠全角/兼容字符（ａ５ → a5），小写化，剔除 URL（链接里的 a5 不参与匹配，防误封；
  // 替换为 \u0000 占位而非删除，避免剔除后两侧字符拼接出新命中），去除空白与零宽字符
  function normalizeText(s) {
    return String(s == null ? '' : s)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, '\u0000')
      .replace(/\bwww\.\S+/g, '\u0000')
      .replace(/[\s\u200b-\u200f\u2028\u2029\u2060\ufeff]/g, '');
  }

  // 返回命中的关键词（归一化后），未命中返回 null
  function matchKeywords(text, keywords) {
    const n = normalizeText(text);
    for (const kw of keywords) {
      const k = normalizeText(kw);
      // 归一化后仅剩 URL 占位符的关键词（如纯链接）匹配不到任何正文，跳过，防止变成「命中一切带链接楼层」的通配符
      if (!k.replace(/\u0000/g, '')) continue;
      if (n.includes(k)) return k;
    }
    return null;
  }

  // ============ 配置与存储 ============

  const DEFAULTS = {
    enabled: true,
    keywords: ['a5', '哎小呜', '字母数字'],
    debug: false,   // 调试模式：高亮命中而不折叠
    skipSelf: true, // 不屏蔽自己的楼层
  };

  const store = {
    get(key, def) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(key, undefined);
          return v === undefined ? def : v;
        }
        const raw = localStorage.getItem('s1a5:' + key);
        return raw === null ? def : JSON.parse(raw);
      } catch (e) {
        return def;
      }
    },
    set(key, val) {
      try {
        if (typeof GM_setValue === 'function') {
          GM_setValue(key, val);
          return;
        }
        localStorage.setItem('s1a5:' + key, JSON.stringify(val));
      } catch (e) { /* 存储不可用时静默，功能退化为默认配置 */ }
    },
  };

  function loadSettings() {
    const saved = store.get('settings', null);
    return Object.assign({}, DEFAULTS, saved && typeof saved === 'object' ? saved : {});
  }

  // ============ 更新提醒 ============
  // 背景：TM 自动更新请求 @updateURL，更新源被墙时会静默失败、版本永远卡住。
  // 这里由脚本自己定期从 jsDelivr 再查一次版本，发现新版弹页面横幅——把更新失败
  // 从「静默卡死」变成「看得见」。旧版（≤0.1.2）没有这段逻辑，救不了，只为今后。

  function assertUpdateUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && UPDATE_HOSTS.indexOf(u.hostname) !== -1 ? url : null;
    } catch (e) {
      return null;
    }
  }

  function fetchText(url) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        timeout: 10000,
        onload: function (res) {
          if (res.status === 200) resolve(res.responseText);
          else reject(new Error('HTTP ' + res.status));
        },
        onerror: function () { reject(new Error('network error')); },
        ontimeout: function () { reject(new Error('timeout')); },
      });
    });
  }

  // 依次尝试白名单内的源，取第一个成功响应里的 @version
  async function fetchLatestVersion() {
    for (const host of UPDATE_HOSTS) {
      const url = assertUpdateUrl('https://' + host + UPDATE_PATH);
      if (!url) continue;
      try {
        const m = /@version\s+(\S+)/.exec(await fetchText(url));
        if (m) return m[1];
      } catch (e) { /* 换下一个源 */ }
    }
    return null;
  }

  function showUpdateBar(version) {
    const old = document.querySelector('.s1a5-updbar:not(.s1a5-tip)');
    if (old) old.remove();
    const bar = document.createElement('div');
    bar.className = 's1a5-updbar';
    bar.innerHTML =
      '<span class="s1a5-updbar-text"></span>' +
      '<a class="s1a5-updbar-btn" href="' + DOWNLOAD_URL + '" target="_blank" rel="noopener">一键更新</a>' +
      '<a class="s1a5-updbar-ignore" href="javascript:;">忽略此版</a>';
    bar.querySelector('.s1a5-updbar-text').textContent =
      'a5 屏蔽器有新版本 v' + version + '（当前 v' + SCRIPT_VERSION + '），更新走国内可直连的 jsDelivr';
    bar.querySelector('.s1a5-updbar-ignore').addEventListener('click', function (ev) {
      ev.preventDefault();
      store.set('updDismissed', version);
      bar.remove();
    });
    document.body.appendChild(bar);
  }

  // 菜单手动检查的结果反馈（4 秒自动消失）
  function showTip(text) {
    const old = document.querySelector('.s1a5-updbar.s1a5-tip');
    if (old) old.remove();
    const tip = document.createElement('div');
    tip.className = 's1a5-updbar s1a5-tip';
    const span = document.createElement('span');
    span.textContent = text;
    tip.appendChild(span);
    document.body.appendChild(tip);
    setTimeout(function () { tip.remove(); }, 4000);
  }

  async function checkUpdate(force) {
    if (typeof GM_xmlhttpRequest !== 'function') return; // 本地测试页等环境跳过
    const now = Date.now();
    if (!force && now - Number(store.get('updLastCheck', 0)) < UPDATE_CHECK_INTERVAL) return;
    store.set('updLastCheck', now);
    const remote = await fetchLatestVersion();
    if (!remote) {
      if (force) showTip('检查更新失败：更新源不可达，可稍后再试');
      return;
    }
    if (isNewerVersion(remote, SCRIPT_VERSION) && String(store.get('updDismissed', '')) !== remote) {
      showUpdateBar(remote);
      try {
        if (typeof GM_notification === 'function') {
          GM_notification({ title: 'S1 a5 内容屏蔽器有新版本', text: 'v' + remote + ' 已发布，点击页面顶部横幅一键更新' });
        }
      } catch (e) { /* 通知权限被拒时横幅兜底 */ }
    } else if (force) {
      showTip('已是最新版本 ' + SCRIPT_VERSION);
    }
  }

  // ============ DOM 定位 ============

  const POST_ID_RE = /^post_(\d+)$/;

  function getSelfUid() {
    const a = document.querySelector('#um strong.vwmy a[href*="space-uid-"]');
    if (!a) return null;
    const m = /space-uid-(\d+)/i.exec(a.getAttribute('href') || '');
    return m ? m[1] : null;
  }

  function getPostUid(postEl) {
    const a = postEl.querySelector('.pls .authi a.xw1[href*="space-uid-"], .pls a[href*="space-uid-"]');
    if (!a) return null; // 匿名楼层没有用户链接
    const m = /space-uid-(\d+)/i.exec(a.getAttribute('href') || '');
    return m ? m[1] : null;
  }

  function getFloorNum(postEl) {
    const pid = POST_ID_RE.exec(postEl.id)[1];
    const em = postEl.querySelector('#postnum' + pid + ' em');
    return em ? em.textContent.trim() : '';
  }

  // 正文文字，排除嵌套引用块（引用块单独判定，避免「别人引用 a5」误伤整层）
  function textWithoutQuotes(msgEl) {
    const clone = msgEl.cloneNode(true);
    clone.querySelectorAll('div.quote').forEach((q) => q.remove());
    return withBoundaries(clone);
  }

  // 匹配用文本：在 <br>/<a> 边界补空白。textContent 不含元素边界，链接或换行后紧跟的
  // 正文会与 URL 粘连成同一 token，被 URL 剔除的 \S+ 一并吞掉（漏判）；补空白后剔除只吃 URL 本身。
  // 注意：会原地修改传入节点（插入空白文本节点），只可传克隆/detached 节点
  function withBoundaries(el) {
    el.querySelectorAll('br, a').forEach((n) => {
      n.before(document.createTextNode(' '));
      n.after(document.createTextNode(' '));
    });
    return el.textContent;
  }

  // ============ 折叠/展开 ============

  // opts: { variant: 'post'|'quote', label: 占位文案前缀, hit: 命中关键词 }
  // 命中关键词用 b 元素染色；全部用 DOM API 构造，关键词含 HTML 也不会注入
  function makeHolder(opts, onToggle) {
    const holder = document.createElement('div');
    holder.className = 's1a5-holder s1a5-holder--' + opts.variant;
    const text = document.createElement('span');
    text.className = 's1a5-holder-text';
    text.appendChild(document.createTextNode(opts.label + ' · 命中「'));
    const hitEl = document.createElement('b');
    hitEl.className = 's1a5-holder-hit';
    hitEl.textContent = opts.hit;
    text.appendChild(hitEl);
    text.appendChild(document.createTextNode('」'));
    const btn = document.createElement('a');
    btn.className = 's1a5-holder-btn';
    btn.href = 'javascript:;';
    btn.textContent = '展开';
    let expanded = false;
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      expanded = !expanded;
      btn.textContent = expanded ? '收起' : '展开';
      holder.classList.toggle('s1a5-holder--open', expanded);
      onToggle(expanded);
    });
    holder.appendChild(text);
    holder.appendChild(btn);
    return holder;
  }

  function collapsePost(postEl, msgEl, hit) {
    const pct = postEl.querySelector('div.pct');
    if (!pct) return;
    const signRow = (postEl.querySelector('td.plc.plm') || {}).parentNode || null;
    const floor = getFloorNum(postEl);
    const holder = makeHolder({ variant: 'post', label: '已屏蔽 a5 内容' + (floor ? '（#' + floor + '）' : ''), hit: hit }, function (expanded) {
      pct.style.display = expanded ? '' : 'none';
      if (signRow) signRow.style.display = expanded ? '' : 'none';
    });
    pct.parentNode.insertBefore(holder, pct);
    pct.style.display = 'none';
    if (signRow) signRow.style.display = 'none';
  }

  function collapseQuote(quoteEl, hit) {
    const blockquote = quoteEl.querySelector('blockquote');
    const target = blockquote || quoteEl;
    const holder = makeHolder({ variant: 'quote', label: '已折叠 a5 引用', hit: hit }, function (expanded) {
      target.style.display = expanded ? '' : 'none';
    });
    target.parentNode.insertBefore(holder, target);
    target.style.display = 'none';
  }

  function debugMark(el, hit) {
    el.classList.add('s1a5-debug');
    const badge = document.createElement('div');
    badge.className = 's1a5-debug-badge';
    badge.textContent = 'a5 命中「' + hit + '」';
    el.appendChild(badge);
  }

  // ============ 主流程 ============

  function processPost(postEl, settings, selfUid) {
    if (postEl.dataset.s1a5Done) return;
    postEl.dataset.s1a5Done = '1';

    const msgEl = postEl.querySelector('td.t_f[id^="postmessage_"]');
    if (!msgEl) return;

    // 先处理楼层内引用块
    msgEl.querySelectorAll('div.quote').forEach(function (quoteEl) {
      if (quoteEl.dataset.s1a5Done) return;
      quoteEl.dataset.s1a5Done = '1';
      const hit = matchKeywords(withBoundaries(quoteEl.cloneNode(true)), settings.keywords);
      if (!hit) return;
      if (settings.debug) debugMark(quoteEl, hit);
      else collapseQuote(quoteEl, hit);
    });

    const isSelf = settings.skipSelf && selfUid && getPostUid(postEl) === selfUid;
    const hit = isSelf ? null : matchKeywords(textWithoutQuotes(msgEl), settings.keywords);
    if (!hit) return;
    if (settings.debug) debugMark(msgEl, hit);
    else collapsePost(postEl, msgEl, hit);
  }

  function applyAll() {
    const settings = loadSettings();
    const postlist = document.getElementById('postlist');
    if (!postlist || !settings.enabled) return;
    const selfUid = getSelfUid();
    postlist.querySelectorAll('div[id^="post_"]').forEach(function (el) {
      if (POST_ID_RE.test(el.id)) processPost(el, settings, selfUid);
    });
  }

  let applyTimer = null;
  function scheduleApply() {
    clearTimeout(applyTimer);
    applyTimer = setTimeout(applyAll, 100);
  }

  function observe() {
    const postlist = document.getElementById('postlist');
    if (!postlist) return;
    new MutationObserver(scheduleApply).observe(postlist, { childList: true, subtree: true });
  }

  // ============ 设置面板 ============

  function openSettings() {
    document.querySelector('.s1a5-panel')?.remove();
    const s = loadSettings();
    const panel = document.createElement('div');
    panel.className = 's1a5-panel';
    panel.innerHTML = [
      '<div class="s1a5-panel-box">',
      '  <h3>S1 a5 内容屏蔽器 · 设置</h3>',
      '  <label class="s1a5-row"><input type="checkbox" name="enabled"' + (s.enabled ? ' checked' : '') + '>启用屏蔽</label>',
      '  <label class="s1a5-row"><input type="checkbox" name="skipSelf"' + (s.skipSelf ? ' checked' : '') + '>不屏蔽自己的楼层</label>',
      '  <label class="s1a5-row"><input type="checkbox" name="debug"' + (s.debug ? ' checked' : '') + '>调试模式（红框高亮命中，不折叠）</label>',
      '  <div class="s1a5-row">屏蔽关键词（每行一个，匹配时忽略全角/半角、大小写与空格）：</div>',
      '  <textarea name="keywords" rows="4">' + s.keywords.join('\n').replace(/</g, '&lt;') + '</textarea>',
      '  <div class="s1a5-actions">',
      '    <button name="save">保存并刷新</button>',
      '    <button name="reset">恢复默认</button>',
      '    <button name="close">取消</button>',
      '  </div>',
      '</div>',
    ].join('');
    panel.querySelector('[name=save]').addEventListener('click', function () {
      const next = loadSettings();
      next.enabled = panel.querySelector('[name=enabled]').checked;
      next.skipSelf = panel.querySelector('[name=skipSelf]').checked;
      next.debug = panel.querySelector('[name=debug]').checked;
      next.keywords = panel.querySelector('[name=keywords]').value
        .split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
      if (!next.keywords.length) next.keywords = DEFAULTS.keywords.slice();
      store.set('settings', next);
      location.reload();
    });
    panel.querySelector('[name=reset]').addEventListener('click', function () {
      store.set('settings', DEFAULTS);
      location.reload();
    });
    panel.querySelector('[name=close]').addEventListener('click', function () { panel.remove(); });
    document.body.appendChild(panel);
  }

  function registerMenu() {
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('⚙ 屏蔽关键词与设置…', openSettings);
      GM_registerMenuCommand('🐞 切换调试模式', function () {
        const s = loadSettings(); s.debug = !s.debug; store.set('settings', s); location.reload();
      });
      GM_registerMenuCommand('⏯ 启用/暂停屏蔽', function () {
        const s = loadSettings(); s.enabled = !s.enabled; store.set('settings', s); location.reload();
      });
      GM_registerMenuCommand('🔍 检查更新', function () { checkUpdate(true); });
      return;
    }
    // 无油猴菜单环境（本地测试页）：右下角悬浮入口
    const btn = document.createElement('div');
    btn.className = 's1a5-fab';
    btn.textContent = 'a5 设置';
    btn.addEventListener('click', openSettings);
    document.body.appendChild(btn);
  }

  function injectStyles() {
    const css = [
      // 折叠占位条：对齐论坛 div.quote 视觉（浅蓝底 + 左竖线 + 论坛蓝 #336699）
      '.s1a5-holder{margin:6px 0;padding:6px 10px;background:#f7f9fb;border:1px solid #d9e0e7;border-left:3px solid #9db9d3;border-radius:2px;color:#666;font-size:12px;line-height:1.6;cursor:default;}',
      '.s1a5-holder--quote{margin:4px 0;padding:2px 8px;border-left-width:2px;color:#999;}',
      '.s1a5-holder--open{background:#fbfbfc;}',
      '.s1a5-holder .s1a5-holder-hit{color:#336699;font-weight:600;}',
      '.s1a5-holder .s1a5-holder-btn{margin-left:10px;color:#336699;cursor:pointer;}',
      '.s1a5-holder .s1a5-holder-btn:hover{color:#1f4e79;text-decoration:underline;}',
      '.s1a5-debug{outline:2px solid #f56c6c !important;outline-offset:-2px;position:relative;}',
      '.s1a5-debug-badge{position:absolute;top:0;right:0;z-index:99;background:#f56c6c;color:#fff;font-size:12px;padding:1px 6px;border-radius:0 0 0 4px;}',
      '.s1a5-fab{position:fixed;right:16px;bottom:16px;z-index:99998;background:#336699;color:#fff;font-size:12px;padding:6px 12px;border-radius:16px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2);}',
      '.s1a5-updbar{position:fixed;top:0;left:0;right:0;z-index:99997;display:flex;align-items:center;justify-content:center;gap:14px;background:#336699;color:#fff;font-size:13px;padding:8px 16px;font-family:system-ui,-apple-system,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.2);}',
      '.s1a5-updbar .s1a5-updbar-btn{color:#fff;font-weight:600;text-decoration:underline;}',
      '.s1a5-updbar .s1a5-updbar-ignore{color:rgba(255,255,255,.85);text-decoration:none;font-size:12px;}',
      '.s1a5-updbar.s1a5-tip{background:#67c23a;justify-content:center;}',
      '.s1a5-panel{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;}',
      '.s1a5-panel-box{background:#fff;border-radius:8px;padding:20px 24px;width:420px;max-width:92vw;font-size:13px;color:#333;box-shadow:0 8px 30px rgba(0,0,0,.25);font-family:system-ui,-apple-system,sans-serif;}',
      '.s1a5-panel-box h3{margin:0 0 12px;font-size:15px;}',
      '.s1a5-panel-box .s1a5-row{display:block;margin:8px 0;}',
      '.s1a5-panel-box textarea{width:100%;box-sizing:border-box;border:1px solid #e1e4e8;border-radius:4px;padding:6px 8px;font:inherit;margin-top:4px;}',
      '.s1a5-panel-box .s1a5-actions{margin-top:14px;display:flex;gap:8px;}',
      '.s1a5-panel-box button{border:1px solid #e1e4e8;background:#fff;border-radius:4px;padding:5px 14px;cursor:pointer;font-size:13px;}',
      '.s1a5-panel-box button[name=save]{background:#336699;border-color:#336699;color:#fff;}',
    ].join('\n');
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ============ 启动 ============

  function init() {
    if (!document.getElementById('postlist')) return; // 只在主题帖页生效
    injectStyles();
    applyAll();
    observe();
    registerMenu();
    checkUpdate(false); // 后台静默检查，发现新版才弹横幅
    window.__s1a5 = { applyAll: applyAll, openSettings: openSettings, loadSettings: loadSettings, matchKeywords: matchKeywords, normalizeText: normalizeText };
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }

  // 供 Node/bun 单测加载纯函数
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalizeText: normalizeText, matchKeywords: matchKeywords, isNewerVersion: isNewerVersion, SCRIPT_VERSION: SCRIPT_VERSION, DEFAULTS: DEFAULTS };
  }
})();
