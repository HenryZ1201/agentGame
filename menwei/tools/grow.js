#!/usr/bin/env node
/*
 * 熟客扩充工具：模型批量判断 / 现编客人，复核后写成草稿，人审过再并入 guests.yaml。
 * 模型调用走本地 server.py 的 /api/chat（先启动它），脚本本身不读 API Key。
 *
 *   node tools/grow.js label [--attrs plant,wood]
 *       给已有熟客补标注特征。默认补“还没有任何熟客标注过”的特征（也就是 config.yaml 里新加的）。
 *   node tools/grow.js gen [--combos 30] [--per 4] [--after 草稿]
 *       找出名单里缺的特征组合（同时符合两个特征的熟客太少，“而且”规则就出不来），让模型现编客人并复核。
 *       --after：先假装已经合并了某份草稿再找缺口（比如刚生成、还没合并的补标注草稿）。
 *       --focus plant,wood：只补涉及这些特征的缺口；--single-target 16：单个特征补到几位（默认 8）。
 *   node tools/grow.js add 吉他,砧板,梯子
 *       人来提名客人，模型逐项标注、复核，写成草稿。适合模型自己想不出合格客人的特征。
 *   node tools/grow.js merge <草稿> [<草稿> ...]
 *       把审过的草稿并入 guests.yaml，合并前会备份到 drafts/。
 *
 * 复核方式和游戏里一样：所有特征一起判一次，再逐个特征单独问一次，两次一致才算数，不一致记为 unsure。
 * 草稿、备份、模型缓存都在 menwei/drafts/。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DRAFTS = path.join(ROOT, 'drafts');
const CACHE_FILE = path.join(DRAFTS, '.model-cache.json');
const SERVER = process.env.MW_SERVER || 'http://127.0.0.1:8771';

const read = (f) => fs.readFileSync(path.isAbsolute(f) ? f : path.join(ROOT, f), 'utf8');
const stamp = () => new Date().toLocaleString('sv-SE').replace(/[: ]/g, (c) => (c === ' ' ? '_' : '')).slice(0, 15);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else args._.push(argv[i]);
  }
  return args;
}
const ARGS = parseArgs(process.argv.slice(2));
const CONCURRENCY = Number(ARGS.concurrency || 8);

/* ---------- 复用网页代码：配置解析 content.js、模型判断 ai.js ---------- */

fs.mkdirSync(DRAFTS, { recursive: true });
const store = new Map();
try { store.set('mw-cache-v4', fs.readFileSync(CACHE_FILE, 'utf8')); } catch { /* 第一次运行 */ }
global.window = global;
global.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
const saveCache = () => store.has('mw-cache-v4') && fs.writeFileSync(CACHE_FILE, store.get('mw-cache-v4'));

/* 限制并发；排队时间不算超时，所以把单次超时放宽。 */
const realFetch = fetch;
let active = 0;
const waiting = [];
global.fetch = async (url, opts) => {
  while (active >= CONCURRENCY) await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await realFetch(new URL(url, SERVER), opts);
  } finally {
    active--;
    const next = waiting.shift();
    if (next) next();
  }
};

const jsyaml = require(path.join(ROOT, 'js/vendor/js-yaml.min.js'));
global.jsyaml = jsyaml;
for (const f of ['js/content.js', 'js/ai.js']) vm.runInThisContext(read(f), { filename: f });
const AI = window.MW_AI;

function build(guestsText) {
  const cfg = jsyaml.load(read('config.yaml'));
  cfg.model = { ...(cfg.model || {}), timeout_ms: 120000 };
  return window.MW_BUILD(cfg, jsyaml.load(guestsText));
}

let C = build(read('guests.yaml'));
AI.setup(C);

const zh = (ids) => ids.map((id) => C.ATTR[id].pos).join('、');
const order = (ids) => C.ATTRS.map((a) => a.id).filter((id) => ids.includes(id));

function progress(label, done, total) {
  process.stdout.write(`\r${label} ${done}/${total}   `);
  if (done === total) process.stdout.write('\n');
}

async function mapProgress(label, items, fn) {
  let done = 0;
  progress(label, 0, items.length);
  return Promise.all(items.map(async (it) => {
    const r = await fn(it);
    progress(label, ++done, items.length);
    return r;
  }));
}

