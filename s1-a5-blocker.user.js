// ==UserScript==
// @name         S1 a5 内容屏蔽器
// @namespace    https://github.com/pwzzy6/a5-spam-blocker
// @version      0.1.1
// @description  折叠 stage1st（S1）帖子页中包含 a5（哎小呜）内容的楼层与引用块，点击可展开
// @author       pwzzy6
// @match        https://stage1st.com/2b/*
// @run-at       document-end
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @updateURL    https://raw.githubusercontent.com/pwzzy6/a5-spam-blocker/main/s1-a5-blocker.user.js
// @downloadURL  https://raw.githubusercontent.com/pwzzy6/a5-spam-blocker/main/s1-a5-blocker.user.js
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ============ 纯函数（供单测复用） ============

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
    keywords: ['a5', '哎小呜'],
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

  function makeHolder(text, onToggle) {
    const holder = document.createElement('div');
    holder.className = 's1a5-holder';
    holder.innerHTML = '<span class="s1a5-holder-text"></span><a class="s1a5-holder-btn" href="javascript:;">展开</a>';
    holder.querySelector('.s1a5-holder-text').textContent = text;
    let expanded = false;
    holder.querySelector('.s1a5-holder-btn').addEventListener('click', function (ev) {
      ev.preventDefault();
      expanded = !expanded;
      this.textContent = expanded ? '收起' : '展开';
      onToggle(expanded);
    });
    return holder;
  }

  function collapsePost(postEl, msgEl, hit) {
    const pct = postEl.querySelector('div.pct');
    if (!pct) return;
    const signRow = (postEl.querySelector('td.plc.plm') || {}).parentNode || null;
    const floor = getFloorNum(postEl);
    const holder = makeHolder('已屏蔽 a5 内容' + (floor ? '（#' + floor + '）' : '') + ' · 命中「' + hit + '」', function (expanded) {
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
    const holder = makeHolder('已折叠 a5 引用 · 命中「' + hit + '」', function (expanded) {
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
      '.s1a5-holder{margin:4px 0;padding:6px 10px;background:#f5f6f7;border:1px dashed #c0c6cf;border-radius:4px;color:#909399;font-size:12px;line-height:1.6;cursor:default;}',
      '.s1a5-holder .s1a5-holder-btn{margin-left:10px;color:#409eff;cursor:pointer;}',
      '.s1a5-debug{outline:2px solid #f56c6c !important;outline-offset:-2px;position:relative;}',
      '.s1a5-debug-badge{position:absolute;top:0;right:0;z-index:99;background:#f56c6c;color:#fff;font-size:12px;padding:1px 6px;border-radius:0 0 0 4px;}',
      '.s1a5-fab{position:fixed;right:16px;bottom:16px;z-index:99998;background:#409eff;color:#fff;font-size:12px;padding:6px 12px;border-radius:16px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2);}',
      '.s1a5-panel{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;}',
      '.s1a5-panel-box{background:#fff;border-radius:8px;padding:20px 24px;width:420px;max-width:92vw;font-size:13px;color:#303133;box-shadow:0 8px 30px rgba(0,0,0,.25);font-family:system-ui,-apple-system,sans-serif;}',
      '.s1a5-panel-box h3{margin:0 0 12px;font-size:15px;}',
      '.s1a5-panel-box .s1a5-row{display:block;margin:8px 0;}',
      '.s1a5-panel-box textarea{width:100%;box-sizing:border-box;border:1px solid #dcdfe6;border-radius:4px;padding:6px 8px;font:inherit;margin-top:4px;}',
      '.s1a5-panel-box .s1a5-actions{margin-top:14px;display:flex;gap:8px;}',
      '.s1a5-panel-box button{border:1px solid #dcdfe6;background:#fff;border-radius:4px;padding:5px 14px;cursor:pointer;font-size:13px;}',
      '.s1a5-panel-box button[name=save]{background:#409eff;border-color:#409eff;color:#fff;}',
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
    window.__s1a5 = { applyAll: applyAll, openSettings: openSettings, loadSettings: loadSettings, matchKeywords: matchKeywords, normalizeText: normalizeText };
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }

  // 供 Node/bun 单测加载纯函数
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalizeText: normalizeText, matchKeywords: matchKeywords, DEFAULTS: DEFAULTS };
  }
})();
