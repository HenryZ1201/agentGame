(function () {
  'use strict';

  const C = window.ZZ_CONTENT;
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const clean = (s) => String(s || '').replace(/[\s，。！？、,.!?~…]+/g, '');

  /* ---------- 传输 ---------- */

  async function status() {
    try {
      const r = await fetch('/api/status');
      if (!r.ok) throw new Error();
      return await r.json();
    } catch {
      return { online: false, model: null };
    }
  }

  async function chat(messages, temperature, maxTokens, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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

  const withFewshot = (system, shots, user) => {
    const msgs = [{ role: 'system', content: system }];
    shots.forEach(([u, a]) => msgs.push({ role: 'user', content: u }, { role: 'assistant', content: a }));
    msgs.push({ role: 'user', content: user });
    return msgs;
  };

  /* ---------- 调用 A：判定 ---------- */

  const JUDGE_SYSTEM = [
    '你是生存游戏《自作自受》的裁判。玩家遇到一个危机，用一句话给出解法。判断解法属于哪一档：',
    '- 妙：巧妙具体，常常借力打力或利用场景物件，让人眼前一亮',
    '- 行：合理具体，能解决这个危机',
    '- 勉强：太笼统（如“逃跑”“报警”“求救”），或用了此时不太可能有的东西',
    '- 无效：没有回应这个危机，或答非所问',
    '- 作弊：超能力、魔法、做梦、时间倒流、凭空召唤神器或虚构角色',
    '普通人身上的常见物品（手机、钥匙、外套、钱包、零食）和场景物件都可以用。',
    '输出 JSON：{"verdict":"妙|行|勉强|无效|作弊","action":"解法的核心动作，1到2个字","why":"一句判词，不超过15字，语气一本正经"}',
    '只输出 JSON。',
  ].join('\n');

  const judgeUser = (crisis, items, solution) =>
    `【危机】${crisis}\n【场景物件】${items.join('、')}\n【解法】${solution}`;

  const JUDGE_SHOTS = [
    [judgeUser('你在树林里迷路，一只狼盯上了你', ['大树', '溪流', '野蜂窝'], '爬到大树上'),
      '{"verdict":"行","action":"爬","why":"狼在攀爬方面缺乏天赋"}'],
    [judgeUser('树上的松鼠认定你在偷松果，正朝你扔松果', ['树枝', '野蜂窝', '松果'], '用树枝捅野蜂窝'),
      '{"verdict":"妙","action":"捅","why":"借马蜂之手，驱逐松鼠"}'],
    [judgeUser('农家乐老板以为你是来偷鱼的，正冲你走来', ['渔网', '鱼塘', '拖鞋'], '赶紧跑'),
      '{"verdict":"勉强","action":"跑","why":"跑得了和尚，跑不了庙"}'],
    [judgeUser('一群马蜂正在追你', ['溪流', '泥巴', '树枝'], '我会飞'),
      '{"verdict":"作弊","action":"飞","why":"你不会飞，你只是跳了一下"}'],
  ];

  const judgeCache = new Map();

  function ruleJudge(solution, items) {
    const s = clean(solution);
    let verdict = '行';
    if (C.CHEAT_RE.test(s) || C.CHEAT_SOFT_RE.test(s)) verdict = '作弊';
    else if (C.VAGUE_RE.test(s)) verdict = '勉强';
    else if (s.length < 2) verdict = '无效';
    else if (items.some((it) => s.includes(it))) verdict = '妙';
    const action = s.replace(/^(我|先|赶紧|立刻|马上|快|用|把|拿)+/, '').slice(0, 1) || s.slice(0, 1);
    return { verdict, action, why: pick(C.RULE_WHY[verdict]) };
  }

  async function judge({ crisis, items, solution, online }) {
    const t0 = performance.now();
    const s = clean(solution);
    if (C.CHEAT_RE.test(s)) {
      return { result: { verdict: '作弊', action: '', why: pick(C.RULE_WHY.作弊) }, source: 'rule', latency: 0 };
    }
    if (!online) return { result: ruleJudge(solution, items), source: 'rule', latency: 0 };

    const key = `${crisis}|${s}`;
    if (judgeCache.has(key)) return { ...judgeCache.get(key), source: 'cache', latency: 0 };

    try {
      const res = await chat(withFewshot(JUDGE_SYSTEM, JUDGE_SHOTS, judgeUser(crisis, items, solution)), 0, 80);
      const o = extractJSON(res.content);
      if (!C.VERDICTS[o.verdict]) throw new Error(`非法 verdict：${o.verdict}`);
      const result = {
        verdict: o.verdict,
        action: clean(o.action).slice(0, 2),
        why: String(o.why || '').trim().slice(0, 20) || pick(C.RULE_WHY[o.verdict]),
      };
      const out = { result, raw: res.content, usage: res.usage };
      judgeCache.set(key, out);
      return { ...out, source: 'llm', latency: performance.now() - t0 };
    } catch (e) {
      return { result: ruleJudge(solution, items), source: 'fallback', error: e.message, latency: performance.now() - t0 };
    }
  }

  /* ---------- 调用 B：后果 ---------- */

  const CONSEQ_SYSTEM = [
    '你是生存游戏《自作自受》的旁白，语气像一本正经的自然纪录片解说。',
    '玩家刚用一个解法化解了危机，你要写出这个解法直接导致的下一个危机。规则：',
    '1. 玩家的解法成功了，不要否定它。',
    '2. 新危机必须由解法直接引起：从玩家的解法原文里挑一个词作为 hook，新危机里必须原样出现这个词。',
    '3. 新危机只能是解法的一跳直接结果：你碰到的东西坏了、洒了、卡住了，或在场的人、动物立刻对这个动作作出反应。',
    '4. 禁止再跳第二步，禁止写成「A导致B，于是引发C」。反例：领带勒太紧可以使人喘不上气，但缺氧不会启动消防喷淋。',
    '5. 可以尴尬、可以倒霉，但机制必须在现实中成立。严重程度变高，只是这一个直接结果波及更明显，不是另起一件事。',
    '6. 若有【因果链】，地点、在场的人和已经出现的东西都要接得上，不要跳到无关的新地点。',
    '7. 新危机必须能用一句话解决，不能宣布玩家死亡。',
    '8. next 是一句话，以“你”为视角，不超过35字。because 不超过16字，只解释这一跳。',
    '9. items 是此刻你够得着的3样东西，每样不超过4个字，优先沿用因果链里已经出现的物件。emoji 只用1个。',
    '输出 JSON：{"hook":"...","because":"...","next":"...","emoji":"...","items":["...","...","..."]}',
    '只输出 JSON。',
  ].join('\n');

  function formatChain(chain) {
    if (!chain || !chain.length) return '无，这是开局';
    const older = chain.slice(0, -6);
    const recent = chain.slice(-6);
    const lines = [];
    if (older.length) lines.push(`更早：${older.map((s) => s.solution).join(' → ')}`);
    recent.forEach((s, i) => lines.push(`${older.length + i + 1}. ${s.crisis} → ${s.solution}`));
    return lines.join('\n');
  }

  function conseqUser({ crisis, solution, card, severity, callbackWord, chain }) {
    const instr = card.instr.replace('{word}', callbackWord || '');
    let u = `【因果链】\n${formatChain(chain)}\n【刚才的危机】${crisis}\n【玩家的解法】${solution}\n【后果类型】${card.name}：${instr}\n【严重程度】${severity}/5，${C.SCALE[severity]}`;
    if (callbackWord) u += `\n【必须回归的元素】${callbackWord}，它必须出现在新危机里，并和当前现场接得上`;
    u += '\n只写一跳直接后果，不要再接第二件由别的原理触发的事。';
    return u;
  }

  const CONSEQ_SHOTS = [
    [conseqUser({ crisis: '你在树林里迷路，一只狼盯上了你', solution: '爬到大树上', card: C.CARDS[0], severity: 1 }),
      '{"hook":"大树","because":"人上了松鼠的树","next":"大树上住着一窝松鼠，它们认定你是来偷松果的，正集体朝你扔松果","emoji":"🐿️","items":["树枝","野蜂窝","松果"]}'],
    [conseqUser({
      chain: [{ crisis: '公园里一只大鹅盯上了你手里的面包', solution: '把面包扔进湖里' }],
      crisis: '全湖的鱼、鸭子和天鹅都游了过来，它们认定你身上还有面包',
      solution: '跳上长椅', card: C.CARDS[1], severity: 2,
    }),
      '{"hook":"长椅","because":"天鹅跟着挤上了椅","next":"长椅被挤上来的天鹅踩翻，你和它们一起栽回还漂着面包的湖里","emoji":"🦢","items":["湖水","面包袋","游船"]}'],
  ];

  const STOP_SUBSTR = new Set(['一个', '你的', '自己', '然后', '起来', '一下', '过来', '我的', '他们']);
  const STOP_CHARS = '你我他她它的了是在把用拿给被让一不上下来去着过和就也都很又再个这那里中到得地么吗呢吧啊';
  const DEATH_RE = /(死了|死亡|身亡|去世|丧命|尸体|没命|一命呜呼|游戏结束|你输了)/;
  const EMOJI_RE = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}\uFE0F?)*/u;

  /* 解法原文与新危机的最长公共子串，用来独立于模型自报的 hook 校验因果性 */
  function commonPhrase(a, b) {
    let best = '';
    for (let i = 0; i < a.length; i++) {
      for (let j = i + best.length + 1; j <= a.length; j++) {
        const sub = a.slice(i, j);
        if (!b.includes(sub)) break;
        if (!STOP_SUBSTR.has(sub) && !(sub.length === 1 && STOP_CHARS.includes(sub))) best = sub;
      }
    }
    return best;
  }

  function validateConseq(o, ctx) {
    const sol = clean(ctx.solution).replace(/^我/, '');
    const next = String(o.next || '').trim().replace(/[。！]$/, '');
    if (next.length < 6 || next.length > 45) throw new Error(`next 长度 ${next.length}`);
    if (DEATH_RE.test(next)) throw new Error('next 宣布了死亡');

    const because = String(o.because || '').trim();
    if (because.length < 4 || because.length > 24) throw new Error(`because 长度 ${because.length}`);

    let hook = clean(o.hook);
    const hookOk = hook && sol.includes(hook) && next.includes(hook);
    if (!hookOk) {
      const alt = commonPhrase(sol, next);
      if (!alt) throw new Error(`hook「${hook}」不成立，且新危机与解法无共同词`);
      hook = alt;
    }

    const emoji = (String(o.emoji || '').match(EMOJI_RE) || [pick(ctx.card.emoji)])[0];
    const items = [...new Set((Array.isArray(o.items) ? o.items : []).map(clean).filter((x) => x && x.length <= 6))];
    while (items.length < 3) {
      const g = pick(C.GENERIC_ITEMS);
      if (!items.includes(g)) items.push(g);
    }
    return { hook, because, next, emoji, items: items.slice(0, 3) };
  }

  function templateConseq(ctx) {
    const act = clean(ctx.solution).replace(/^我/, '');
    const next = pick(ctx.card.fallback)
      .replaceAll('{act}', act)
      .replaceAll('{critter}', pick(C.CRITTERS))
      .replaceAll('{word}', ctx.callbackWord || '老对手');
    const items = [];
    while (items.length < 3) {
      const g = pick(C.GENERIC_ITEMS);
      if (!items.includes(g)) items.push(g);
    }
    return { hook: act, next, emoji: pick(ctx.card.emoji), items };
  }

  const CAUSAL_SYSTEM = [
    '判断新危机是不是解法的直接结果，只看现实里的机制，不管好不好笑。',
    '成立：这个动作直接弄坏、弄脏、卡住或弄翻了身边的东西；或者在场的人、动物立刻对这个动作作出反应。',
    '不成立：中间还跳了一步，而且第二步的原理是错的。缺氧不能启动消防喷淋，说话不能引发地震，淋湿不能召唤雷电。',
    '输出 JSON：{"ok":true} 或 {"ok":false,"why":"不超过18字"}',
    '只输出 JSON。',
  ].join('\n');

  async function causalOk(ctx, next) {
    const user = `【刚才的危机】${ctx.crisis}\n【解法】${ctx.solution}\n【新危机】${next}`;
    const res = await chat([{ role: 'system', content: CAUSAL_SYSTEM }, { role: 'user', content: user }], 0, 80);
    const o = extractJSON(res.content);
    if (o.ok === true) return { ok: true };
    if (o.ok === false) return { ok: false, why: String(o.why || '这一跳接不上').trim().slice(0, 24) };
    throw new Error('因果校验没有 ok');
  }

  async function consequence(ctx) {
    const t0 = performance.now();
    if (!ctx.online) return { result: templateConseq(ctx), source: 'rule', latency: 0 };
    const errors = [];
    const raws = [];
    let reject = '';
    for (const temp of [0.8, 1.0]) {
      try {
        const user = conseqUser(ctx) + (reject ? `\n【上次不合格】${reject}。改成一跳就能发生的直接后果。` : '');
        const res = await chat(withFewshot(CONSEQ_SYSTEM, CONSEQ_SHOTS, user), temp, 180);
        raws.push(res.content);
        const result = validateConseq(extractJSON(res.content), ctx);
        let check = { ok: true };
        try {
          check = await causalOk(ctx, result.next);
        } catch (e) {
          errors.push(`校验失败，放行：${e.message}`);
        }
        if (!check.ok) {
          reject = check.why;
          errors.push(check.why);
          continue;
        }
        return { result, source: errors.length ? 'llm-retry' : 'llm', raw: raws.join('\n---\n'), errors, latency: performance.now() - t0 };
      } catch (e) {
        errors.push(e.message);
      }
    }
    return { result: templateConseq(ctx), source: 'fallback', raw: raws.join('\n---\n'), errors, latency: performance.now() - t0 };
  }

  /* ---------- 调用 C：结局故事 ---------- */

  const ENDING_SYSTEM = [
    '你是《自作自受》的说书人，语气一本正经。把这一局的因果链重写成一篇连贯的小故事。',
    '规则：',
    '1. 严格按给出的顺序写完整条链，不能只写最后一环。每一环都是上一环解法直接引起的，不要跳步。',
    '2. 每个解法至少留下两个连续的原字，不要换成别的动作，也不要添上链里没有的人物或事件。',
    '3. story 为 140 到 260 字，2 到 4 句，写成叙述，不要列清单，不要写“第几轮”。',
    '4. title 不超过 24 字。失败时像墓志铭，成功时像一句凯旋评语，都要扣住开局的事。',
    '5. 失败：故事停在最后那个没解开的危机上，人没有活下来。成功：故事在最后一个解法之后收住，人还活着。',
    '输出 JSON：{"title":"...","story":"..."}',
    '只输出 JSON。',
  ].join('\n');

  function chainLines(steps) {
    if (!steps.length) return '（还没有解开任何一环）';
    return steps.map((s, i) => `${i + 1}. ${s.crisis} → ${s.solution}`).join('\n');
  }

  function endingUser(ctx) {
    let u = `【开局】${ctx.first}\n【因果链】\n${chainLines(ctx.steps)}`;
    if (ctx.won) return `${u}\n【结局】八轮都解开了，闯关成功`;
    const attempt = ctx.lastTry && ctx.lastTry.solution ? `${ctx.lastTry.solution}（判定：${ctx.lastTry.verdict}）` : '没有再做出应对';
    return `${u}\n【最后一搏】${attempt}\n【倒在】${ctx.last}`;
  }

  function templateEnding(ctx) {
    const { won, subject, steps, last, lastTry } = ctx;
    const title = won ? `八轮未倒，${subject}也没能留下他` : (steps.length
      ? `倒在自己挖的坑里，起点是${subject}`
      : `面对${subject}，至死未动`);
    const parts = steps.map((s, i) => {
      const act = clean(s.solution).replace(/^我/, '') || '动手试了试';
      return i === 0 ? `事情要从「${s.crisis}」说起，他${act}` : `这又引出「${s.crisis}」，他${act}`;
    });
    if (won) parts.push('八桩麻烦连成一串，他居然还站着');
    else {
      const act = lastTry && lastTry.solution ? `最后他试图${clean(lastTry.solution)}` : '最后他没能再做出有效的应对';
      parts.push(`${act}，停在了「${last}」面前`);
    }
    return { title: title.slice(0, 24), story: `${parts.join('。')}。` };
  }

  function parseEnding(raw, steps) {
    const o = extractJSON(raw);
    const title = String(o.title || '').trim().replace(/\s+/g, '');
    const story = String(o.story || '').trim();
    if (title.length < 4 || title.length > 32) throw new Error(`title 长度 ${title.length}`);
    if (story.length < 40 || story.length > 500) throw new Error(`story 长度 ${story.length}`);
    const text = clean(story);
    const missed = (steps || []).filter((s) => {
      const act = clean(s.solution).replace(/^我/, '');
      if (act.length < 2) return false;
      for (let i = 0; i < act.length - 1; i++) {
        const sub = act.slice(i, i + 2);
        if (STOP_SUBSTR.has(sub) || [...sub].every((ch) => STOP_CHARS.includes(ch))) continue;
        if (text.includes(sub)) return false;
      }
      return true;
    }).map((s) => s.solution);
    if (missed.length) throw new Error(`故事漏了：${missed.join('、')}`);
    return { title, story };
  }

  async function ending(ctx) {
    const t0 = performance.now();
    if (!ctx.online) return { result: templateEnding(ctx), source: 'rule', latency: 0 };
    const errors = [];
    const raws = [];
    for (const temp of [0.7, 0.9]) {
      try {
        const res = await chat(
          [{ role: 'system', content: ENDING_SYSTEM }, { role: 'user', content: endingUser(ctx) }],
          temp, 700, 40000,
        );
        raws.push(res.content);
        const result = parseEnding(res.content, ctx.steps);
        return { result, source: errors.length ? 'llm-retry' : 'llm', raw: raws.join('\n---\n'), errors, latency: performance.now() - t0 };
      } catch (e) {
        errors.push(e.message);
      }
    }
    return { result: templateEnding(ctx), source: 'fallback', raw: raws.join('\n---\n'), errors, latency: performance.now() - t0 };
  }

  window.ZZ_AI = { status, judge, consequence, ending, commonPhrase, validateConseq };
})();