async function ensureOnline() {
  try {
    const r = await realFetch(new URL('/api/status', SERVER));
    const st = await r.json();
    if (st.online) return st.model;
  } catch { /* 下面统一报错 */ }
  console.error(`连不上模型：请先在 menwei/ 下运行 python3 server.py，并确认配置了 API Key（当前地址 ${SERVER}）`);
  process.exit(1);
}

/* 整体判断一次 + 指定特征逐个单问；ask 失败也按“说不准”处理，宁缺毋滥。 */
async function judge(name, ids) {
  const base = await AI.scan(name);
  if (!base.known) return { known: false };
  const answers = await Promise.all(ids.map((id) => AI.ask(name, id).catch(() => null)));
  const yes = [];
  const unsure = [];
  ids.forEach((id, i) => {
    if (answers[i] === null || answers[i] !== base.attrs[id]) unsure.push(id);
    else if (base.attrs[id]) yes.push(id);
  });
  return { known: true, emoji: base.emoji, attrs: base.attrs, yes, unsure };
}

/* ---------- guests.yaml 读写：每位熟客一行 ---------- */

const LINE_RE = /^- \{ name: (.+?), /;

function formatGuest(g) {
  const unsure = order(g.unsure || []);
  return `- { name: ${g.name}, emoji: ${g.emoji}, yes: [${order(g.yes || []).join(', ')}]${unsure.length ? `, unsure: [${unsure.join(', ')}]` : ''} }`;
}

function checkIds(ids, where) {
  const bad = (ids || []).filter((id) => !C.ATTR[id]);
  if (bad.length) throw new Error(`${where}：特征 ${bad.join('、')} 不在 config.yaml 里`);
}

function applyDraft(text, draft, file) {
  const lines = text.split('\n');
  const indexOf = new Map();
  lines.forEach((l, i) => {
    const m = l.match(LINE_RE);
    if (m) indexOf.set(m[1], i);
  });
  const res = { updated: 0, added: 0, skipped: [] };

  const attrs = (draft.attributes || []).map(String);
  checkIds(attrs, `${file} 的 attributes`);
  for (const u of draft.update || []) {
    const name = String(u.name);
    const i = indexOf.get(name);
    if (i === undefined) { res.skipped.push(`${name}（名单里没有）`); continue; }
    const yes = (u.yes || []).map(String);
    const unsure = (u.unsure || []).map(String);
    checkIds([...yes, ...unsure], `${file} 里的「${name}」`);
    const outside = [...yes, ...unsure].filter((id) => !attrs.includes(id));
    if (outside.length) throw new Error(`${file} 里的「${name}」用了 attributes 以外的特征：${outside.join('、')}`);
    const [old] = jsyaml.load(lines[i]);
    const keep = (list) => (list || []).map(String).filter((id) => !attrs.includes(id));
    lines[i] = formatGuest({
      name, emoji: old.emoji, yes: [...keep(old.yes), ...yes], unsure: [...keep(old.unsure), ...unsure],
    });
    res.updated++;
  }

  const added = [];
  for (const a of draft.add || []) {
    const name = String(a.name);
    if (indexOf.has(name) || added.some((x) => x.includes(`name: ${name},`))) { res.skipped.push(`${name}（已经在名单里）`); continue; }
    const g = { name, emoji: String(a.emoji || '🙂'), yes: (a.yes || []).map(String), unsure: (a.unsure || []).map(String) };
    checkIds([...g.yes, ...g.unsure], `${file} 里的「${name}」`);
    added.push(formatGuest(g));
  }
  if (added.length) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', `# ---------- 扩充 ${new Date().toLocaleDateString('sv-SE')}：模型生成、复核，人工审过 ----------`, ...added, '');
    res.added = added.length;
  }
  return { text: lines.join('\n'), ...res };
}

const loadDraft = (file) => jsyaml.load(read(file)) || {};

function writeDraft(kind, header, body) {
  const file = path.join(DRAFTS, `${kind}-${stamp()}.yaml`);
  const rel = path.relative(ROOT, file);
  const head = header.map((l) => `# ${l.replace('{本文件}', rel)}`.trimEnd());
  fs.writeFileSync(file, `${head.join('\n')}\n${body.join('\n')}\n`);
  return rel;
}

