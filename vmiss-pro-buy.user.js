// ==UserScript==
// @name         VMISS 抢购助手
// @namespace    vmiss-pro
// @version      3.2.0
// @description  VMISS 库存监控与自动抢购：商品浏览、配置项、优惠码、推送，全部在插件内
// @author       VMISS PRO
// @license      MIT
// @homepageURL  https://greasyfork.org/zh-CN/scripts/599690-vmiss-%E6%8A%A2%E8%B4%AD%E5%8A%A9%E6%89%8B
// @supportURL   https://greasyfork.org/zh-CN/scripts/599690-vmiss-%E6%8A%A2%E8%B4%AD%E5%8A%A9%E6%89%8B/feedback
// @source       https://github.com/threce/vmiss-buy-helper
// @updateURL    https://raw.githubusercontent.com/threce/vmiss-buy-helper/main/vmiss-pro-buy.user.js
// @downloadURL  https://raw.githubusercontent.com/threce/vmiss-buy-helper/main/vmiss-pro-buy.user.js
// @match        https://app.vmiss.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @connect      api.telegram.org
// @connect      oapi.dingtalk.com
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const LATEST = '3.2.0';
  const VERSION_URL = '';

  const K = (n) => 'vmiss_v3_' + n;
  const load = (n, d) => { const v = GM_getValue(K(n), undefined); return v === undefined ? d : v; };
  const save = (n, v) => GM_setValue(K(n), v);

  const DB = {
    monitors: load('monitors', []),
    queues: load('queues', []),
    settings: load('settings', {
      defaultIntervalMs: 30000,
      minGapMs: 1700,
      burstGapMs: 350,
      prewarmCsrf: true,
      defaultCoupon: '10%OFF',
      maxConcurrent: 1,
      notify: true,
      tgToken: '',
      tgChat: '',
      dingWebhook: '',
      dingSecret: '',
      pushOnRestock: true,
      pushOnBuy: true,
      pushOnError: false,
      seenIntro: false,
      lastVersion: '',
    }),
    catalog: load('catalog', { at: 0, cats: [], products: [] }),
    optCache: load('optCache', {}),
    logs: [],
  };

  const SETTING_DEFAULTS = {
    defaultCoupon: '10%OFF',
    burstGapMs: 350,
    prewarmCsrf: true,
    tgToken: '', tgChat: '', dingWebhook: '', dingSecret: '',
    pushOnRestock: true, pushOnBuy: true, pushOnError: false,
    seenIntro: false, lastVersion: '',
    fetchAllGapMs: 6000,
  };
  (function migrate() {
    let changed = false;
    for (const k of Object.keys(SETTING_DEFAULTS)) {
      if (DB.settings[k] === undefined) { DB.settings[k] = SETTING_DEFAULTS[k]; changed = true; }
    }
    if (DB.settings.dingToken !== undefined && !DB.settings.dingWebhook) {
      DB.settings.dingWebhook = DB.settings.dingToken; changed = true;
    }
    delete DB.settings.dingToken;
    if (changed) save('settings', DB.settings);

    let monChanged = false;
    for (const m of DB.monitors) {
      if (m.useCoupon === undefined) { m.useCoupon = true; monChanged = true; }
    }
    if (monChanged) save('monitors', DB.monitors);
  })();

  const persist = () => save('monitors', DB.monitors);
  let uid = load('uid', 0);
  const nextId = () => { uid += 1; save('uid', uid); return uid; };

  function log(level, text) {
    DB.logs.unshift({ level, text, t: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
    if (DB.logs.length > 500) DB.logs.pop();
    if (level === 'error') console.warn('[VMISS]', text); else console.log('[VMISS]', text);
    if (UI.ready && UI.tab === 'logs') UI.renderLogs();
  }

  function push(title, body) {
    const s = DB.settings;
    if (s.notify && typeof Notification !== 'undefined') {
      try { new Notification(title, { body }); } catch (e) { /* 忽略 */ }
    }
    if (s.tgToken && s.tgChat) {
      const url = 'https://api.telegram.org/bot' + s.tgToken + '/sendMessage';
      const data = JSON.stringify({ chat_id: s.tgChat, text: title + '\n' + body, disable_web_page_preview: true });
      try {
        GM_xmlhttpRequest({
          method: 'POST', url, data,
          headers: { 'Content-Type': 'application/json' },
          onload: (r) => { if (!/\"ok\":true/.test(r.responseText || '')) log('warn', 'TG 推送失败: ' + String(r.responseText || '').slice(0, 120)); },
          onerror: () => log('warn', 'TG 推送网络错误'),
        });
      } catch (e) { log('warn', 'TG 推送异常: ' + e.message); }
    }
    if (s.dingWebhook) void sendDing(s.dingWebhook, s.dingSecret, title, body);
  }

  async function dingSign(ts, secret) {
    if (!(crypto && crypto.subtle && crypto.subtle.importKey)) {
      throw new Error('当前环境没有 crypto.subtle，无法加签');
    }
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, enc.encode(ts + '\n' + secret));
    const bytes = new Uint8Array(mac);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
    return encodeURIComponent(btoa(bin));
  }

  async function sendDing(rawHook, rawSecret, title, body) {
    try {
      let url = String(rawHook || '').trim();
      if (!url) return;
      if (url.indexOf('http') < 0) {
        url = url.indexOf('access_token=') >= 0
          ? 'https://oapi.dingtalk.com/robot/send?' + url.replace(/^\?/, '')
          : 'https://oapi.dingtalk.com/robot/send?access_token=' + url;
      }

      const secret = String(rawSecret || '').trim();
      if (secret) {
        const ts = Date.now();
        const sign = await dingSign(ts, secret);
        url += '&timestamp=' + ts + '&sign=' + sign;
        log('info', '  [钉钉] 加签模式（SEC ' + secret.slice(0, 6) + '… · timestamp ' + ts + '）');
      } else {
        log('info', '  [钉钉] 无加签（关键词 / IP 白名单模式）');
      }

      const data = JSON.stringify({ msgtype: 'text', text: { content: title + '\n' + body } });
      log('info', '  [钉钉] POST ' + url.replace(/access_token=[^&]+/, 'access_token=***').slice(0, 72));

      GM_xmlhttpRequest({
        method: 'POST', url, data, headers: { 'Content-Type': 'application/json' },
        onload: (r) => {
          const txt = String(r.responseText || '');
          let j = null;
          try { j = JSON.parse(txt); } catch (e) { /* 非 JSON */ }
          const code = j ? j.errcode : null;
          const msg = j ? String(j.errmsg || '') : txt.slice(0, 160);
          if (code === 0) { log('info', '  [钉钉] 推送成功'); return; }
          if (code === 300005 || code === 300001) {
            log('error', '  [钉钉] access_token 无效（' + code + '）—— 请复制钉钉给的整段 Webhook 地址');
            return;
          }
          if (code === 310000 || /sign/i.test(msg)) {
            if (secret) {
              log('error', '  [钉钉] 加签未通过（' + code + '）：' + msg);
              log('error', '    检查 SEC 是否完整（应以 SEC 开头，通常 64 位）。当前填的是 ' + secret.length + ' 位：' + secret.slice(0, 6) + '…');
            } else {
              log('error', '  [钉钉] 关键词不匹配（' + code + '）：' + msg);
              log('error', '    到机器人设置里把关键词改成 VMISS（推送标题以它开头）');
            }
            return;
          }
          log('warn', '  [钉钉] 返回 ' + code + '：' + msg);
        },
        onerror: (e) => log('error', '  [钉钉] 网络错误 ' + String((e && e.error) || '')),
        ontimeout: () => log('error', '  [钉钉] 请求超时'),
      });
    } catch (e) {
      log('error', '  [钉钉] 异常 ' + String(e.message || e));
    }
  }

  let lastReqAt = 0;
  let trace = null;
  let reqSeq = 0;
  let burst = false;
  let cfNotified = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CHALLENGE = /Just a moment|请稍候|challenge-platform|_cf_chl_opt|正在进行安全验证/i;
  const fmtBytes = (n) => (n < 1024 ? n + 'B' : n < 1048576 ? (n / 1024).toFixed(1) + 'KB' : (n / 1048576).toFixed(2) + 'MB');
  const isBad = (st, tx) => st === 403 || st === 429 || st < 200 || st >= 500 || CHALLENGE.test(tx.slice(0, 3000));

  function cfVerdict(st, tx) {
    const head = tx.slice(0, 9000);
    const ray = (head.match(/Ray ID:?\s*(?:<[^>]*>\s*)?([a-f0-9]{10,}-[A-Z]{3})/i) || head.match(/([a-f0-9]{16})-[A-Z]{3}/) || [])[1] || null;
    if (st === 429) return { kind: 'limit', text: '站点限速 429', ray };
    if (st === 403) {
      if (/Attention Required|You have been blocked|cf-error-details|Sorry, you have been blocked/i.test(head)) {
        return { kind: 'waf', text: 'Cloudflare WAF 拉黑了这个地址（连你在地址栏打开也会被拦，非插件问题）', ray };
      }
      if (CHALLENGE.test(head)) return { kind: 'challenge', text: 'Cloudflare 人机验证页', ray };
      return { kind: 'deny', text: '服务端 403 拒绝', ray };
    }
    if (CHALLENGE.test(head)) return { kind: 'challenge', text: 'Cloudflare 人机验证页', ray };
    if (st < 200 || st >= 500) return { kind: 'err', text: 'HTTP ' + st, ray };
    return null;
  }

  async function req(path, init) {
    const gapMs = burst ? DB.settings.burstGapMs : DB.settings.minGapMs;
    const gap = Math.max(0, lastReqAt + gapMs - Date.now());
    if (gap > 0) await sleep(gap);
    lastReqAt = Date.now();
    const method = (init && init.method) || 'GET';
    const seq = String(++reqSeq).padStart(3, ' ');
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(location.origin + path, Object.assign({ credentials: 'include', redirect: 'follow' }, init || {}));
    } catch (e) {
      if (trace) log('error', '  ' + seq + ' ' + method + ' ' + path.slice(0, 44) + ' 网络错误: ' + e.message);
      throw e;
    }
    const text = await res.text();
    const ms = Date.now() - t0;
    const verdict = cfVerdict(res.status, text);
    if (trace) {
      let flag = 'OK';
      let lv = 'info';
      if (verdict) { flag = verdict.text.slice(0, 14); lv = 'warn'; }
      if (verdict && verdict.ray) flag += ' Ray=' + verdict.ray;
      log(lv, '  ' + seq + ' ' + method.padEnd(4) + ' ' + path.slice(0, 44) + ' -> ' + res.status + ' ' + fmtBytes(text.length) + ' ' + ms + 'ms ' + flag);
    }
    return { status: res.status, text, url: res.url, verdict };
  }

  const post = (path, obj) => req(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(obj).toString(),
  });

  function cfReload(where) {
    if (Date.now() - cfNotified < 8000) return;
    cfNotified = Date.now();
    log('warn', '命中 Cloudflare 验证（' + where + '），页面 1 秒后重载');
    setTimeout(() => location.reload(), 1000);
  }

  let csrfCache = { v: '', at: 0 };
  async function csrf(force) {
    if (!force && csrfCache.v && Date.now() - csrfCache.at < 600000) return csrfCache.v;
    const r = await req('/clientarea.php');
    if (isBad(r.status, r.text)) { cfReload('clientarea'); return null; }
    const m = r.text.match(/var csrfToken\s*=\s*'([a-f0-9]+)'/);
    if (!m) return null;
    csrfCache = { v: m[1], at: Date.now() };
    if (trace) log('info', '  [会话] csrfToken ' + m[1].slice(0, 8));
    return m[1];
  }

  let loginState = { ok: null, email: '', at: 0 };
  async function checkLogin(force) {
    if (!force && loginState.ok !== null && Date.now() - loginState.at < 120000) return loginState;
    const r = await req('/clientarea.php');
    if (/\/login\b/.test(r.url || '') || /Secure Client Login|id="inputEmail"/.test(r.text.slice(0, 40000))) {
      loginState = { ok: false, email: '', at: Date.now() };
      return loginState;
    }
    if (isBad(r.status, r.text)) { loginState = { ok: null, email: '', at: Date.now() }; return loginState; }
    loginState = { ok: true, email: '已登录', at: Date.now() };
    return loginState;
  }

  const clean = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

  function parseSelect(blk) {
    const opts = [];
    let selected = null;
    for (const m of blk.matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/gi)) {
      const attrs = m[1];
      const v = (attrs.match(/value="([^"]*)"/) || [])[1];
      if (v === undefined) continue;
      const t = clean(m[2]);
      const isSel = /\bselected\b/i.test(attrs);
      if (isSel && selected === null) selected = v;
      opts.push({ v, t });
    }
    return { opts, selected };
  }

  function genRootPw() {
    const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const L = 'abcdefghijkmnpqrstuvwxyz';
    const D = '23456789';
    const S = '!@#%^*';
    const all = U + L + D + S;
    let s = U[Math.floor(Math.random() * U.length)] + L[Math.floor(Math.random() * L.length)]
      + D[Math.floor(Math.random() * D.length)] + S[Math.floor(Math.random() * S.length)];
    for (let i = 0; i < 12; i += 1) s += all[Math.floor(Math.random() * all.length)];
    return s;
  }

  async function fetchCategories(soft) {
    const r = await req('/store');
    if (isBad(r.status, r.text)) { if (soft) return { limited: true, status: r.status, verdict: r.verdict }; cfReload('store'); return null; }
    const out = [], seen = {};
    const put = (slug, name) => {
      if (!slug || seen[slug]) return;
      seen[slug] = 1;
      out.push({ slug, name: (name || slug).slice(0, 40) });
    };
    let m;
    const re1 = /menuItemName="([^"]*)"[^>]*>[\s\S]{0,300}?href="\/store\/([a-z0-9-]+)"/gi;
    while ((m = re1.exec(r.text))) put(m[2], clean(m[1]));
    const re2 = /<a[^>]*href="\/store\/([a-z0-9-]+)"[^>]*>([\s\S]{0,60}?)<\/a>/gi;
    while ((m = re2.exec(r.text))) put(m[1], clean(m[2]));
    return out;
  }

  async function fetchProducts(catSlug, catName, soft) {
    const r = await req('/store/' + catSlug);
    if (isBad(r.status, r.text)) {
      if (soft) return { limited: true, status: r.status, len: r.text.length, verdict: r.verdict };
      cfReload('store/' + catSlug);
      return null;
    }
    const out = [];
    for (const b of r.text.split(/<div class="package[\s"]/i).slice(1)) {
      const pid = (b.match(/id="product(\d+)"/i) || [])[1];
      if (!pid) continue;
      const priceRaw = clean((b.match(/<div class="price-amount">([\s\S]*?)<\/div>/i) || [])[1]);
      const qty = clean((b.match(/<div class="package-qty">([\s\S]*?)<\/div>/i) || [])[1]);
      const specs = clean((b.match(/<div class="package-content">([\s\S]*?)<\/div>/i) || [])[1]);
      out.push({
        pid: Number(pid),
        name: clean((b.match(/<h3 class="package-title">([\s\S]*?)<\/h3>/i) || [])[1]),
        slug: (b.match(/href="\/store\/[a-z0-9-]+\/([a-z0-9-]+)"/i) || [])[1] || '',
        categorySlug: catSlug,
        categoryName: catName || catSlug,
        price: Number.parseFloat((priceRaw.replace(/,/g, '').match(/[\d.]+/) || ['0'])[0]) || 0,
        specs: specs.slice(0, 140),
        stock: qty,
        inStock: !/out of stock|sold out|售罄|缺货|已下架/i.test(b) && !/^0\s*(可用|Available)/i.test(qty),
      });
    }
    return out;
  }

  async function readConfigOptions(m, i) {
    const cached = DB.optCache[m.pid];
    if (cached && cached.items) return cached;

    const r = await req('/cart.php?a=confproduct&i=' + i);
    const at = r.text.indexOf('productConfigurableOptions');
    const scope = at >= 0 ? r.text.slice(at, at + 80000) : r.text;
    const items = [];

    for (const m2 of scope.matchAll(/<select[^>]*name="(configoption\[\d+\])"[^>]*>([\s\S]{0,120000}?)<\/select>/gi)) {
      const name = m2[1];
      const ps = parseSelect(m2[0]);
      const opts = ps.opts;
      if (!opts.length) continue;
      const head = scope.slice(Math.max(0, m2.index - 2000), m2.index);
      const h = [...head.matchAll(/<h[1-6][^>]*class="[^"]*section-title[^"]*"[^>]*>([\s\S]{0,80}?)<\/h[1-6]>/gi)].pop()
        || [...head.matchAll(/<label[^>]*>([\s\S]{0,80}?)<\/label>/gi)].pop();
      const def = ps.selected !== null ? ps.selected : ((opts.filter((o) => !/^\s*$/.test(o.v))[0] || opts[0]) || {}).v;
      items.push({ name, title: h ? clean(h[1]) : name, opts, kind: 'select', def });
    }

    for (const m2 of scope.matchAll(/<input[^>]*type="(?:text|password|number|hidden)"[^>]*>/gi)) {
      const tag = m2[0];
      const nm = (tag.match(/name="([^"]+)"/) || [])[1];
      if (!nm || nm.indexOf('configoption[') !== 0) continue;
      if (items.some((x) => x.name === nm)) continue;
      const ty = (tag.match(/type="([^"]+)"/) || [])[1] || 'text';
      const head = scope.slice(Math.max(0, m2.index - 1500), m2.index);
      const h = [...head.matchAll(/<h[1-6][^>]*class="[^"]*section-title[^"]*"[^>]*>([\s\S]{0,80}?)<\/h[1-6]>/gi)].pop();
      items.push({
        name: nm,
        title: h ? clean(h[1]) : nm,
        opts: [],
        kind: ty === 'number' ? 'number' : 'text',
        ph: (tag.match(/placeholder="([^"]*)"/) || [])[1] || '',
        min: (tag.match(/min="([^"]*)"/) || [])[1] || '',
        max: (tag.match(/max="([^"]*)"/) || [])[1] || '',
        def: (tag.match(/value="([^"]*)"/) || [])[1] || '',
      });
    }

    const cache = { items, at: Date.now() };
    DB.optCache[m.pid] = cache;
    save('optCache', DB.optCache);
    return cache;
  }

  function norm(s) {
    return String(s || '').toLowerCase().replace(/[\s\-_().\/]/g, '');
  }
  function matchOption(opts, want) {
    const w = norm(want);
    if (!w) return null;
    var hit = null;
    for (var a = 0; a < opts.length; a += 1) if (norm(opts[a].t) === w) { hit = opts[a].v; break; }
    if (hit) return hit;
    for (var b = 0; b < opts.length; b += 1) if (norm(opts[b].t).indexOf(w) >= 0) { hit = opts[b].v; break; }
    if (hit) return hit;
    for (var c = 0; c < opts.length; c += 1) if (w.indexOf(norm(opts[c].t)) >= 0 && opts[c].t) { hit = opts[c].v; break; }
    return hit;
  }

  async function addToCart(m) {
    const r = await req('/store/' + m.categorySlug + '/' + m.slug);
    if (isBad(r.status, r.text) || r.text.length < 20000) {
      return { limited: true, status: r.status, len: r.text.length, verdict: r.verdict };
    }
    return {
      ok: /frmConfigureProduct/.test(r.text),
      i: (r.text.match(/name="i"[^>]*value="(\d+)"/) || [])[1] || null,
      oos: /缺货|Out of Stock|out of stock|Sold Out/i.test(r.text.slice(0, 20000)),
      status: r.status,
    };
  }

  async function configure(m, token, i) {
    const body = {
      configure: 'true', i, token, ajax: '1', a: 'confproduct',
      billingcycle: m.billingCycle || 'monthly',
      hostname: m.hostname || ('srv-' + Math.random().toString(36).slice(2, 8) + '.local'),
      ns1prefix: m.ns1Prefix || 'ns1',
      ns2prefix: m.ns2Prefix || 'ns2',
    };

    if (m.rootPassword) {
      body.rootpw = m.rootPassword;
    } else {
      body.rootpw = m.genPw || genRootPw();
      m.genPw = body.rootpw;
      persist();
      log('warn', '  [配置] 未设置 root 密码，已自动生成：' + body.rootpw);
      log('warn', '  [配置] 请记下这串密码 —— 服务器开通后用它登录 SSH');
    }

    const cache = await readConfigOptions(m, i);
    const all = cache.items || [];
    for (const it of all) {
      if (it.kind === 'select') {
        const first = (it.opts.filter((o) => !/^\s*$/.test(o.v))[0] || it.opts[0]);
        body[it.name] = (first && first.v) || it.def || '';
      } else {
        body[it.name] = it.def || '';
      }
    }

    const picks = m.options || {};
    let over = 0;
    for (const k of Object.keys(picks)) {
      if (picks[k] === '' || picks[k] === undefined || picks[k] === null) continue;
      if (body[k] === picks[k]) continue;
      body[k] = picks[k];
      over += 1;
    }

    log('info', '  [配置] 提交 ' + Object.keys(body).length + ' 个字段（配置项 ' + all.length + ' 个，覆盖 ' + over + ' 个）');
    let r = await post('/cart.php', body);
    if (/已经被使用|already (?:in use|exists)/i.test(r.text)) {
      log('warn', '  [配置] 主机名重复，换一个重试');
      body.hostname = 'srv-' + Math.random().toString(36).slice(2, 8) + '.local';
      r = await post('/cart.php', body);
    }
    if (r.text.trim().length === 0) return { ok: true, err: '' };
    if (/已经被使用|已经有记录/i.test(r.text)) return { ok: false, err: clean(r.text).slice(0, 120) };
    log('info', '  [配置] 响应非空，核验购物车');
    const v = await req('/cart.php?a=view');
    const ok = /name="promocode"/.test(v.text) || /name="i"[^>]*value="\d+"/.test(v.text);
    return { ok, err: clean(r.text).slice(0, 160) };
  }

  function fieldsOf(html) {
    const out = {};
    for (const m of html.matchAll(/<input[^>]*>/gi)) {
      const tag = m[0];
      const name = (tag.match(/name="([^"]+)"/) || [])[1];
      if (!name) continue;
      const type = (tag.match(/type="([^"]+)"/) || [])[1] || 'text';
      if (type === 'radio' || type === 'checkbox') {
        if (/\bchecked\b/i.test(tag)) out[name] = (tag.match(/value="([^"]*)"/) || [])[1] || 'on';
        continue;
      }
      if (out[name] === undefined) out[name] = (tag.match(/value="([^"]*)"/) || [])[1] || '';
    }

    let sp = 0;
    while (sp < html.length) {
      const s = html.indexOf('<select', sp);
      if (s < 0) break;
      const e = html.indexOf('</select>', s);
      if (e < 0) break;
      const blk = html.slice(s, e);
      sp = e + 9;
      const name = (blk.match(/name="([^"]+)"/) || [])[1];
      if (!name || out[name] !== undefined) continue;
      const ps = parseSelect(blk);
      if (ps.selected !== null) out[name] = ps.selected;
      else if (ps.opts.length) out[name] = ps.opts[0].v;
    }
    for (const m of html.matchAll(/<textarea[^>]*name="([^"]+)"[^>]*>([\s\S]{0,2000}?)<\/textarea>/gi)) {
      if (out[m[1]] === undefined) out[m[1]] = m[2].trim();
    }
    return out;
  }

  async function submitOrder(m, token) {
    const co = await req('/cart.php?a=checkout');
    if (isBad(co.status, co.text)) return { ok: false, msg: '结账页拿不到 HTTP ' + co.status };
    const f = fieldsOf(co.text);
    if (!f.paymentmethod && !f.firstname && !f.promocode) {
      return { ok: false, msg: '结账表单没找到（落地 ' + ((co.url || '').replace(location.origin, '') || '?') + '）' };
    }

    const body = Object.assign({}, f);

    delete body.a; delete body.r; delete body.i;
    if (!body.submit) body.submit = 'true';
    delete body.paymentmethod; delete body.accepttos; delete body.applycredit;
    delete body.ccnumber; delete body.ccexpirydate; delete body.cccvv; delete body.ccdescription; delete body.ccinfo;

    body.paymentmethod = m.paymentMethod;
    body.accepttos = 'on';
    body.applycredit = m.useBalance === true ? '1' : '0';

    let coupon = '';
    let src = '';
    if (m.useCoupon === false) {
      src = '本条已关闭优惠码';
    } else if ((m.couponCode || '').trim()) {
      coupon = m.couponCode.trim();
      src = '本条自定义';
    } else if ((DB.settings.defaultCoupon || '').trim()) {
      coupon = DB.settings.defaultCoupon.trim();
      src = '全局默认';
    }
    if (coupon) {
      body.promocode = coupon;
      log('info', '  [结账] 优惠码 ' + coupon + '（' + src + '）');
    } else {
      log('info', '  [结账] 不使用优惠码（' + (src || '未配置默认优惠码') + '）');
    }
    body.token = token;

    log('info', '  [结账] 提交 · 支付=' + m.paymentMethod + ' · 余额抵扣=' + (m.useBalance === true));
    const r = await post('/cart.php?a=checkout', body);
    const hit = (r.url || '').match(/viewinvoice\.php\?id=(\d+)/) || (r.text || '').match(/viewinvoice\.php\?id=(\d+)/);
    if (hit) return { ok: true, invoiceId: hit[1] };

    const errs = [];
    for (const e of r.text.matchAll(/<div[^>]*class="([^"]*)"[^>]*>([\s\S]{0,400}?)<\/div>/gi)) {
      if (!/alert|error|danger/i.test(e[1])) continue;
      if (/\bhidden\b/i.test(e[1])) continue;
      const s = clean(e[2]);
      if (s && s.length > 3 && !/secure environment|安全的使用|已经记录到日志/i.test(s)) errs.push(s);
    }
    for (const e of r.text.matchAll(/<li[^>]*>([^<]{6,160})<\/li>/gi)) {
      const s = clean(e[1]);
      if (/must|required|invalid|错误|必须|不能|无效|介于/i.test(s)) errs.push(s);
    }

    if (!errs.length) {
      const landed = (r.url || '').replace(location.origin, '');
      if (/a=view|a=cart/.test(landed)) errs.push('结账请求被当成购物车操作（落地 ' + landed + '）');
      else if (/a=checkout/.test(landed)) errs.push('结账页被重新渲染，订单未生成');
    }
    const uniq = [];
    for (const e of errs) if (uniq.indexOf(e) < 0) uniq.push(e);
    if (uniq.length) log('error', '  [结账] 服务端拒绝: ' + uniq.slice(0, 3).join(' / '));
    return { ok: false, msg: uniq[0] || '下单未生成发票' };
  }

  const running = {};
  let buying = false;

  async function runOne(m) {
    if (running[m.id] || !m.enabled) return;
    running[m.id] = 1;
    const t0 = Date.now();
    trace = m.name;
    try {
      m.lastCheck = Date.now();
      log('info', '> 检查 ' + m.name + '（pid ' + m.pid + '）');

      let cart = await addToCart(m);

      if (cart && cart.limited && cart.verdict && cart.verdict.kind === 'waf') {
        m.checks += 1;
        m.lastState = 'error';
        m.stateText = '被 Cloudflare 拉黑，无法监控';
        log('error', '  ' + cart.verdict.text);
        if (cart.verdict.ray) log('error', '  Ray ID ' + cart.verdict.ray);
        UI.renderMonitors(); UI.renderStatus();
        if (DB.settings.pushOnError) push('VMISS 监控受阻', m.name + ' 被 Cloudflare 拉黑\nRay ' + (cart.verdict.ray || ''));
        return;
      }

      let attempt = 1;
      while (cart && cart.limited && attempt < 3) {
        m.lastState = 'skip';
        m.stateText = '限速中，等 ' + (attempt * 12) + 's（第 ' + attempt + ' 次）';
        UI.renderMonitors();
        log('warn', '  拿不到页面 HTTP ' + cart.status + '，等 ' + (attempt * 12) + 's 重试');
        await sleep(attempt * 12000);
        lastReqAt = 0;
        attempt += 1;
        cart = await addToCart(m);
      }
      if (!cart || cart.limited) {
        m.checks += 1;
        m.lastState = 'error';
        m.stateText = '连续 3 次拿不到页面';
        log('error', '  放弃本轮 ' + (Date.now() - t0) + 'ms');
        UI.renderMonitors(); UI.renderStatus();
        return;
      }

      m.checks += 1;
      if (!cart.ok) {
        m.lastState = 'out';
        m.stateText = cart.oos ? '缺货' : '未进入配置页';
        log('info', '  ' + m.stateText + ' ' + (Date.now() - t0) + 'ms');
        UI.renderMonitors(); UI.renderStatus();
        return;
      }

      m.lastState = 'stock';
      m.stateText = '有货！';
      log('stock', '有货！已加购 i=' + cart.i + ' ' + (Date.now() - t0) + 'ms');
      UI.renderMonitors();
      if (DB.settings.pushOnRestock) push('VMISS 补货', m.name + ' 有货了，开始下单');

      if (m.maxPrice > 0 && m.price > m.maxPrice) {
        m.lastState = 'skip';
        m.stateText = '价格超上限，跳过';
        log('warn', '  价格 $' + m.price + ' > 上限 $' + m.maxPrice);
        UI.renderMonitors();
        return;
      }

      if (buying) { m.stateText = '有货（另一笔下单中）'; UI.renderMonitors(); return; }

      const li = await checkLogin();
      if (li.ok === false) {
        m.lastState = 'error';
        m.stateText = '未登录，无法下单';
        log('error', '  浏览器未登录 VMISS，结账会走游客流程必然失败');
        UI.renderMonitors(); UI.renderStatus();
        return;
      }

      buying = true;
      const buyStart = Date.now();
      burst = true;
      try {
        let token = (csrfCache.v && Date.now() - csrfCache.at < 600000) ? csrfCache.v : null;
        if (token) log('info', '  [爆发] 用预热令牌');
        else token = await csrf();
        if (!token) { m.lastState = 'error'; m.stateText = '拿不到会话令牌'; return; }

        const cfg = await configure(m, token, cart.i);
        if (!cfg.ok) {
          m.lastState = 'error'; m.stateText = '配置提交失败';
          log('error', '  配置失败: ' + cfg.err);
          UI.renderMonitors();
          return;
        }

        const res = await submitOrder(m, token);
        if (!res.ok) {
          m.fails += 1;
          m.lastBuyMs = Date.now() - buyStart;
          m.lastState = 'error';
          m.stateText = res.msg || '下单未生成发票';
          log('error', '  ' + m.stateText + ' · 爆发 ' + m.lastBuyMs + 'ms');
          UI.renderMonitors();
          if (DB.settings.pushOnError) push('VMISS 下单失败', m.name + '\n' + m.stateText);
          return;
        }

        m.buys += 1;
        m.lastBuyMs = Date.now() - buyStart;
        m.lastState = 'bought';
        m.stateText = '发票 ' + res.invoiceId + ' · ' + m.lastBuyMs + 'ms';
        log('buy', '下单成功 · 发票 ' + res.invoiceId + ' · 爆发 ' + m.lastBuyMs + 'ms · 全程 ' + (Date.now() - t0) + 'ms');
        if (DB.settings.pushOnBuy) {
          push('VMISS 抢购成功', m.name + '\n发票 #' + res.invoiceId + '\n耗时 ' + m.lastBuyMs + 'ms' +
            (m.genPw ? '\nroot 密码: ' + m.genPw : ''));
        }
        if (m.stopAfter) m.enabled = false;
        persist(); UI.renderMonitors(); UI.renderStatus();
      } finally {
        burst = false;
        buying = false;
      }
    } catch (e) {
      m.lastState = 'error';
      m.stateText = String(e.message || e).slice(0, 70);
      log('error', '  异常 ' + String(e.message || e));
      UI.renderMonitors();
    } finally {
      trace = null;
      delete running[m.id];
      persist();
    }
  }

  let timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const now = Date.now();
      const due = DB.monitors.filter((m) => m.enabled && (!m.nextAt || m.nextAt <= now));
      due.sort((a, b) => (a.nextAt || 0) - (b.nextAt || 0));
      for (const m of due.slice(0, Math.max(1, DB.settings.maxConcurrent))) {

        m.nextAt = now + Math.round(m.intervalMs * (0.75 + Math.random() * 0.5));
        void runOne(m);
      }

      const dueQ = (DB.queues || []).filter((q) => q.enabled && !queueRunning[q.id] && (!q.nextAt || q.nextAt <= now));
      if (dueQ.length) {
        dueQ.sort((a, b) => (a.nextAt || 0) - (b.nextAt || 0));
        const q = dueQ[0];
        q.nextAt = now + Math.round((q.intervalMs || 30000) * (0.75 + Math.random() * 0.5));
        persistQueues();
        void runQueue(q);
      }
      schedule();
    }, 900);
  }

  let prewarmTimer = null;
  function startPrewarm() {
    if (prewarmTimer) return;
    const tick = async () => {
      if (!DB.settings.prewarmCsrf) return;
      if (!DB.monitors.some((m) => m.enabled)) return;
      if (csrfCache.v && Date.now() - csrfCache.at < 300000) return;
      if (Object.keys(running).length) return;
      try { await csrf(true); } catch (e) { /* 下次再试 */ }
    };
    prewarmTimer = setInterval(() => void tick(), 60000);
    setTimeout(() => void tick(), 5000);
  }

  const UI = { ready: false, tab: 'monitors', q: '', catFilter: '', onlyStock: false, loading: false };
  let root = null;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const yuan = (n) => '$' + Number(n || 0).toFixed(2);
  const ago = (t) => {
    if (!t) return '从未';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return s + '秒前';
    if (s < 3600) return Math.round(s / 60) + '分前';
    if (s < 86400) return Math.round(s / 3600) + '小时前';
    return Math.round(s / 86400) + '天前';
  };

  const CSS = [
    '#vp{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:480px;max-height:88vh;display:flex;flex-direction:column;',
    'font:12.5px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:#f2f2f4;background:#131316;border:1px solid #2c2c34;',
    'border-radius:12px;box-shadow:0 20px 56px rgba(0,0,0,.6);overflow:hidden}',
    '#vp *{box-sizing:border-box}',
    '#vp .hd{display:flex;align-items:center;gap:9px;padding:11px 13px;background:#0d0d10;cursor:move;user-select:none}',
    '#vp .hd .dot{width:8px;height:8px;border-radius:50%;background:#55555f;flex:0 0 auto}',
    '#vp .hd .dot.on{background:#2dd4bf;box-shadow:0 0 8px #2dd4bf}',
    '#vp .hd .dot.busy{background:#fbbf24;box-shadow:0 0 8px #fbbf24}',
    '#vp .hd .ttl{flex:1;font-weight:600;font-size:13px}',
    '#vp .hd .cnt{font-size:11px;color:#9a9aa5;font-variant-numeric:tabular-nums}',
    '#vp .hd button{background:none;border:0;color:#9a9aa5;cursor:pointer;font-size:15px;padding:2px 7px;line-height:1}',
    '#vp .tabs{display:flex;background:#0d0d10;padding:0 8px;border-top:1px solid #1c1c22}',
    '#vp .tabs button{flex:1;background:none;border:0;border-bottom:2px solid transparent;color:#8a8a95;padding:9px 4px;font-size:12px;cursor:pointer;font-family:inherit}',
    '#vp .tabs button.on{color:#2dd4bf;border-bottom-color:#2dd4bf}',
    '#vp .bd{flex:1;overflow-y:auto;padding:12px 13px;min-height:200px}',
    '#vp .ft{padding:8px 13px;border-top:1px solid #26262c;font-size:11px;color:#7d7d88;display:flex;gap:10px;align-items:center}',
    '#vp button.b{background:#232329;border:1px solid #2f2f37;border-radius:6px;color:#d4d4da;padding:5px 10px;font-size:11.5px;cursor:pointer;font-family:inherit;white-space:nowrap}',
    '#vp button.b:hover{background:#2c2c34;color:#fff}',
    '#vp button.b.g{background:#0f766e;border-color:#0f766e;color:#fff}',
    '#vp button.b.d{color:#f87171}',
    '#vp button.b.sm{padding:3px 8px;font-size:11px}',
    '#vp button.b:disabled{opacity:.45;cursor:default}',
    '#vp input,#vp select,#vp textarea{background:#0d0d10;border:1px solid #2c2c34;border-radius:6px;color:#f2f2f4;padding:7px 9px;font:12px/1.5 inherit;width:100%;font-family:inherit}',
    '#vp input:focus,#vp select:focus,#vp textarea:focus{outline:none;border-color:#0f766e}',
    '#vp label.f{display:block;margin-bottom:9px}',
    '#vp label.f span{display:block;font-size:11px;color:#7d7d88;margin-bottom:4px}',
    '#vp .g2{display:grid;grid-template-columns:1fr 1fr;gap:9px}',
    '#vp .toolbar{display:flex;gap:7px;margin-bottom:10px;align-items:center}',
    '#vp .toolbar input{flex:1}',
    '#vp .filters{display:flex;gap:7px;margin-bottom:10px;align-items:center}',
    '#vp .filters select{flex:1;min-width:0}',
    '#vp .chk{display:flex;align-items:center;gap:5px;font-size:11.5px;color:#9a9aa5;white-space:nowrap;cursor:pointer}',
    '#vp .chk input{width:auto;margin:0}',
    '#vp .stat{font-size:11px;color:#7d7d88;margin-bottom:9px;display:flex;align-items:center;gap:8px;font-variant-numeric:tabular-nums}',
    '#vp .row2{display:flex;align-items:center;gap:9px;padding:8px 10px;border:1px solid #23232a;border-radius:8px;margin-bottom:5px;background:#181820}',
    '#vp .row2 .dot{width:7px;height:7px;border-radius:50%;background:#4a4a54;flex:0 0 auto}',
    '#vp .row2 .dot.on{background:#34d399}',
    '#vp .row2 .info{flex:1;min-width:0}',
    '#vp .row2 .nm{font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}',
    '#vp .row2 .meta{font-size:10.5px;color:#6f6f7a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;margin-top:1px}',
    '#vp .row2 .right{text-align:right;flex:0 0 auto}',
    '#vp .row2 .pr{font-size:13px;font-variant-numeric:tabular-nums;color:#d4d4da;font-weight:500;display:block}',
    '#vp .row2 .stk{font-size:10.5px;color:#6f6f7a;display:block;margin-top:1px}',
    '#vp .row2 .stk.hot{color:#34d399;font-weight:600}',
    '#vp .m{border:1px solid #2a2a31;border-radius:10px;padding:10px 11px;margin-bottom:9px;background:#181820}',
    '#vp .m .r1{display:flex;align-items:baseline;gap:8px}',
    '#vp .m .nm{flex:1;font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#vp .m .pr{font-variant-numeric:tabular-nums;color:#d4d4da;font-size:12.5px}',
    '#vp .m .r2{display:flex;gap:10px;margin-top:5px;font-size:11px;color:#7d7d88;font-variant-numeric:tabular-nums;flex-wrap:wrap}',
    '#vp .st{margin-top:7px;font-size:11.5px;padding:4px 8px;border-radius:6px;display:block;background:#26262c;color:#9a9aa5}',
    '#vp .st.stock{background:rgba(45,212,191,.15);color:#2dd4bf}',
    '#vp .st.bought{background:rgba(52,211,153,.16);color:#34d399}',
    '#vp .st.error{background:rgba(248,113,113,.14);color:#f87171}',
    '#vp .st.skip{background:rgba(251,191,36,.14);color:#fbbf24}',
    '#vp .r3{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap}',
    '#vp .act{display:flex;gap:7px;margin-bottom:11px;flex-wrap:wrap;align-items:center}',
    '#vp .lg div{font:11px/1.7 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word;color:#9a9aa5;padding:1px 0}',
    '#vp .lg .t{color:#5a5a64;margin-right:7px}',
    '#vp .lg .error{color:#f87171}',
    '#vp .lg .buy{color:#34d399;font-weight:600}',
    '#vp .lg .stock{color:#2dd4bf}',
    '#vp .lg .warn{color:#fbbf24}',
    '#vp .hint{font-size:11px;color:#6f6f7a;line-height:1.65}',
    '#vp .empty{text-align:center;color:#6f6f7a;padding:30px 12px;font-size:12px;line-height:1.8}',
    '#vp .warnbox{background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);border-radius:7px;padding:9px 11px;font-size:11px;color:#fbbf24;line-height:1.65;margin-bottom:10px}',
    '#vp .optbox{border:1px solid #2a2a31;border-radius:8px;padding:9px 10px;margin-bottom:9px;background:#141419}',
    '#vp .optbox .oh{font-size:11.5px;font-weight:600;color:#2dd4bf;margin-bottom:7px}',
    '#vp .dlg{position:absolute;inset:0;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;padding:16px;z-index:10}',
    '#vp .dlg .c{background:#181820;border:1px solid #33333c;border-radius:11px;padding:15px;width:100%;max-height:100%;overflow-y:auto}',
    '#vp .dlg h4{margin:0 0 12px;font-size:13.5px}',
    '#vp .dlg .row{display:flex;gap:7px;margin-top:13px}',
    '#vp .dlg .row button{flex:1;background:#232329;border:1px solid #2f2f37;border-radius:7px;color:#d4d4da;padding:9px;font-size:12px;cursor:pointer;font-family:inherit}',
    '#vp .dlg .row button.g{background:#0f766e;border-color:#0f766e;color:#fff}',
    '#vp .dlg ol{margin:0;padding-left:18px;font-size:12px;line-height:1.9;color:#c9c9d1}',
    '#vp .dlg ol b{color:#2dd4bf}',
  ].join('');

  function shell() {
    const el = document.createElement('div');
    el.id = 'vp';
    el.innerHTML =
      '<style>' + CSS + '</style>' +
      '<div class="hd"><span class="dot" id="vp-dot"></span><span class="ttl">VMISS 抢购助手</span>' +
      '<span class="cnt" id="vp-cnt"></span><button id="vp-min">-</button></div>' +
      '<div class="tabs" id="vp-tabs">' +
      '<button data-tab="monitors" class="on">监控</button>' +
      '<button data-tab="queue">排队抢购</button>' +
      '<button data-tab="browse">选商品</button>' +
      '<button data-tab="logs">日志</button>' +
      '<button data-tab="settings">设置</button></div>' +
      '<div class="bd" id="vp-bd"></div>' +
      '<div class="ft" id="vp-ft"></div>';
    document.body.appendChild(el);

    el.querySelector('#vp-min').onclick = () => {
      const hide = el.querySelector('#vp-bd').style.display !== 'none';
      el.querySelector('#vp-bd').style.display = hide ? 'none' : '';
      el.querySelector('#vp-tabs').style.display = hide ? 'none' : '';
      el.querySelector('#vp-ft').style.display = hide ? 'none' : '';
      el.style.maxHeight = hide ? 'none' : '88vh';
    };
    el.querySelector('#vp-tabs').onclick = (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      UI.tab = t.dataset.tab;
      UI.syncTabs();
      UI.render();
    };
    (function drag() {
      const h = el.querySelector('.hd');
      let sx = 0, sy = 0, ox = 0, oy = 0, on = false;
      h.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        on = true; sx = e.clientX; sy = e.clientY;
        const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
        el.style.right = 'auto'; el.style.bottom = 'auto';
        el.style.left = ox + 'px'; el.style.top = oy + 'px';
        e.preventDefault();
      });
      window.addEventListener('mousemove', (e) => {
        if (!on) return;
        el.style.left = Math.max(0, Math.min(window.innerWidth - 80, ox + e.clientX - sx)) + 'px';
        el.style.top = Math.max(0, Math.min(window.innerHeight - 50, oy + e.clientY - sy)) + 'px';
      });
      window.addEventListener('mouseup', () => { on = false; });
    })();
    return el;
  }

  UI.syncTabs = function () {
    for (const b of root.querySelectorAll('#vp-tabs button')) b.classList.toggle('on', b.dataset.tab === UI.tab);
  };

  UI.render = function () {
    if (!root) return;
    if (UI.tab === 'monitors') UI.renderMonitors();
    else if (UI.tab === 'queue') UI.renderQueue();
    else if (UI.tab === 'browse') UI.renderBrowse();
    else if (UI.tab === 'logs') UI.renderLogs();
    else UI.renderSettings();
  };

  UI.renderStatus = function () {
    if (!root) return;
    const on = DB.monitors.filter((m) => m.enabled).length;
    const busy = Object.keys(running).length > 0;
    root.querySelector('#vp-dot').className = 'dot' + (busy ? ' busy' : on > 0 ? ' on' : '');
    root.querySelector('#vp-cnt').textContent = on + ' 监控 · 检查 ' + DB.monitors.reduce((s, m) => s + (m.checks || 0), 0) + ' · 成交 ' + DB.monitors.reduce((s, m) => s + (m.buys || 0), 0);
    const qn = (DB.queues || []).length;
    const pushOn = (DB.settings.tgToken && DB.settings.tgChat) || DB.settings.dingWebhook;
    root.querySelector('#vp-ft').innerHTML = '<span>' + (on ? '● 运行中' : '○ 已暂停') + '</span>' +
      '<span>目录 ' + (DB.catalog.products.length || 0) + '</span>' +
      '<span>' + (pushOn ? '推送已开' : '推送未配') + '</span>' +
      '<span style="margin-left:auto;color:#5a5a64">v' + LATEST + '</span>';
  };

  UI.renderMonitors = function () {
    if (!root || UI.tab !== 'monitors') return;
    const bd = root.querySelector('#vp-bd');
    let h = '<div class="act"><button class="b g" id="vp-add">+ 添加监控</button>' +
      '<button class="b" id="vp-gobrowse">去选商品</button>' +
      (DB.monitors.length ? '<button class="b" id="vp-allon">全部启用</button><button class="b" id="vp-alloff">全部暂停</button>' : '') + '</div>';
    if (!DB.monitors.length) {
      h += '<div class="empty">还没有监控项<br><span style="color:#5a5a64">去「选商品」挑一个，或点「+ 添加监控」</span></div>';
    } else {
      for (const m of DB.monitors) {
        const busy = !!running[m.id];
        const cls = ['stock', 'bought', 'error', 'skip'].indexOf(m.lastState) >= 0 ? m.lastState : '';
        const pay = m.paymentMethod === 'balance' ? '余额' : m.paymentMethod === 'motionpayalipay' ? '支付宝' : m.paymentMethod === 'cryptomusgateway' ? '加密货币' : '信用卡';
        const optN = Object.keys(m.options || {}).filter((k) => m.options[k] !== '').length;
        h += '<div class="m"><div class="r1"><span class="nm" title="' + esc(m.name) + '">' + esc(m.name) + '</span><span class="pr">' + yuan(m.price) + '</span></div>' +
          '<div class="r2"><span>pid ' + m.pid + '</span><span>' + (m.intervalMs / 1000) + 's</span><span>' + pay + '</span>' +
          (function () {
            if (m.useCoupon === false) return '';
            const c = (m.couponCode || '').trim() || (DB.settings.defaultCoupon || '').trim();
            return c ? '<span style="color:#fbbf24">' + esc(c) + ((m.couponCode || '').trim() ? '' : ' 默认') + '</span>' : '<span style="color:#6f6f7a">无码</span>';
          })() +
          (optN ? '<span style="color:#2dd4bf">配置 ' + optN + ' 项</span>' : '') +
          '<span>检查 ' + (m.checks || 0) + '</span><span>成交 ' + (m.buys || 0) + '</span>' +
          (m.lastBuyMs ? '<span style="color:#34d399">' + m.lastBuyMs + 'ms</span>' : '') +
          '<span>' + ago(m.lastCheck) + '</span></div>' +
          '<div class="st ' + cls + '">' + (busy ? '[跑] ' : '') + esc(m.stateText || (m.enabled ? '等待首次检查' : '已暂停')) + '</div>' +
          (m.genPw ? '<div class="st" style="background:rgba(45,212,191,.12);color:#2dd4bf;cursor:pointer" data-a="copy" data-id="' + m.id + '" title="点一下复制">root 密码 ' + esc(m.genPw) + '（点击复制）</div>' : '') +
          '<div class="r3">' +
          '<button class="b sm' + (m.enabled ? '' : ' g') + '" data-a="toggle" data-id="' + m.id + '">' + (m.enabled ? '暂停' : '启用') + '</button>' +
          '<button class="b sm" data-a="once" data-id="' + m.id + '">立即检查</button>' +
          '<button class="b sm" data-a="edit" data-id="' + m.id + '">配置</button>' +
          '<button class="b sm d" data-a="del" data-id="' + m.id + '">删除</button></div></div>';
      }
    }
    bd.innerHTML = h;
    bind(bd);
  };

  UI.renderBrowse = function () {
    if (!root || UI.tab !== 'browse') return;
    const bd = root.querySelector('#vp-bd');
    const cats = DB.catalog.cats || [];
    const cur = UI.catFilter || (cats[0] ? cats[0].slug : '');
    const items = (DB.catalog.products || []).filter((p) => p.categorySlug === cur);

    let h = '<div class="filters">';
    if (cats.length) {
      h += '<select id="vp-catf">' + cats.map((c) => '<option value="' + esc(c.slug) + '"' + (cur === c.slug ? ' selected' : '') + '>' +
        esc(c.name) + (c.live === false ? '　🚫已隐藏' : '') + '</option>').join('') + '</select>';
    } else {
      h += '<input id="vp-catslug" placeholder="分类 slug">';
    }
    h += '<button class="b g" id="vp-load">' + (UI.loading ? '加载中' : '加载') + '</button>' +
      '<button class="b" id="vp-recats" title="重新读取官网分类导航，用于官网新增/改名分类后同步">刷新分类</button></div>';
    {
      const cc = cats.filter((c) => c.slug === cur)[0];
      const hiddenCount = cats.filter((c) => c.live === false).length;
      if (cc && cc.live === false) {
        h += '<div style="margin:7px 0;padding:7px 10px;border-radius:5px;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.25);color:#fbbf24;font-size:11.5px;line-height:1.6">' +
          '⚠ 这个分类官网现在看不到了（可能被隐藏或删除）。插件按「只加不删」保留它，你的监控和商品缓存都还在。<br>' +
          '点「加载」试一下：<b>能拉到商品</b> = 只是隐藏；<b>报 HTTP 404</b> = 已删除。</div>';
      } else if (hiddenCount) {
        h += '<div class="hint" style="margin:5px 0">清单里有 ' + hiddenCount + ' 个分类官网已看不到（下拉框里带 🚫 标记），保留是为了不丢数据。</div>';
      }
    }

    if (items.length) {
      h += '<div class="toolbar"><input id="vp-q" placeholder="在本分类里搜索" value="' + esc(UI.q) + '">' +
        '<label class="chk"><input type="checkbox" id="vp-stock"' + (UI.onlyStock ? ' checked' : '') + '>只看有货</label></div>';
    }
    if (!cats.length && !items.length) {
      h += '<div class="empty">还没有分类列表<br><span style="color:#5a5a64">点「加载」读取分类导航，再拉当前分类的商品</span></div>';
      bd.innerHTML = h; bind(bd); return;
    }
    if (!items.length) {
      h += '<div class="empty">这个分类还没加载过<br><span style="color:#5a5a64">点「加载」拉取</span></div>';
      bd.innerHTML = h; bind(bd); return;
    }

    const q = UI.q.trim().toLowerCase();
    let rows = items;
    if (UI.onlyStock) rows = rows.filter((p) => p.inStock);
    if (q) rows = rows.filter((p) => p.name.toLowerCase().indexOf(q) >= 0 || String(p.pid) === q);

    h += '<div class="stat">' + rows.length + ' 个 · <span style="color:#34d399">' + rows.filter((p) => p.inStock).length + ' 有货</span>' +
      '<span style="margin-left:auto;color:#5a5a64">' + ago(DB.catalog.at) + '更新</span></div>';
    if (!rows.length) h += '<div class="empty">没有匹配的商品</div>';
    for (const p of rows) {
      const mon = DB.monitors.filter((x) => x.pid === p.pid).length > 0;
      h += '<div class="row2"><span class="dot' + (p.inStock ? ' on' : '') + '"></span>' +
        '<span class="info"><span class="nm" title="' + esc(p.name) + '">' + esc(p.name) + '</span>' +
        '<span class="meta">pid ' + p.pid + (p.specs ? ' · ' + esc(p.specs) : '') + '</span></span>' +
        '<span class="right"><span class="pr">' + yuan(p.price) + '</span>' +
        '<span class="stk' + (p.inStock ? ' hot' : '') + '">' + (p.inStock ? (p.stock && p.stock !== '-' ? esc(p.stock) : '有货') : '缺货') + '</span></span>' +
        '<span class="add"><button class="b sm ' + (mon ? '' : 'g') + '" data-add="' + p.pid + '"' + (mon ? ' disabled' : '') + '>' + (mon ? '已监控' : '+ 监控') + '</button></span></div>';
    }
    h += '<div class="hint" style="margin-top:14px;padding-top:12px;border-top:1px solid #24242b">要看全部分类？' +
      '<button class="b sm" id="vp-all">全部拉取</button> ' + cats.length + ' 个分类，按当前间隔约 ' +
      Math.ceil(cats.length * ((Number(DB.settings.fetchAllGapMs) || 6000) + 2500) / 60000) + ' 分钟' +
      (Number(DB.settings.fetchAllGapMs) > 6000 ? '（已按限速自动放慢到 ' + (DB.settings.fetchAllGapMs / 1000).toFixed(1) + 's）' : '') +
      '，撞限速会自动放慢并记住</div>';
    bd.innerHTML = h;
    bind(bd);
  };

  UI.renderLogs = function () {
    if (!root || UI.tab !== 'logs') return;
    const bd = root.querySelector('#vp-bd');
    bd.innerHTML = '<div class="act"><button class="b sm" id="vp-clearlog">清空</button>' +
      '<span class="hint" style="margin-left:auto">共 ' + DB.logs.length + ' 条</span></div>' +
      '<div class="lg">' + (DB.logs.length ? DB.logs.slice(0, 300).map((l) => '<div class="' + l.level + '"><span class="t">' + l.t + '</span>' + esc(l.text) + '</div>').join('') : '<div class="empty">暂无日志</div>') + '</div>';
    bind(bd);
  };

  UI.renderSettings = function () {
    if (!root || UI.tab !== 'settings') return;
    const s = DB.settings;
    const bd = root.querySelector('#vp-bd');
    bd.innerHTML =
      '<label class="f"><span>默认检查间隔（秒）</span><input id="s1" type="number" min="5" value="' + (s.defaultIntervalMs / 1000) + '"></label>' +
      '<label class="f"><span>监控请求间隔（秒，别低于 1.5）</span><input id="s2" type="number" min="1.5" step="0.1" value="' + (s.minGapMs / 1000) + '"></label>' +
      '<label class="f"><span>抢购爆发间隔（毫秒，越小越快越易限速）</span><input id="s5" type="number" min="0" max="2000" step="50" value="' + s.burstGapMs + '"></label>' +
      '<label class="f"><span>默认优惠码</span><input id="s7" placeholder="10%OFF" value="' + esc(s.defaultCoupon) + '">' +
      '<div class="hint" style="margin-top:5px">默认使用优惠码 <b style="color:#fbbf24">10%OFF</b>（全场通用）。新加的监控会自动填上，留空即不使用。</div></label>' +
      '<label class="f"><span>同时处理几笔下单</span><input id="s3" type="number" min="1" max="5" value="' + s.maxConcurrent + '"></label>' +
      '<label class="f"><span>后台预热令牌</span><select id="s6"><option value="1"' + (s.prewarmCsrf ? ' selected' : '') + '>开</option><option value="0"' + (s.prewarmCsrf ? '' : ' selected') + '>关</option></select></label>' +
      '<div style="margin:14px 0 8px;font-size:11.5px;color:#2dd4bf;font-weight:600">推送</div>' +
      '<label class="f"><span>Telegram Bot Token</span><input id="p1" placeholder="123456:ABC-DEF..." value="' + esc(s.tgToken) + '"></label>' +
      '<label class="f"><span>Telegram Chat ID</span><input id="p2" placeholder="你的 user id 或 -100... 群 id" value="' + esc(s.tgChat) + '"></label>' +
      '<label class="f"><span>钉钉机器人 Webhook</span><input id="p3" placeholder="https://oapi.dingtalk.com/robot/send?access_token=xxxx" value="' + esc(s.dingWebhook) + '">' +
      '<div class="hint" style="margin-top:5px">直接粘贴钉钉给的<b style="color:#fbbf24">整段 Webhook 地址</b>（含 https:// 和 access_token=）。只填 token 串也认。</div></label>' +
      '<label class="f"><span>钉钉加签密钥 SEC（用加签模式才填）</span><input id="p4" value="' + esc(s.dingSecret) + '"></label>' +
      '<div class="hint" style="margin-bottom:8px">钉钉机器人若用「加签」才填 SEC；用「自定义关键词」则在关键词里加上 <b style="color:#fbbf24">VMISS</b>。</div>' +
      '<div class="act"><button class="b" id="p5">测试推送</button>' +
      '<label class="chk"><input type="checkbox" id="p6"' + (s.pushOnRestock ? ' checked' : '') + '>补货时推</label>' +
      '<label class="chk"><input type="checkbox" id="p7"' + (s.pushOnBuy ? ' checked' : '') + '>成功时推</label>' +
      '<label class="chk"><input type="checkbox" id="p8"' + (s.pushOnError ? ' checked' : '') + '>失败时推</label></div>' +
      '<div class="act"><button class="b g" id="vp-save">保存设置</button><button class="b" id="vp-export">导出配置</button>' +
      '<button class="b" id="vp-import">导入配置</button><button class="b d" id="vp-clear">清空目录缓存</button>' +
      '<button class="b" id="vp-intro">使用说明</button></div>' +
      '<div class="hint">数据全部存在浏览器本地，关页面不丢。</div>';
    bind(bd);
  };

  function bind(bd) {
    bd.onclick = function (e) {
      const t = e.target.closest('button');
      if (!t) return;
      const id = Number(t.dataset.id || 0);
      const m = DB.monitors.filter((x) => x.id === id)[0];

      if (t.id === 'q-add') return openQueueEditor(null);
      if (t.id === 'q-allon') { DB.queues.forEach((x) => { x.enabled = true; x.nextAt = 0; }); persistQueues(); UI.renderQueue(); return; }
      if (t.id === 'q-alloff') { DB.queues.forEach((x) => { x.enabled = false; }); persistQueues(); UI.renderQueue(); return; }
      if (t.dataset.qa) {
        const qq = (DB.queues || []).filter((x) => x.id === Number(t.dataset.qid))[0];
        if (!qq) return;
        if (t.dataset.qa === 'toggle') { qq.enabled = !qq.enabled; qq.nextAt = 0; persistQueues(); UI.renderQueue(); return; }
        if (t.dataset.qa === 'once') { log('info', '---- 手动排队检查 ----'); void runQueue(qq); return; }
        if (t.dataset.qa === 'edit') return openQueueEditor(qq);
        if (t.dataset.qa === 'del') { DB.queues = DB.queues.filter((x) => x.id !== qq.id); persistQueues(); UI.renderQueue(); return; }
        if (t.dataset.qa === 'copy') { navigator.clipboard.writeText(qq.genPw || '').catch(() => undefined); return; }
        return;
      }

      if (t.id === 'vp-add') return openEditor(null, null);
      if (t.id === 'vp-gobrowse') { UI.tab = 'browse'; UI.syncTabs(); UI.render(); return; }
      if (t.id === 'vp-allon') { DB.monitors.forEach((x) => { x.enabled = true; x.nextAt = 0; }); persist(); UI.renderMonitors(); UI.renderStatus(); return; }
      if (t.id === 'vp-alloff') { DB.monitors.forEach((x) => { x.enabled = false; }); persist(); UI.renderMonitors(); UI.renderStatus(); return; }
      if (t.id === 'vp-clearlog') { DB.logs.length = 0; UI.renderLogs(); return; }
      if (t.id === 'vp-clear') {
      DB.catalog = { at: 0, catsAt: 0, cats: [], products: [] };
      save('catalog', DB.catalog);
      DB.optCache = {}; save('optCache', {});
      UI.catFilter = '';
      log('info', '目录缓存与分类导航已清空，下次「加载」会重新读官网');
      UI.renderBrowse(); return;
    }
      if (t.id === 'vp-intro') return showIntro(true);
      if (t.id === 'p5') { push('VMISS 推送测试', '收到这条说明推送配置成功 ' + new Date().toLocaleString('zh-CN')); log('info', '已发送测试推送'); return; }
      if (t.id === 'vp-load') {
        const sel = bd.querySelector('#vp-catf');
        const man = bd.querySelector('#vp-catslug');
        void loadCategory((sel && sel.value) || (man && man.value.trim()) || UI.catFilter, t);
        return;
      }
      if (t.id === 'vp-recats') { void loadCategory(UI.catFilter, null, true); return; }
      if (t.id === 'vp-all') { void runFetchAll(); return; }

      if (t.dataset.a === 'copy' && m) {
        navigator.clipboard.writeText(m.genPw || '').then(() => log('info', '已复制 root 密码')).catch(() => log('warn', '复制失败，请手动选中'));
        return;
      }
      if (t.dataset.a === 'toggle' && m) { m.enabled = !m.enabled; m.nextAt = 0; persist(); UI.renderMonitors(); UI.renderStatus(); return; }
      if (t.dataset.a === 'once' && m) { log('info', '---- 手动触发 ----'); void runOne(m); return; }
      if (t.dataset.a === 'del' && m) { DB.monitors = DB.monitors.filter((x) => x.id !== m.id); persist(); UI.renderMonitors(); UI.renderStatus(); return; }
      if (t.dataset.a === 'edit' && m) return openEditor(m, null);

      if (t.dataset.add) {
        const p = DB.catalog.products.filter((x) => x.pid === Number(t.dataset.add))[0];
        if (!p) return;
        if (DB.monitors.filter((x) => x.pid === p.pid).length) { log('warn', p.name + ' 已在监控列表'); return; }
        return openEditor(null, p);
      }

      if (t.id === 'vp-save') {
        const g = (n) => bd.querySelector('#' + n);
        DB.settings.defaultIntervalMs = Math.max(5000, Number(g('s1').value) * 1000 || 30000);
        DB.settings.minGapMs = Math.max(1500, Number(g('s2').value) * 1000 || 1700);
        DB.settings.burstGapMs = Math.min(2000, Math.max(0, Number(g('s5').value)));
        DB.settings.defaultCoupon = g('s7').value.trim();
        DB.settings.maxConcurrent = Math.min(5, Math.max(1, Number(g('s3').value) || 1));
        DB.settings.prewarmCsrf = g('s6').value === '1';
        DB.settings.tgToken = g('p1').value.trim();
        DB.settings.tgChat = g('p2').value.trim();
        DB.settings.dingWebhook = g('p3').value.trim();
        DB.settings.dingSecret = g('p4').value.trim();
        DB.settings.pushOnRestock = g('p6').checked;
        DB.settings.pushOnBuy = g('p7').checked;
        DB.settings.pushOnError = g('p8').checked;
        save('settings', DB.settings);
        log('info', '设置已保存');
        UI.renderStatus();
        return;
      }
      if (t.id === 'vp-export') return exportCfg();
      if (t.id === 'vp-import') return importCfg();
    };

    bd.oninput = function (e) {
      if (e.target.id !== 'vp-q') return;
      UI.q = e.target.value;
      UI.renderBrowse();
      const el = root.querySelector('#vp-q');
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    };
    bd.onchange = function (e) {
      if (e.target.id === 'vp-catf') { UI.catFilter = e.target.value; UI.q = ''; UI.renderBrowse(); void loadCategory(e.target.value, null); }
      if (e.target.id === 'vp-stock') { UI.onlyStock = e.target.checked; UI.renderBrowse(); }
    };
  }

  const CATS_TTL = 24 * 60 * 60 * 1000;

  async function loadCategory(slug, btn, force) {
    UI.loading = true;
    if (btn) btn.textContent = '加载中';
    try {
      const catsStale = !DB.catalog.catsAt || (Date.now() - DB.catalog.catsAt > CATS_TTL);
      if (!DB.catalog.cats.length || force || catsStale) {
        log('info', force ? '[目录] 手动刷新分类导航' : (catsStale ? '[目录] 分类导航已过期，重读' : '[目录] 读分类导航'));
        let fresh = null;
        for (let a = 1; a <= 3 && !fresh; a += 1) {
          const got = await fetchCategories(true);
          if (got && got.limited) { log('warn', '  限速，等 ' + (a * 12) + 's'); await sleep(a * 12000); lastReqAt = 0; continue; }
          fresh = got;
        }
        if (fresh && fresh.length) {
          const oldCats = DB.catalog.cats || [];

          const prevLive = oldCats.filter((c) => c.live !== false).length;
          if (prevLive >= 4 && fresh.length < prevLive * 0.5) {
            log('error', '  ⚠ 本次只解析到 ' + fresh.length + ' 个分类（上次 ' + prevLive + ' 个），疑似响应异常');
            log('error', '    已放弃本次合并，清单一律不动。稍后可在「刷新分类」重试');
            return;
          }
          const liveSlugs = {};
          for (const c of fresh) liveSlugs[c.slug] = 1;
          const wasMarkedGone = {};
          for (const c of oldCats) if (c.live === false) wasMarkedGone[c.slug] = 1;

          const merged = [];
          const seen = {};
          for (const c of fresh) { merged.push({ slug: c.slug, name: c.name, live: true }); seen[c.slug] = 1; }
          const goneCats = [];
          for (const c of oldCats) {
            if (seen[c.slug] || liveSlugs[c.slug]) continue;
            seen[c.slug] = 1;
            goneCats.push(c);
            merged.push({ slug: c.slug, name: c.name, live: false, goneAt: c.goneAt || Date.now() });
          }

          const addedCats = fresh.filter((c) => !oldCats.some((o) => o.slug === c.slug)).map((c) => c.name);
          const revived = fresh.filter((c) => wasMarkedGone[c.slug]).map((c) => c.name);

          DB.catalog = { at: DB.catalog.at, catsAt: Date.now(), cats: merged, products: DB.catalog.products };
          save('catalog', DB.catalog);

          log('info', '  官网在售 ' + fresh.length + ' 个 · 清单共 ' + merged.length + ' 个（只加不删）');
          if (addedCats.length) log('warn', '  🆕 官网新增：' + addedCats.join('、'));
          if (goneCats.length) log('warn', '  🚫 官网现在看不到（已保留并标记）：' + goneCats.map((c) => c.name).join('、'));
          if (revived.length) log('warn', '  ✅ 官网恢复显示：' + revived.join('、'));
          if (!addedCats.length && !goneCats.length && !revived.length) log('info', '  分类无变化');
        }
      }
      const cats = DB.catalog.cats || [];
      const target = slug || UI.catFilter || (cats[0] ? cats[0].slug : '');
      if (!target) { log('error', '拿不到分类，请手动填 slug'); return; }
      UI.catFilter = target;

      const cached = (DB.catalog.products || []).filter((p) => p.categorySlug === target);
      if (cached.length) { log('info', '[目录] ' + target + ' 命中缓存 ' + cached.length + ' 个'); UI.renderBrowse(); return; }

      log('info', '[目录] 拉取 ' + target);
      let list = null;
      const catName = (cats.filter((c) => c.slug === target)[0] || {}).name;
      for (let a = 1; a <= 3; a += 1) {
        const got = await fetchProducts(target, catName, true);
        if (got && got.limited) { log('warn', '  限速，等 ' + (a * 12) + 's'); await sleep(a * 12000); lastReqAt = 0; continue; }
        if (got && got.length === 0 && a < 3) { await sleep(2000); continue; }
        list = got;
        break;
      }
      if (!list) { log('error', '  连续被限速，稍后再试'); return; }
      const keep = (DB.catalog.products || []).filter((p) => p.categorySlug !== target);
      DB.catalog = { at: Date.now(), catsAt: DB.catalog.catsAt, cats: DB.catalog.cats, products: keep.concat(list).sort((x, y) => x.pid - y.pid) };
      save('catalog', DB.catalog);
      log('info', '  ' + target + ' 完成 ' + list.length + ' 个 · ' + list.filter((p) => p.inStock).length + ' 有货');
    } finally {
      UI.loading = false;
      UI.renderBrowse();
      UI.renderStatus();
    }
  }

  const GAP_MIN = 6000;
  const GAP_MAX = 30000;

  async function runFetchAll() {
    log('warn', '[批量] 拉取全部分类');
    const allCats = DB.catalog.cats || [];
    if (!allCats.length) { log('error', '还没有分类列表'); return; }

    const cats = allCats.slice().sort((a, b) => (a.live === false ? 1 : 0) - (b.live === false ? 1 : 0));
    const hiddenN = allCats.filter((c) => c.live === false).length;
    if (hiddenN) log('info', '[批量] 含 ' + hiddenN + ' 个官网已隐藏的分类，排在最后拉');

    let gap = Math.max(GAP_MIN, Number(DB.settings.fetchAllGapMs) || GAP_MIN);
    const learned = Number(DB.settings.fetchAllGapMs) || GAP_MIN;
    if (learned > GAP_MIN) log('info', '[批量] 沿用上次学到的间隔 ' + (gap / 1000).toFixed(1) + 's，共 ' + cats.length + ' 个分类，预计 ' + Math.ceil(cats.length * (gap + 2500) / 60000) + ' 分钟');

    let hitLimit = 0, okCount = 0, skipCount = 0;
    const skipped = [];

    for (let i = 0; i < cats.length; i += 1) {
      const c = cats[i];
      let got = null;
      for (let a = 1; a <= 3; a += 1) {
        got = await fetchProducts(c.slug, c.name, true);
        if (!got || !got.limited) break;
        hitLimit += 1;
        gap = Math.min(GAP_MAX, Math.round(gap * 1.6));
        DB.settings.fetchAllGapMs = gap;
        save('settings', DB.settings);
        const wait = Math.min(12000, 2000 * a);
        log('warn', '  限速 → 间隔提到 ' + (gap / 1000).toFixed(1) + 's（已记住），等 ' + (wait / 1000) + 's 重试 ' + a + '/3');
        await sleep(wait);
        lastReqAt = 0;
      }
      if (got && got.limited) {
        skipCount += 1;
        skipped.push(c.name);
        log('warn', '  ' + (i + 1) + '/' + cats.length + ' ' + c.name + ' → 跳过（连续限速）');
      } else if (got && got.length) {
        okCount += 1;
        const keep = (DB.catalog.products || []).filter((p) => p.categorySlug !== c.slug);
        DB.catalog = { at: Date.now(), catsAt: DB.catalog.catsAt, cats: DB.catalog.cats, products: keep.concat(got).sort((x, y) => x.pid - y.pid) };
        save('catalog', DB.catalog);
        log('info', '[批量] ' + (i + 1) + '/' + cats.length + ' ' + c.name + ' · ' + got.length + ' 个 · 下次间隔 ' + (gap / 1000).toFixed(1) + 's');
      } else {
        log('info', '[批量] ' + (i + 1) + '/' + cats.length + ' ' + c.name + ' · 空');
      }
      await sleep(gap);
    }

    if (hitLimit === 0 && gap > GAP_MIN) {
      const next = Math.max(GAP_MIN, Math.round(gap * 0.8));
      DB.settings.fetchAllGapMs = next;
      save('settings', DB.settings);
      log('info', '[批量] 全程没被限速，下次间隔缩到 ' + (next / 1000).toFixed(1) + 's');
    }

    log('info', '[批量] 完成 ' + DB.catalog.products.length + ' 个商品（成功 ' + okCount + ' 分类，跳过 ' + skipCount + '）');
    if (skipped.length) log('warn', '[批量] 这次没拉到：' + skipped.join('、') + ' —— 过几分钟再点「全部拉取」补上');
    UI.renderBrowse();
  }

  const queueRunning = {};
  const persistQueues = () => save('queues', DB.queues);

  const qpath = (u) => {
    let s = String(u || '').trim();
    const scheme = s.indexOf('://');
    if (scheme >= 0) {
      const after = s.slice(scheme + 3);
      const slash = after.indexOf('/');
      s = slash >= 0 ? after.slice(slash) : '/';
    }
    while (s.charAt(0) === '/') s = s.slice(1);
    return '/' + s;
  };

  async function queuePage(pid) {
    const r = await req('/index.php?m=vmiss_queue&pid=' + pid);
    if (isBad(r.status, r.text)) return { limited: true, status: r.status, verdict: r.verdict };
    const doc = new DOMParser().parseFromString(r.text, 'text/html');
    const vmq = doc.getElementById('vmq');
    if (!vmq) return { gone: true, status: r.status };
    const form = vmq.querySelector('form');
    let fields = null;
    if (form) {
      fields = {};
      for (const el of form.querySelectorAll('input[name],select[name],textarea[name]')) {
        const ty = String(el.getAttribute('type') || '').toLowerCase();
        if ((ty === 'checkbox' || ty === 'radio') && !el.checked) continue;
        if (fields[el.name] === undefined) fields[el.name] = el.value;
      }
    }
    const sub = vmq.querySelector('.vmq-sub');
    return {
      ok: true,
      poll: vmq.getAttribute('data-poll') || ('index.php?m=vmiss_queue&pid=' + pid + '&vq_status=1'),
      cart: vmq.getAttribute('data-cart') || ('cart.php?a=add&pid=' + pid),
      lastState: vmq.getAttribute('data-last-state') || '',
      form: form ? { action: form.getAttribute('action') || '', fields } : null,
      note: sub ? sub.textContent.replace(/\s+/g, ' ').trim() : '',
    };
  }

  async function queueStatus(poll) {
    const r = await req(qpath(poll));
    if (isBad(r.status, r.text)) return { limited: true, status: r.status };
    try {
      const d = JSON.parse(r.text);
      return { ok: true, state: String(d.state || ''), ahead: d.ahead, remaining: d.remaining };
    } catch (e) { return { bad: true, text: String(r.text).slice(0, 120) }; }
  }

  async function queueJoin(pg, pid, token) {
    const act = pg.form.action && pg.form.action !== '#' ? pg.form.action : ('/index.php?m=vmiss_queue&pid=' + pid);
    const body = Object.assign({}, pg.form.fields);
    if (token && body.token === undefined) body.token = token;
    const r = await post(qpath(act), body);
    return { ok: !isBad(r.status, r.text), status: r.status };
  }

  async function runQueue(q) {
    if (queueRunning[q.id] || !q.enabled) return;
    queueRunning[q.id] = 1;
    const t0 = Date.now();
    trace = 'Q' + q.pid;
    const upd = () => { if (UI.ready && UI.tab === 'queue') UI.renderQueue(); };
    const setState = (s, txt) => { q.state = s; q.stateText = txt; upd(); };
    try {
      q.lastCheck = Date.now();
      q.checks = (q.checks || 0) + 1;
      log('info', '> 排队 pid ' + q.pid + (q.label ? '（' + q.label + '）' : ''));
      upd();

      const token = await csrf();
      if (!token) { setState('error', '拿不到会话令牌'); return; }

      let pg = await queuePage(q.pid);
      for (let a = 1; a <= 2 && pg.limited; a += 1) {
        log('warn', '  排队页限速 HTTP ' + pg.status + '，等 ' + (a * 8) + 's');
        setState('skip', '排队页限速中');
        await sleep(a * 8000); lastReqAt = 0;
        pg = await queuePage(q.pid);
      }
      if (!pg.ok) { setState('error', pg.gone ? '排队页不存在（pid 错或已下架）' : ('拿不到排队页 HTTP ' + (pg.status || '?'))); return; }

      q.pollUrl = pg.poll;
      q.cartUrl = pg.cart;
      if (pg.note && !q.label) q.label = pg.note;

      const pollMs = Math.max(1000, Number(q.pollMs) || 3000);
      const maxTurns = Math.max(3, Math.ceil((Number(q.watchMs) || 120000) / pollMs));
      let st = null;
      let joins = 0;

      for (let k = 0; k < maxTurns; k += 1) {
        st = await queueStatus(pg.poll);
        if (!st.ok) {
          if (st.limited) { setState('skip', '状态接口限速'); await sleep(6000); lastReqAt = 0; continue; }
          setState('error', '状态接口异常: ' + (st.text || ''));
          return;
        }
        q.state = st.state;
        q.ahead = st.ahead;
        q.remaining = st.remaining;

        if (st.state === 'granted') { setState('granted', '入场资格到手 · 剩余 ' + (st.remaining || 0) + 's'); break; }
        if (st.state === 'waiting') setState('waiting', '排队中 · 前面 ' + (st.ahead === null || st.ahead === undefined ? '?' : st.ahead) + ' 位');
        else if (st.state === 'closed') { setState('closed', '队列未开放'); return; }
        else if (st.state === 'ineligible') { setState('error', '账号不满足购买资格（看历史消费额）'); return; }
        else if (st.state === 'invalid_link') { setState('error', '排队链接已失效，需找 VMISS 要新链接'); return; }
        else if (st.state === 'processing') { setState('processing', '结账处理中'); return; }
        else if (st.state === 'not_joined') {
          if (pg.form && joins < 3) {
            const j = await queueJoin(pg, q.pid, token);
            joins += 1;
            log('info', '  提交加入队列表单 → ' + (j.ok ? '已提交' : 'HTTP ' + j.status));
            setState('not_joined', '正在加入队列（第 ' + joins + ' 次）');
            await sleep(1500); lastReqAt = 0;
            continue;
          }
          setState('not_joined', pg.form ? '加入表单提交失败' : '页面没有加入表单（队列可能刚落开）');
        } else setState('error', '未知状态: ' + st.state);

        await sleep(pollMs);
      }

      if (!st || st.state !== 'granted') {
        if (st && st.state === 'waiting') setState('waiting', '本轮没轮到，下次继续');
        return;
      }

      burst = true;
      log('stock', '  ⚡ 入场资格到手，剩余 ' + (st.remaining || 0) + 's，立刻下单');
      if (DB.settings.pushOnRestock) push('VMISS 排队轮到你了', (q.label || ('pid ' + q.pid)) + ' · 剩余 ' + (st.remaining || 0) + 's');

      const addR = await req(qpath(pg.cart));
      const i = (addR.text.match(/name="i"[^>]*value="(\d+)"/) || [])[1];
      if (!i) {
        const oos = /out of stock|缺货|sold out/i.test(addR.text);
        setState('out', oos ? '加购失败：缺货' : ('加购失败 HTTP ' + addR.status));
        log('error', '  加购失败 HTTP ' + addR.status + (oos ? ' · 缺货' : ''));
        return;
      }
      log('info', '  已加购 i=' + i);
      upd();

      const cfg = await configure(q, token, i);
      if (!cfg.ok) { setState('error', '配置失败: ' + (cfg.err || '')); log('error', '  配置失败: ' + (cfg.err || '')); return; }

      const res = await submitOrder(q, token);
      if (!res.ok) { setState('error', res.msg || '下单失败'); log('error', '  下单失败: ' + (res.msg || '')); return; }

      q.buys = (q.buys || 0) + 1;
      q.invoiceId = res.invoiceId;
      q.lastBuyMs = Date.now() - t0;
      setState('bought', '发票 ' + res.invoiceId + ' · ' + q.lastBuyMs + 'ms');
      log('buy', '排队下单成功 · 发票 ' + res.invoiceId + ' · ' + q.lastBuyMs + 'ms');
      if (DB.settings.pushOnBuy) push('VMISS 排队抢购成功', (q.label || ('pid ' + q.pid)) + '\n发票 #' + res.invoiceId + '\n耗时 ' + q.lastBuyMs + 'ms' + (q.genPw ? '\nroot 密码: ' + q.genPw : ''));
      if (q.stopAfter) q.enabled = false;
    } catch (e) {
      log('error', '排队异常: ' + String(e.message || e));
      q.stateText = '异常: ' + String(e.message || e).slice(0, 40);
    } finally {
      burst = false;
      delete queueRunning[q.id];
      persistQueues();
      upd();
    }
  }

  const QPAY = (v) => (v === 'balance' ? '余额' : v === 'motionpayalipay' ? '支付宝' : v === 'cryptomusgateway' ? '加密货币' : '信用卡');

  UI.renderQueue = function () {
    if (!root || UI.tab !== 'queue') return;
    const bd = root.querySelector('#vp-bd');
    const list = DB.queues || [];
    let h = '<div class="act"><button class="b g" id="q-add">+ 添加排队任务</button>' +
      (list.length ? '<button class="b" id="q-allon">全部启用</button><button class="b" id="q-alloff">全部暂停</button>' : '') + '</div>';
    h += '<div class="hint" style="margin-bottom:9px;line-height:1.7">' +
      '<b style="color:#2dd4bf">VMISS 新版排队购买</b>：先在排队页排队 → 轮到你了 → 才有资格进购物车（限时）。<br>' +
      '这里填商品 <b>pid</b>，插件会盯着排队状态，一拿到入场资格就立刻加购下单。<br>' +
      '<span style="color:#fbbf24">注意</span>：排队页需要账号已登录，且部分商品要求历史消费额（ineligible 就是这条）。</div>';
    if (!list.length) {
      h += '<div class="empty">还没有排队任务<br><span style="color:#5a5a64">点「+ 添加排队任务」，填商品 pid（链接里 pid= 后面那个数字）</span></div>';
      bd.innerHTML = h; bind(bd); return;
    }
    for (const q of list) {
      const busy = !!queueRunning[q.id];
      const cls = ['granted', 'bought', 'error', 'skip', 'out'].indexOf(q.state) >= 0 ? q.state : '';
      h += '<div class="m"><div class="r1"><span class="nm" title="' + esc(q.label || '') + '">' + esc(q.label || ('pid ' + q.pid) ) + '</span>' +
        '<span class="pr">pid ' + q.pid + '</span></div>' +
        '<div class="r2"><span>' + Math.round((q.intervalMs || 30000) / 1000) + 's 巡检</span><span>' + QPAY(q.paymentMethod) + '</span>' +
        (function () {
          if (q.useCoupon === false) return '';
          const c = (q.couponCode || '').trim() || (DB.settings.defaultCoupon || '').trim();
          return c ? '<span style="color:#fbbf24">' + esc(c) + ((q.couponCode || '').trim() ? '' : ' 默认') + '</span>' : '<span style="color:#6f6f7a">无码</span>';
        })() +
        '<span>检查 ' + (q.checks || 0) + '</span><span>成交 ' + (q.buys || 0) + '</span>' +
        (q.lastBuyMs ? '<span style="color:#34d399">' + q.lastBuyMs + 'ms</span>' : '') +
        '<span>' + ago(q.lastCheck) + '</span></div>' +
        '<div class="st ' + cls + '">' + (busy ? '[跑] ' : '') + esc(q.stateText || (q.enabled ? '等待首次检查' : '已暂停')) + '</div>' +
        (q.genPw ? '<div class="st" style="background:rgba(45,212,191,.12);color:#2dd4bf;cursor:pointer" data-a="copy" data-id="' + q.id + '" title="点一下复制">root 密码 ' + esc(q.genPw) + '（点击复制）</div>' : '') +
        '<div class="r3">' +
        '<button class="b sm' + (q.enabled ? '' : ' g') + '" data-qa="toggle" data-qid="' + q.id + '">' + (q.enabled ? '暂停' : '启用') + '</button>' +
        '<button class="b sm" data-qa="once" data-qid="' + q.id + '">立即检查</button>' +
        '<button class="b sm" data-qa="edit" data-qid="' + q.id + '">配置</button>' +
        '<button class="b sm d" data-qa="del" data-qid="' + q.id + '">删除</button></div></div>';
    }
    bd.innerHTML = h;
    bind(bd);
  };

  function openQueueEditor(existing) {
    const base = existing || {
      id: nextId(), pid: 0, label: '',
      intervalMs: 30000, pollMs: 3000, watchMs: 180000,
      paymentMethod: 'motionpayalipay', useBalance: false,
      couponCode: DB.settings.defaultCoupon || '', useCoupon: true,
      hostname: '', rootPassword: '', ns1Prefix: '', ns2Prefix: '', options: {},
      stopAfter: true, enabled: true, checks: 0, buys: 0,
      stateText: '', state: '', lastCheck: 0, nextAt: 0,
    };
    const dlg = document.createElement('div');
    dlg.className = 'dlg';
    dlg.innerHTML = '<div class="c"><h4>' + (existing ? '编辑排队任务' : '添加排队任务') + '</h4>' +
      '<label class="f"><span>商品 pid</span><input id="q_pid" type="number" placeholder="链接里 pid= 后面的数字，例如 32" value="' + (base.pid || '') + '"></label>' +
      '<label class="f"><span>备注名（留空自动从页面取）</span><input id="q_label" placeholder="例如 US.LA.TRI.Basic" value="' + esc(base.label || '') + '"></label>' +
      '<div class="g2"><label class="f"><span>巡检间隔（秒）</span><input id="q_iv" type="number" min="10" value="' + Math.round((base.intervalMs || 30000) / 1000) + '"></label>' +
      '<label class="f"><span>队列内轮询（毫秒）</span><input id="q_poll" type="number" min="1000" step="500" value="' + (base.pollMs || 3000) + '"></label></div>' +
      '<label class="f"><span>单次最多盯多久（秒）</span><input id="q_watch" type="number" min="30" value="' + Math.round((base.watchMs || 180000) / 1000) + '">' +
      '<div class="hint" style="margin-top:5px">拿到入场资格的窗口很短，这里决定一轮里最多轮询多久。默认 180 秒。</div></label>' +
      '<label class="f"><span>支付方式</span><select id="q_pay">' +
      '<option value="motionpayalipay"' + (base.paymentMethod === 'motionpayalipay' ? ' selected' : '') + '>支付宝（只锁单，推二维码）</option>' +
      '<option value="cryptomusgateway"' + (base.paymentMethod === 'cryptomusgateway' ? ' selected' : '') + '>加密货币（只锁单）</option>' +
      '<option value="stripe"' + (base.paymentMethod === 'stripe' ? ' selected' : '') + '>信用卡（只锁单）</option>' +
      '<option value="balance"' + (base.paymentMethod === 'balance' ? ' selected' : '') + '>余额（立即扣款）</option></select></label>' +
      '<label class="f"><span>优惠码</span><input id="q_cp" placeholder="留空则用默认：' + esc(DB.settings.defaultCoupon || '（未设置）') + '" value="' + esc(base.couponCode || '') + '"></label>' +
      '<label class="chk" style="margin:-4px 0 9px"><input type="checkbox" id="q_usecp"' + (base.useCoupon === false ? '' : ' checked') + '>本任务使用优惠码</label>' +
      '<div class="g2"><label class="f"><span>主机名（留空自动生成）</span><input id="q_hn" placeholder="server.example.com" value="' + esc(base.hostname || '') + '"></label>' +
      '<label class="f"><span>root 密码（必填，8~64 位）</span><input id="q_rp" placeholder="留空自动生成并显示" value="' + esc(base.rootPassword || '') + '"></label></div>' +
      '<div class="g2"><label class="f"><span>NS1 / NS2 前缀</span><div style="display:flex;gap:6px"><input id="q_ns1" placeholder="ns1" value="' + esc(base.ns1Prefix || '') + '"><input id="q_ns2" placeholder="ns2" value="' + esc(base.ns2Prefix || '') + '"></div></label>' +
      '<label class="f"><span>抢到后</span><select id="q_stop"><option value="1"' + (base.stopAfter ? ' selected' : '') + '>自动暂停</option><option value="0"' + (base.stopAfter ? '' : ' selected') + '>继续监控</option></select></label></div>' +
      '<label class="chk"><input type="checkbox" id="q_bal"' + (base.useBalance ? ' checked' : '') + '>允许用余额支付（会立即扣款，谨慎勾选）</label>' +
      '<div class="row"><button id="q_cancel">取消</button><button class="g" id="q_ok">' + (existing ? '保存' : '添加') + '</button></div></div>';
    root.appendChild(dlg);
    const g = (n) => dlg.querySelector('#' + n);
    g('q_cancel').onclick = () => dlg.remove();
    g('q_ok').onclick = () => {
      const pid = Number(g('q_pid').value) || 0;
      if (!pid) { log('error', 'pid 不能为空（链接里 pid= 后面那个数字）'); return; }
      const item = {
        id: base.id, pid,
        label: g('q_label').value.trim() || base.label || '',
        intervalMs: Math.max(10000, (Number(g('q_iv').value) || 30) * 1000),
        pollMs: Math.max(1000, Number(g('q_poll').value) || 3000),
        watchMs: Math.max(30000, (Number(g('q_watch').value) || 180) * 1000),
        paymentMethod: g('q_pay').value,
        useBalance: g('q_bal').checked,
        couponCode: g('q_cp').value.trim(),
        useCoupon: g('q_usecp').checked,
        hostname: g('q_hn').value.trim(),
        rootPassword: g('q_rp').value.trim(),
        ns1Prefix: g('q_ns1').value.trim(),
        ns2Prefix: g('q_ns2').value.trim(),
        options: base.options || {},
        stopAfter: g('q_stop').value === '1',
        enabled: base.enabled === undefined ? true : base.enabled,
        checks: base.checks || 0, buys: base.buys || 0,
        stateText: base.stateText || '', state: base.state || '',
        lastCheck: base.lastCheck || 0, nextAt: 0,
      };
      if (existing) {
        DB.queues = DB.queues.map((x) => (x.id === item.id ? item : x));
      } else {
        DB.queues.push(item);
      }
      persistQueues();
      dlg.remove();
      log('info', '排队任务已保存 · pid ' + pid);
      UI.renderQueue();
    };
  }

  async function openEditor(existing, preset) {
    const base = existing || {
      id: nextId(),
      pid: preset ? preset.pid : 0, name: preset ? preset.name : '',
      slug: preset ? preset.slug : '', categorySlug: preset ? preset.categorySlug : '',
      price: preset ? preset.price : 0,
      intervalMs: DB.settings.defaultIntervalMs,
      paymentMethod: 'motionpayalipay', useBalance: false,
      couponCode: DB.settings.defaultCoupon || '',
      maxPrice: 0, billingCycle: 'monthly', os: '', hostname: '', rootPassword: '',
      ns1Prefix: '', ns2Prefix: '', options: {},
      stopAfter: true, enabled: true, checks: 0, buys: 0, fails: 0,
      stateText: '', lastState: '', lastCheck: 0, nextAt: 0,
    };

    const dlg = document.createElement('div');
    dlg.className = 'dlg';
    dlg.innerHTML = '<div class="c"><h4>' + (existing ? '编辑监控' : '添加监控 · ' + esc(base.name || ('pid ' + base.pid))) + '</h4>' +
      '<div id="e_body"></div>' +
      '<div class="row"><button id="e_cancel">取消</button><button class="g" id="e_ok">' + (existing ? '保存' : '添加') + '</button></div></div>';
    root.appendChild(dlg);

    const body = dlg.querySelector('#e_body');
    const manual = existing ? '' :
      '<label class="f"><span>商品 pid</span><div style="display:flex;gap:6px"><input id="e_pid" value="' + (base.pid || '') + '"><button class="b" id="e_load">带出</button></div></label>' +
      '<label class="f"><span>分类 slug</span><input id="e_cat" value="' + esc(base.categorySlug) + '"></label>' +
      '<label class="f"><span>商品 slug</span><input id="e_slug" value="' + esc(base.slug) + '"></label>' +
      '<label class="f"><span>名称</span><input id="e_name" value="' + esc(base.name) + '"></label>' +
      '<label class="f"><span>当前价格</span><input id="e_price" type="number" step="0.01" value="' + (base.price || 0) + '"></label>';

    body.innerHTML = manual +
      '<div id="e_opts"></div>' +
      '<div class="g2"><label class="f"><span>检查间隔（秒）</span><input id="e_iv" type="number" min="5" value="' + (base.intervalMs / 1000) + '"></label>' +
      '<label class="f"><span>价格上限（0=不限）</span><input id="e_max" type="number" step="0.01" value="' + (base.maxPrice || 0) + '"></label></div>' +
      '<label class="f"><span>支付方式</span><select id="e_pay">' +
      '<option value="motionpayalipay"' + (base.paymentMethod === 'motionpayalipay' ? ' selected' : '') + '>支付宝（只锁单，推二维码）</option>' +
      '<option value="cryptomusgateway"' + (base.paymentMethod === 'cryptomusgateway' ? ' selected' : '') + '>加密货币（只锁单）</option>' +
      '<option value="stripe"' + (base.paymentMethod === 'stripe' ? ' selected' : '') + '>信用卡（只锁单）</option>' +
      '<option value="balance"' + (base.paymentMethod === 'balance' ? ' selected' : '') + '>余额（立即扣款）</option></select></label>' +
      '<div id="e_balwarn"></div>' +
      '<label class="f"><span>优惠码</span><input id="e_cp" placeholder="留空则用默认：' + esc(DB.settings.defaultCoupon || '（未设置）') + '" value="' + esc(base.couponCode) + '">' +
      '<div class="hint" style="margin-top:5px" id="e_cphint"></div></label>' +
      '<label class="chk" style="margin:-4px 0 9px"><input type="checkbox" id="e_usecp"' + (base.useCoupon === false ? '' : ' checked') + '>本条监控使用优惠码</label>' +
      '<div class="g2"><label class="f"><span>计费周期</span><select id="e_cyc">' +
      '<option value="monthly"' + (base.billingCycle === 'monthly' ? ' selected' : '') + '>月付</option>' +
      '<option value="quarterly"' + (base.billingCycle === 'quarterly' ? ' selected' : '') + '>季付</option>' +
      '<option value="annually"' + (base.billingCycle === 'annually' ? ' selected' : '') + '>年付</option></select></label>' +
      '<label class="f"><span>抢到后</span><select id="e_stop">' +
      '<option value="1"' + (base.stopAfter ? ' selected' : '') + '>自动暂停</option>' +
      '<option value="0"' + (base.stopAfter ? '' : ' selected') + '>继续监控</option></select></label></div>' +
      '<label class="f"><span>主机名（留空自动生成）</span><input id="e_hn" placeholder="server.example.com" value="' + esc(base.hostname) + '"></label>' +
      '<div class="g2"><label class="f"><span>root 密码（必填，8~64 位）</span><input id="e_rp" type="text" placeholder="留空则自动生成并显示在日志和卡片上" value="' + esc(base.rootPassword) + '">' +
      '<div class="hint" style="margin-top:5px">官方<b style="color:#fbbf24">强制要求</b>这个字段。留空会自动生成 16 位密码，日志和监控卡片上都会显示，抢到时也会推给你。</div></label>' +
      '<label class="f"><span>NS1 / NS2 前缀</span><div style="display:flex;gap:6px"><input id="e_ns1" placeholder="ns1" value="' + esc(base.ns1Prefix) + '"><input id="e_ns2" placeholder="ns2" value="' + esc(base.ns2Prefix) + '"></div></label></div>';

    const q = (n) => dlg.querySelector('#' + n);
    const optBox = dlg.querySelector('#e_opts');
    const curOptions = Object.assign({}, base.options || {});

    function renderOpts(cache) {
      const items = (cache && cache.items) || [];
      if (!items.length) {
        optBox.innerHTML = '<div class="optbox"><div class="oh">商品配置项</div>' +
          '<div class="hint">该商品没有可配置项。<br>下单会带上官方默认值，不会缺少必填字段。</div>' +
          '<div style="margin-top:7px"><button class="b sm" id="e_reopt">重新读取</button></div></div>';
        bindReopt();
        return;
      }
      let h = '<div class="optbox"><div class="oh">商品配置项（' + items.length + ' 个 · 该商品专有）</div>';
      h += '<div class="hint" style="margin-bottom:9px">每个商品的可配置项都不一样，这些是实时从官网配置页读出来的。' +
        '不改就按官方默认提交；改了就按你选的提交。</div>';
      for (const it of items) {
        h += '<label class="f" style="margin-bottom:8px"><span>' + esc(it.title) +
          (it.kind === 'select' ? '' : (it.min || it.max ? '（' + (it.min || '?') + '~' + (it.max || '?') + '）' : '')) + '</span>';
        if (it.kind === 'select') {
          h += '<select data-opt="' + esc(it.name) + '">' +
            it.opts.map((o) => '<option value="' + esc(o.v) + '"' +
              ((curOptions[it.name] !== undefined && curOptions[it.name] !== '' ? curOptions[it.name] : it.def) === o.v ? ' selected' : '') +
              '>' + esc(o.t) + '</option>').join('') + '</select>';
        } else {
          const v = curOptions[it.name] !== undefined && curOptions[it.name] !== '' ? curOptions[it.name] : (it.def || '');
          h += '<input data-opt="' + esc(it.name) + '" type="' + (it.kind === 'number' ? 'number' : 'text') + '"' +
            (it.min ? ' min="' + esc(it.min) + '"' : '') + (it.max ? ' max="' + esc(it.max) + '"' : '') +
            ' placeholder="' + esc(it.ph || '') + '" value="' + esc(v) + '">';
        }
        h += '</label>';
      }
      h += '<div style="margin-top:8px"><button class="b sm" id="e_reopt">重新读取配置项</button></div></div>';
      optBox.innerHTML = h;
      bindReopt();
    }

    function bindReopt() {
      const b = optBox.querySelector('#e_reopt');
      if (!b) return;
      b.onclick = () => {
        delete DB.optCache[base.pid];
        save('optCache', DB.optCache);
        loadOpts();
      };
    }

    function loadOpts() {
      optBox.innerHTML = '<div class="optbox"><div class="oh">商品配置项</div><div class="hint">正在读取该商品的配置页…</div></div>';
      void (async () => {
        try {
          const add = await req('/store/' + base.categorySlug + '/' + base.slug);
          const i = (add.text.match(/name="i"[^>]*value="(\d+)"/) || [])[1];
          if (!i) {
            optBox.innerHTML = '<div class="optbox"><div class="oh">商品配置项</div>' +
              '<div class="hint">读不到配置页（缺货或被限速）。点下面重试。</div>' +
              '<div style="margin-top:7px"><button class="b sm" id="e_reopt">重试</button></div></div>';
            bindReopt();
            return;
          }
          const cache = await readConfigOptions(base, i);
          if (dlg.parentNode) renderOpts(cache);
        } catch (err) {
          optBox.innerHTML = '<div class="optbox"><div class="oh">商品配置项</div><div class="hint">读取失败：' + esc(String(err.message || err)) + '</div></div>';
        }
      })();
    }

    function collectOpts() {
      const o = {};
      for (const el of optBox.querySelectorAll('[data-opt]')) o[el.dataset.opt] = el.value;
      return o;
    }

    if (DB.optCache[base.pid] && DB.optCache[base.pid].items) renderOpts(DB.optCache[base.pid]);
    else if (base.pid && base.slug && base.categorySlug) loadOpts();
    else optBox.innerHTML = '<div class="optbox"><div class="oh">商品配置项</div><div class="hint">填好 pid / 分类 / slug 后自动读取（点上面的「带出」也行）。</div></div>';

    function updBalWarn() {
      const w = dlg.querySelector('#e_balwarn');
      if (q('e_pay').value !== 'balance') { w.innerHTML = ''; return; }
      w.innerHTML = '<div class="warnbox">已选「余额支付」：抢到后会<b>立即从账户余额扣款并结清账单</b>，不会等你确认。余额不足则下单失败。</div>';
    }
    q('e_pay').onchange = updBalWarn;
    updBalWarn();

    function updCouponHint() {
      const h = dlg.querySelector('#e_cphint');
      if (!h) return;
      const use = q('e_usecp') ? q('e_usecp').checked : true;
      const own = q('e_cp').value.trim();
      const def = (DB.settings.defaultCoupon || '').trim();
      let txt = '';
      if (!use) txt = '本条不使用优惠码。';
      else if (own) txt = '将使用自定义优惠码 ' + own;
      else if (def) txt = '留空 → 自动使用全局默认 ' + def;
      else txt = '留空且全局默认也为空 → 不会使用优惠码。可到「设置」里填默认优惠码。';
      h.textContent = txt;
      h.style.color = (use && !own && !def) ? '#fbbf24' : '#6f6f7a';
    }
    q('e_cp').oninput = updCouponHint;
    if (q('e_usecp')) q('e_usecp').onchange = updCouponHint;
    updCouponHint();

    q('e_cancel').onclick = () => dlg.remove();
    dlg.onclick = (e) => { if (e.target === dlg) dlg.remove(); };

    if (q('e_load')) {
      q('e_load').onclick = async () => {
        const pg = q('e_pid').value.trim(), cat = q('e_cat').value.trim();
        if (!pg || !cat) { log('warn', 'pid 和分类都要填'); return; }
        q('e_load').textContent = '...';
        const list = await fetchProducts(cat, cat, true);
        q('e_load').textContent = '带出';
        if (!list || list.limited) { log('warn', '拉取失败或限速'); return; }
        const p = list.filter((x) => x.pid === Number(pg))[0];
        if (!p) { log('warn', '该分类里没找到 pid=' + pg); return; }
        q('e_slug').value = p.slug; q('e_name').value = p.name; q('e_price').value = p.price;
        log('info', '带出 ' + p.name + ' · ' + yuan(p.price));
      };
    }

    q('e_ok').onclick = () => {
      const pay = q('e_pay').value;
      const item = Object.assign({}, base, {
        pid: Number(q('e_pid') ? q('e_pid').value : base.pid) || base.pid,
        categorySlug: q('e_cat') ? q('e_cat').value.trim() : base.categorySlug,
        slug: q('e_slug') ? q('e_slug').value.trim() : base.slug,
        name: (q('e_name') ? q('e_name').value.trim() : base.name) || ('pid ' + base.pid),
        price: Number(q('e_price') ? q('e_price').value : base.price) || 0,
        intervalMs: Math.max(5000, Number(q('e_iv').value) * 1000 || DB.settings.defaultIntervalMs),
        maxPrice: Number(q('e_max').value) || 0,
        paymentMethod: pay,
        useBalance: pay === 'balance',
        couponCode: q('e_cp').value.trim(),
        useCoupon: q('e_usecp') ? q('e_usecp').checked : true,
        billingCycle: q('e_cyc').value,
        stopAfter: q('e_stop').value === '1',
        hostname: q('e_hn').value.trim(),
        rootPassword: q('e_rp').value.trim(),
        ns1Prefix: q('e_ns1').value.trim(),
        ns2Prefix: q('e_ns2').value.trim(),
        options: collectOpts(),
        enabled: true, nextAt: 0,
      });
      if (!item.pid || !item.slug || !item.categorySlug) { log('error', 'pid / 分类 / slug 都不能为空'); return; }
      const at = DB.monitors.findIndex((x) => x.id === item.id);
      if (at >= 0) DB.monitors[at] = Object.assign({}, DB.monitors[at], item);
      else DB.monitors.push(item);
      persist();
      dlg.remove();
      const n = Object.keys(item.options).filter((k) => item.options[k]).length;
      log('info', '[保存] ' + (at >= 0 ? '更新 ' : '添加 ') + item.name +
        (n ? ' · 配置 ' + n + ' 项' : ' · 无配置项（快速下单）') +
        (item.couponCode ? ' · 优惠码 ' + item.couponCode : '') +
        (item.useBalance ? ' · 余额扣款' : ' · 锁单'));
      UI.tab = 'monitors'; UI.syncTabs(); UI.render(); UI.renderStatus();
    };
  }

  function exportCfg() {
    const blob = new Blob([JSON.stringify({ monitors: DB.monitors, settings: DB.settings, optCache: DB.optCache }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vmiss-monitors.json';
    a.click();
    log('info', '配置已导出');
  }
  function importCfg() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json';
    inp.onchange = async () => {
      try {
        const j = JSON.parse(await inp.files[0].text());
        if (Array.isArray(j.monitors)) DB.monitors = j.monitors;
        if (j.settings) DB.settings = Object.assign({}, DB.settings, j.settings);
        if (j.optCache) DB.optCache = j.optCache;
        persist(); save('settings', DB.settings); save('optCache', DB.optCache);
        log('info', '配置已导入');
        UI.render(); UI.renderStatus();
      } catch (e) { log('error', '导入失败 ' + e.message); }
    };
    inp.click();
  }

  function showIntro(force) {
    const d = document.createElement('div');
    d.className = 'dlg';
    d.innerHTML = '<div class="c"><h4>使用说明</h4><ol>' +
      '<li><b>必须保持本页面开着</b>：脚本靠这个标签页发请求。可以最小化，但关掉就停了。</li>' +
      '<li><b>必须先登录 VMISS</b>：没登录时结账页会走「游客注册」流程，必然下单失败。</li>' +
      '<li>去「选商品」拉一个分类 → 点 <b>+ 监控</b> → 在弹窗里设间隔、支付方式、优惠码、配置项。</li>' +
      '<li><b>支付方式</b>：支付宝 / 加密货币 / 信用卡都只锁单（生成待付款发票，推二维码给你付）；选「余额」会立即扣款结清。</li>' +
      '<li><b>配置项不选 = 跟随官方默认</b>，并且会跳过读配置页，下单更快。</li>' +
      '<li>抢购把请求间隔临时压到「爆发间隔」，一次下单约 4~5 秒。想更快就调小它。</li>' +
      '<li>日志里能看到每次请求的状态码、字节数、耗时和发票号。</li>' +
      '</ol><div class="row"><button id="d_ok">知道了</button></div></div>';
    root.appendChild(d);
    d.querySelector('#d_ok').onclick = () => { d.remove(); DB.settings.seenIntro = true; save('settings', DB.settings); };
    if (!force) d.onclick = (e) => { if (e.target === d) d.remove(); };
  }

  async function checkVersion() {
    if (!VERSION_URL) return;
    try {
      const r = await new Promise((res) => GM_xmlhttpRequest({ method: 'GET', url: VERSION_URL, onload: res, onerror: () => res(null), timeout: 8000 }));
      if (!r || !r.responseText) return;
      const v = (r.responseText.match(/\d+\.\d+\.\d+/) || [])[0];
      if (v && v !== LATEST && v !== DB.settings.lastVersion) {
        DB.settings.lastVersion = v;
        save('settings', DB.settings);
        log('warn', '有新版本 ' + v + '（当前 ' + LATEST + '），请更新脚本');
        push('VMISS 抢购助手有新版', '当前 ' + LATEST + ' → 新版 ' + v);
      }
    } catch (e) { /* 静默 */ }
  }

  function boot() {
    root = shell();
    UI.ready = true;
    UI.render();
    UI.renderStatus();
    schedule();
    startPrewarm();
    setInterval(() => {
      UI.renderStatus();
      if (UI.tab === 'monitors') UI.renderMonitors();
      if (UI.tab === 'logs') UI.renderLogs();
    }, 2000);
    log('info', '=== VMISS 抢购助手 v' + LATEST + ' 已就绪（MIT 许可）===');
    log('info', '监控 ' + DB.monitors.length + ' 项 · 目录 ' + (DB.catalog.products.length || 0) + ' 商品');
    if (!DB.settings.seenIntro) setTimeout(() => showIntro(false), 800);
    void checkLogin(true).then((s) => {
      if (s.ok === false) log('error', '当前浏览器未登录 VMISS —— 能监控但无法下单');
      else if (s.ok === true) log('info', '登录态正常');
    });
    void checkVersion();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
