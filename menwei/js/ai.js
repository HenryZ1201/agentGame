(function () {
  'use strict';

  const CACHE_KEY = 'mw-cache-v4';

  let C = null;
  let M = { temperature: 0, timeoutMs: 12000, doubleCheck: true };
  let SYSTEM = '';
  let FEWSHOT = [];
  let ASK_FEWSHOT = [];
  let promptTag = '';

  async function status() {
    try {
      const r = await fetch('/api/status');
      if (!r.ok) throw new Error();
      return await r.json();
    } catch {
      return { online: false, model: null };
    }
  }

  async function chat(messages, temperature, maxTokens) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), M.timeoutMs);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, temperature, max_tokens: maxTokens }),
        signal: ctrl.signal,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      return data;
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? '请求超时' : e.message);
    } finally {
      clearTimeout(timer);
    }
  }

  function extractJSON(raw) {
    let s = String(raw || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('输出里没有 JSON');
    return JSON.parse(m[0]);
  }

  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36);
  }

  /* ---------- 按配置组装提示词 ---------- */

  const askText = (name, attr) => `客人：${name}\n问题：它${attr.q}吗？`;

  function setup(content) {
    C = content;
    const m = C.model || {};
    M = {
      temperature: Number(m.temperature ?? 0),
      timeoutMs: Number(m.timeout_ms ?? 12000),
      doubleCheck: m.double_check !== false,
    };

    SYSTEM = [
      '你是一个属性判断器。给你一位客人（一个东西、动物或人），逐项判断它是否符合下列特征。',
      '按最常见、最典型的情况判断。',
      '特征：',
      ...C.ATTRS.map((a) => `- ${a.key}：${a.q}`),
      '客人必须是一个常见的名词：东西、动物或人（“电动牙刷”“消防员”这类固定叫法也算）。',
      '虚构的生物和东西也算客人（比如外星人、龙、哆啦A梦），按它们通常的样子判断。',
      '以下不算客人，“认识”填 false，其余全填 false：',
      '- 带形容词、材质、颜色等修饰的说法（比如“会飞的猪”“木头勺子”“红色汽车”）；',
      '- 抽象概念或乱码（比如“爱情”“星期一”“asdf”）。',
      `只输出一行 JSON：{"认识":true,"emoji":"一个最贴切的emoji",${C.ATTRS.map((a) => `"${a.key}":true或false`).join(',')}}`,
    ].join('\n');

    const shot = (ex) => {
      const yes = new Set((ex.yes || []).map(String));
      return JSON.stringify({
        认识: ex.known !== false,
        emoji: String(ex.emoji || '🙂'),
        ...Object.fromEntries(C.ATTRS.map((a) => [a.key, ex.known !== false && yes.has(a.id)])),
      });
    };
    FEWSHOT = (m.scan_examples || []).filter((ex) => ex && ex.guest)
      .map((ex) => [`客人：${ex.guest}`, shot(ex)]);
    ASK_FEWSHOT = (m.check_examples || []).filter((ex) => ex && ex.guest && C.ATTR[ex.attribute])
      .map((ex) => [askText(ex.guest, C.ATTR[ex.attribute]), JSON.stringify({ 答案: ex.answer === true })]);

    promptTag = hash(JSON.stringify([SYSTEM, FEWSHOT, ASK_FEWSHOT, M.temperature]));
  }

  const ASK_SYSTEM = [
    '你是一个判断器。给你一位客人和一道是非题，按最常见、最典型的情况回答。',
    '虚构的生物和东西按它们通常的样子判断。',
    '只输出一行 JSON：{"答案":true} 或 {"答案":false}',
  ].join('\n');

  function withShots(system, shots, user) {
    const msgs = [{ role: 'system', content: system }];
    shots.forEach(([u, a]) => msgs.push({ role: 'user', content: u }, { role: 'assistant', content: a }));
    msgs.push({ role: 'user', content: user });
    return msgs;
  }

  function validate(obj) {
    if (typeof obj !== 'object' || obj === null) throw new Error('不是对象');
    const missing = C.ATTRS.filter((a) => typeof obj[a.key] !== 'boolean');
    if (missing.length > 2) throw new Error(`缺少字段：${missing.map((a) => a.key).join('、')}`);
    const attrs = Object.fromEntries(C.ATTRS.map((a) => [a.id, obj[a.key] === true]));
    const emoji = typeof obj.emoji === 'string' && /\p{Extended_Pictographic}/u.test(obj.emoji)
      ? [...obj.emoji].slice(0, 4).join('') : '🙂';
    return { known: obj['认识'] !== false, emoji, attrs };
  }

  /* ---------- 缓存：同一位客人永远得到同一个判定；改了特征或示范后自动失效 ---------- */

  const cache = new Map(Object.entries((() => {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; }
  })()));
  const saveCache = () => {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(cache))); } catch { /* 存不下就算了 */ }
  };

  async function cached(key, fn) {
    const k = `${promptTag}|${key}`;
    if (cache.has(k)) return cache.get(k);
    const v = await fn();
    cache.set(k, v);
    saveCache();
    return v;
  }

  async function retry(label, fn, log) {
    let lastErr = null;
    for (let i = 0; i < 2; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        log && log(`${label}失败：${e.message}`, 'warn');
      }
    }
    throw lastErr;
  }

  function scan(name, log) {
    return cached(`scan|${name}`, () => retry(`判定「${name}」`, async () => {
      const t0 = performance.now();
      const data = await chat(withShots(SYSTEM, FEWSHOT, `客人：${name}`), M.temperature, 40 + C.ATTRS.length * 14);
      const res = validate(extractJSON(data.content));
      log && log(`判定「${name}」${Math.round(performance.now() - t0)}ms：${data.content}`);
      return res;
    }, log));
  }

  function ask(name, id, log) {
    const attr = C.ATTR[id];
    return cached(`ask|${name}|${id}`, () => retry(`复核「${name}·${attr.key}」`, async () => {
      const data = await chat(withShots(ASK_SYSTEM, ASK_FEWSHOT, askText(name, attr)), M.temperature, 20);
      const v = extractJSON(data.content)['答案'];
      if (typeof v !== 'boolean') throw new Error(`答案不是布尔值：${data.content}`);
      return v;
    }, log));
  }

  /* 所有特征一起判一遍；开启复核时，再把当天规则用到的特征单独问一遍。
     两次不一致说明这位客人本身有歧义，返回 unsure，让门卫拒绝给出可能误导玩家的线索。 */
  async function classify(name, ruleIds, log) {
    const checkIds = M.doubleCheck ? ruleIds : [];
    const [scanRes, ...asks] = await Promise.allSettled([scan(name, log), ...checkIds.map((id) => ask(name, id, log))]);
    if (scanRes.status === 'rejected') throw scanRes.reason;
    const base = scanRes.value;
    const unsure = checkIds.filter((id, i) => asks[i].status === 'fulfilled' && asks[i].value !== base.attrs[id]);
    if (unsure.length) log && log(`「${name}」两次判断不一致：${unsure.map((id) => C.ATTR[id].key).join('、')}`, 'warn');
    return { ...base, unsure };
  }

  window.MW_AI = { setup, status, classify, scan, ask };
})();