/* ---------- label：给已有熟客补标注 ---------- */

async function label() {
  const labeled = new Set(C.BANK.flatMap((g) => g.labeled));
  const ids = ARGS.attrs ? String(ARGS.attrs).split(',').map((s) => s.trim()).filter(Boolean)
    : C.ATTRS.filter((a) => !labeled.has(a.id)).map((a) => a.id);
  checkIds(ids, '--attrs');
  if (!ids.length) {
    console.log('所有特征都已经有熟客标注过了。要重新标某几个特征，用 --attrs 指定，例如 --attrs legs,wood');
    return;
  }
  const model = await ensureOnline();
  console.log(`给 ${C.BANK.length} 位熟客补标注：${ids.map((id) => `${id}(${C.ATTR[id].pos})`).join('、')}  · 模型 ${model}`);

  const rows = await mapProgress('复核中', C.BANK, async (g) => {
    try {
      const r = await judge(g.name, ids);
      return r.known ? { g, yes: r.yes, unsure: r.unsure } : { g, yes: [], unsure: ids, note: '模型说不认识' };
    } catch (e) {
      return { g, yes: [], unsure: ids, note: `判断失败：${e.message}` };
    }
  });

  const stats = ids.map((id) => {
    const y = rows.filter((r) => r.yes.includes(id)).length;
    const u = rows.filter((r) => r.unsure.includes(id)).length;
    return `#   ${C.ATTR[id].pos}：符合 ${y} 位 · 说不准 ${u} 位`;
  });
  const body = [
    ...stats,
    `attributes: [${ids.join(', ')}]`,
    'update:',
    ...rows.map(({ g, yes, unsure, note }) => {
      const parts = [`name: ${g.name}`];
      if (yes.length) parts.push(`yes: [${order(yes).join(', ')}]`);
      if (unsure.length) parts.push(`unsure: [${order(unsure).join(', ')}]`);
      const comment = [yes.length && `符合：${zh(order(yes))}`, unsure.length && `说不准：${zh(order(unsure))}`, note]
        .filter(Boolean).join('；') || '都不符合';
      return `  - { ${parts.join(', ')} }   # ${g.emoji} ${comment}`;
    }),
  ];
  const file = writeDraft('label', [
    `补标注草稿 · ${new Date().toLocaleString('zh-CN')} · node tools/grow.js label`,
    `给已有熟客补上这些特征：${ids.map((id) => `${id}=${C.ATTR[id].pos}`).join('、')}`,
    '判断方式：模型整体判断一次，再逐个特征单独问一次；两次一致才算数，不一致记为 unsure（说不准）。',
    '',
    '审核：逐行看 yes / unsure，改掉判错的。上面这几个特征里，没写进 yes 或 unsure 的，合并后一律算“不符合”。',
    '      拿不准的宁可放进 unsure，也别硬标：熟客的标注就是考题的标准答案。',
    `      改完运行：node tools/grow.js merge {本文件}`,
    '',
    '统计：',
  ], body);
  console.log(`草稿已写入 ${file}`);
}

/* ---------- gen：补缺的特征组合 ---------- */

const NAME_RE = /^[\p{Script=Han}A-Za-z0-9]+$/u;

/* 专门判断“是不是常见名词本身”。宁严勿松：会误拒一些固定叫法（高跟鞋、铁塔），但不放过“金戒指”这类加了前缀的。 */
const NOUN_SYSTEM = '你判断一个词是不是“常见名词本身”。固定叫法算（金鱼、大象、小提琴、白菜、电饭煲、消防员）；' +
  '在常见名词前面加了材质、颜色、大小、品牌、形容词来修饰的不算（金戒指、塑料椅子、大号书包、红色汽车、小狗狗）。' +
  '只输出一行 JSON：{"答案":true} 或 {"答案":false}';
const NOUN_SHOTS = [['金鱼', true], ['铁锅铲', false], ['热气球', true], ['木头勺子', false]];

async function plainNoun(name) {
  const messages = [{ role: 'system', content: NOUN_SYSTEM }];
  NOUN_SHOTS.forEach(([w, a]) => messages.push({ role: 'user', content: `词：${w}` }, { role: 'assistant', content: JSON.stringify({ 答案: a }) }));
  messages.push({ role: 'user', content: `词：${name}` });
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, temperature: 0, max_tokens: 20 }),
  });
  const data = await r.json();
  return /"答案"\s*:\s*true/.test(String(data.content || ''));
}

async function gen() {
  if (ARGS.after) {
    for (const f of String(ARGS.after).split(',')) C = build(applyDraft(read('guests.yaml'), loadDraft(f), f).text);
    AI.setup(C);
  }
  const model = await ensureOnline();
  const maxCombos = Number(ARGS.combos || 30);
  const per = Number(ARGS.per || 4);
  const pairTarget = Number(ARGS['pair-target'] || 5);
  const singleTarget = Number(ARGS['single-target'] || 8);
  const maxLen = Math.min(C.round.nameMaxLen, 6);
  /* 单个特征的熟客太少时，这个特征根本出不了规则，所以补满；两个特征的组合每次最多补 per 位。 */
  const cap = (gap) => (gap.ids.length === 1 ? gap.need : Math.min(per, gap.need));

  const labeled = new Set(C.BANK.flatMap((g) => g.labeled));
  const usable = C.ATTRS.filter((a) => a.enabled && labeled.has(a.id)).map((a) => a.id);
  const members = (ids) => C.BANK.filter((g) => ids.every((id) => g.attrs[id] && !g.unsure.has(id)));

  const gaps = [];
  for (const a of usable) {
    const n = members([a]).length;
    if (n < singleTarget) gaps.push({ ids: [a], have: n, need: singleTarget - n });
  }
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const ids = [usable[i], usable[j]];
      const n = members(ids).length;
      if (n < pairTarget) gaps.push({ ids, have: n, need: pairTarget - n });
    }
  }
  if (ARGS.focus) {
    const focus = String(ARGS.focus).split(',').map((s) => s.trim());
    checkIds(focus, '--focus');
    gaps.splice(0, gaps.length, ...gaps.filter((g) => g.ids.some((id) => focus.includes(id))));
  }
  console.log(`找到 ${gaps.length} 个缺口（单个特征少于 ${singleTarget} 位、两个特征同时符合少于 ${pairTarget} 位）· 模型 ${model}`);
  if (!gaps.length) return;

  /* 第一轮：每个缺口让模型现编一批；现实里几乎不存在的组合，模型会给空列表。 */
  const ask = (gap) => {
    const have = members(gap.ids).map((g) => g.name).slice(0, 20);
    return [
      { role: 'system', content: '你在帮一个猜谜游戏扩充题库。只输出一个 JSON 字符串数组，不要解释。' },
      {
        role: 'user',
        /* 别给模型“输出 []”的退路，它会动不动交白卷；不靠谱的候选交给后面的复核去挡。 */
        content: `列出 ${cap(gap) + 4} 个大家都熟悉的事物（东西、植物、动物、各种身份职业的人都可以），` +
          `每个都要同时满足下面所有条件：\n${gap.ids.map((id) => `- ${C.ATTR[id].pos}`).join('\n')}\n要求：\n` +
          `- 必须是常见的普通名词本身，不超过 ${maxLen} 个字；不要具体的人名、角色名、品牌名（要“医生”，不要“李白”）；\n` +
          '- 不要加形容词、材质、颜色这类前缀（要“戒指”不要“金戒指”，要“桌子”不要“木桌”）；\n' +
          `${have.length ? `- 不要包括：${have.join('、')}；\n` : ''}- 实在想不出来就少列几个。`,
      },
    ];
  };
  const proposals = await mapProgress('现编客人', gaps, async (gap) => {
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: ask(gap), temperature: 0.9, max_tokens: 200 }),
      });
      const data = await r.json();
      const m = String(data.content || '').match(/\[[\s\S]*\]/);
      const names = m ? JSON.parse(m[0]) : [];
      return { gap, names: [...new Set(names.map((s) => String(s).trim()))] };
    } catch {
      return { gap, names: [] };
    }
  });

  /* 第二轮：整体判断一遍，先筛掉明显不符合缺口的。 */
  const known = new Set(C.BANK.map((g) => g.name));
  /* 客人只要常见名词：带“的”的、或者只是给已有熟客加了前缀的（金戒指 → 戒指），都不要。 */
  const prefixed = (name) => [...known].some((k) => [...k].length >= 2 && name !== k && name.endsWith(k));
  const candidates = new Map();
  for (const { gap, names } of proposals) {
    for (const name of names) {
      if (!NAME_RE.test(name) || [...name].length > maxLen || known.has(name)) continue;
      if (name.includes('的') || prefixed(name)) continue;
      if (!candidates.has(name)) candidates.set(name, []);
      candidates.get(name).push(gap);
    }
  }
  const scanned = await mapProgress('初筛', [...candidates.keys()], async (name) => {
    try {
      const [noun, base] = await Promise.all([plainNoun(name), AI.scan(name)]);
      return { name, noun, base };
    } catch {
      return { name, base: null };
    }
  });
  const notNoun = scanned.filter((s) => s.base && !s.noun).map((s) => s.name);
  const hits = new Map();
  for (const { name, noun, base } of scanned) {
    if (!base || !base.known || !noun) continue;
    for (const gap of candidates.get(name)) {
      if (!gap.ids.every((id) => base.attrs[id])) continue;
      if (!hits.has(gap)) hits.set(gap, []);
      hits.get(gap).push(name);
    }
  }

  /* 第三轮：缺得最多的组合优先，每位候选逐个特征单问一遍。 */
  const chosen = [...hits.keys()].sort((a, b) => a.ids.length - b.ids.length || a.have - b.have).slice(0, maxCombos);
  const taken = new Set();
  const jobs = [];
  for (const gap of chosen) {
    const names = hits.get(gap).filter((n) => !taken.has(n)).slice(0, cap(gap) + 2);
    names.forEach((n) => taken.add(n));
    jobs.push(...names.map((name) => ({ gap, name })));
  }
  const allIds = C.ATTRS.map((a) => a.id);
  const judged = await mapProgress('逐项复核', jobs, async (job) => {
    try { return { ...job, r: await judge(job.name, allIds) }; } catch { return { ...job, r: null }; }
  });

  const body = ['add:'];
  let kept = 0;
  let dropped = 0;
  for (const gap of chosen) {
    const ok = judged.filter((j) => j.gap === gap && j.r && j.r.known && gap.ids.every((id) => j.r.yes.includes(id)))
      .slice(0, cap(gap));
    dropped += judged.filter((j) => j.gap === gap).length - ok.length;
    if (!ok.length) continue;
    body.push(`  # ${zh(gap.ids)}（名单里原有 ${gap.have} 位）`);
    for (const { name, r } of ok) {
      const parts = [`name: ${name}`, `emoji: ${r.emoji}`, `yes: [${order(r.yes).join(', ')}]`];
      if (r.unsure.length) parts.push(`unsure: [${order(r.unsure).join(', ')}]`);
      const comment = `${zh(order(r.yes)) || '都不符合'}${r.unsure.length ? `；说不准：${zh(order(r.unsure))}` : ''}`;
      body.push(`  - { ${parts.join(', ')} }   # ${comment}`);
      kept++;
    }
  }
  const skippedGaps = gaps.length - hits.size;
  const file = writeDraft('gen', [
    `新熟客草稿 · ${new Date().toLocaleString('zh-CN')} · node tools/grow.js gen`,
    '补的是名单里缺的特征组合：同时符合两个特征的熟客太少，“而且”规则就出不来；单个特征的熟客太少，规则也出不来。',
    '每位都经过：模型整体判断一次 + 每个特征单独问一次，两次不一致的特征记为 unsure（说不准）。',
    '',
    '审核：删掉不常见、有争议、和已有熟客几乎重复的；改掉判错的 yes / unsure。',
    '      没写进 yes 或 unsure 的特征一律算“不符合”，所以漏标的符合特征要补上。',
    `      改完运行：node tools/grow.js merge {本文件}`,
    '',
    `统计：${gaps.length} 个缺口，模型给不出合格候选的 ${skippedGaps} 个（多半现实里本来就少见）；`,
    `      收录 ${kept} 位，复核没通过丢掉 ${dropped} 位。`,
    `      不像常见名词、没收录的：${notNoun.join('、') || '无'}`,
  ], body);
  console.log(`草稿已写入 ${file}（收录 ${kept} 位）`);
}

/* ---------- add：人来提名，模型逐项标注 ---------- */

async function add() {
  const names = [...new Set(ARGS._.slice(1).join(',').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean))];
  if (!names.length) {
    console.error('用法：node tools/grow.js add 吉他,砧板,梯子');
    process.exit(1);
  }
  const model = await ensureOnline();
  const known = new Set(C.BANK.map((g) => g.name));
  const fresh = names.filter((n) => !known.has(n));
  if (fresh.length < names.length) console.log(`已经在名单里，跳过：${names.filter((n) => known.has(n)).join('、')}`);
  console.log(`给 ${fresh.length} 位提名客人逐项标注 · 模型 ${model}`);

  const allIds = C.ATTRS.map((a) => a.id);
  const rows = await mapProgress('逐项复核', fresh, async (name) => {
    try {
      const [noun, r] = await Promise.all([plainNoun(name), judge(name, allIds)]);
      return { name, noun, r };
    } catch (e) {
      return { name, err: e.message };
    }
  });
  const body = ['add:'];
  const rejected = [];
  for (const { name, noun, r, err } of rows) {
    if (err || !r.known) { rejected.push(`${name}（${err ? `判断失败：${err}` : '模型说不算客人'}）`); continue; }
    const parts = [`name: ${name}`, `emoji: ${r.emoji}`, `yes: [${order(r.yes).join(', ')}]`];
    if (r.unsure.length) parts.push(`unsure: [${order(r.unsure).join(', ')}]`);
    const notes = [zh(order(r.yes)) || '都不符合', r.unsure.length && `说不准：${zh(order(r.unsure))}`, !noun && '⚠️ 模型觉得不像常见名词'];
    body.push(`  - { ${parts.join(', ')} }   # ${notes.filter(Boolean).join('；')}`);
  }
  const file = writeDraft('add', [
    `提名客人草稿 · ${new Date().toLocaleString('zh-CN')} · node tools/grow.js add`,
    '每位都经过：模型整体判断一次 + 每个特征单独问一次，两次不一致的特征记为 unsure（说不准）。',
    '',
    '审核：改掉判错的 yes / unsure；没写进 yes 或 unsure 的特征一律算“不符合”。',
    '      改完运行：node tools/grow.js merge {本文件}',
    '',
    `没收录：${rejected.join('、') || '无'}`,
  ], body);
  console.log(`草稿已写入 ${file}（${body.length - 1} 位）`);
}

/* ---------- merge ---------- */

function merge() {
  const files = ARGS._.slice(1);
  if (!files.length) {
    console.error('用法：node tools/grow.js merge drafts/xxx.yaml [更多草稿]');
    process.exit(1);
  }
  const before = read('guests.yaml');
  let text = before;
  for (const f of files) {
    const r = applyDraft(text, loadDraft(f), f);
    text = r.text;
    console.log(`${f}：更新 ${r.updated} 位，新增 ${r.added} 位${r.skipped.length ? `，跳过 ${r.skipped.join('、')}` : ''}`);
  }
  build(text);
  const backup = path.join(DRAFTS, `guests.backup-${stamp()}.yaml`);
  fs.writeFileSync(backup, before);
  fs.writeFileSync(path.join(ROOT, 'guests.yaml'), text);
  console.log(`已写入 guests.yaml（原文件备份在 ${path.relative(ROOT, backup)}）`);
}

const COMMANDS = { label, gen, add, merge };
const cmd = COMMANDS[ARGS._[0]];
if (!cmd) {
  const doc = read('tools/grow.js').split('\n');
  console.log(doc.slice(2, doc.indexOf(' */')).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
  process.exit(ARGS._[0] ? 1 : 0);
}
Promise.resolve(cmd())
  .catch((e) => {
    console.error(`出错了：${e.message}`);
    process.exitCode = 1;
  })
  .finally(saveCache);
