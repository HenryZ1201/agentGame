(function () {
  'use strict';

  const ACTIONS = ['modify', 'redo', 'skip', 'stop', 'ask_first', 'undo', 'none'];

  const SYSTEM = [
    '你是游戏里“AI 实习生”的纠正理解模块。实习生正在替师傅在电脑上办事，师傅喊停并针对某一步说了一句话。',
    '你的任务：把师傅的话转换成一条 JSON 指令。只输出 JSON，不要任何解释。',
    '',
    '格式：{"action": "...", "field": "...", "value": "...", "confidence": 0.0}',
    '',
    'action 取值：',
    '- modify：把某个参数改成新值',
    '- redo：这一步换一个重新做（如换一家店）',
    '- skip：这一步不要做，跳过',
    '- stop：整个任务先停下',
    '- ask_first：先问师傅，经同意再做',
    '- undo：撤销这一步',
    '- none：师傅没有提出修改（如“没问题”“继续”）',
    '',
    'field：要修改的参数键名，只能从【可用参数】里选；师傅说的可能是之前步骤的参数，照实填写；不涉及参数时为 null。',
    'value：师傅给出的新值，简短提取（如“周六”“5位”“19:00”）；没给出新值时为 null。不要自己猜师傅没说的值。',
    'confidence：你对理解结果的把握，0 到 1。',
  ].join('\n');

  const FEWSHOT = [
    {
      u: '【可用参数】time=时间, people=人数\n【当前步骤】选时间（set_time），参数：time=19:00\n【师傅说】应该是七点半',
      a: '{"action":"modify","field":"time","value":"19:30","confidence":0.9}',
    },
    {
      u: '【可用参数】restaurant=餐厅\n【当前步骤】选餐厅（select_restaurant），参数：restaurant=海港大酒楼（人均¥320）\n【师傅说】太贵了换一家',
      a: '{"action":"redo","field":"restaurant","value":null,"confidence":0.85}',
    },
    {
      u: '【可用参数】to=发送对象, text=消息内容\n【当前步骤】发消息（send_message），参数：to=工作群；text=明天我请假\n【师傅说】这步没问题，继续',
      a: '{"action":"none","field":null,"value":null,"confidence":0.9}',
    },
  ];

  const fieldsLine = (fields) => Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(', ');
  const stepLine = (step, args) => {
    const a = Object.entries(args || {}).map(([k, v]) => `${k}=${v}`).join('；') || '无';
    return `${step.label}（${step.tool}），参数：${a}`;
  };
  const buildUser = (ctx) => `【可用参数】${fieldsLine(ctx.fields)}\n【当前步骤】${stepLine(ctx.step, ctx.args)}\n【师傅说】${ctx.text}`;

  function extractJSON(raw) {
    let s = String(raw || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('模型输出里没有 JSON');
    return JSON.parse(m[0]);
  }

  function sanitize(obj, fields) {
    const action = ACTIONS.includes(obj.action) ? obj.action : 'none';
    const field = typeof obj.field === 'string' && fields[obj.field] ? obj.field : null;
    const rawValue = obj.value == null ? '' : String(obj.value).trim();
    const value = rawValue && rawValue !== 'null' ? rawValue : null;
    let confidence = Number(obj.confidence);
    if (!Number.isFinite(confidence)) confidence = 0.7;
    confidence = Math.max(0, Math.min(1, confidence));
    return { action, field, value, confidence };
  }

  async function llmRequest(ctx, cfg) {
    const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const messages = [{ role: 'system', content: SYSTEM }];
    FEWSHOT.forEach((f) => {
      messages.push({ role: 'user', content: f.u });
      messages.push({ role: 'assistant', content: f.a });
    });
    messages.push({ role: 'user', content: buildUser(ctx) + (cfg.noThink ? ' /no_think' : '') });

    const body = { model: cfg.model, messages, temperature: 0, max_tokens: 200, stream: false };
    if (cfg.jsonMode) body.response_format = { type: 'json_object' };
    if (cfg.disableThinkingParam) body.enable_thinking = false;

    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs || 10000);
    try {
      const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const data = await resp.json();
      return { raw: data.choices?.[0]?.message?.content ?? '', usage: data.usage || null };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- 离线规则兜底 ---------- */

  const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  function cnToNum(s) {
    if (/^\d+$/.test(s)) return Number(s);
    if (s.length === 1) return CN_NUM[s] ?? NaN;
    if (s[0] === '十') return 10 + (CN_NUM[s[1]] || 0);
    if (s[1] === '十') return (CN_NUM[s[0]] || 1) * 10 + (CN_NUM[s[2]] || 0);
    return NaN;
  }
  const normDay = (v) => v.replace(/星期|礼拜/, '周').replace('周天', '周日');

  function pickCandidate(text, regex, isCurrent) {
    const re = new RegExp(regex.source, 'g');
    const cands = [];
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 3), m.index);
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 3);
      cands.push({ v: m[0], negated: /不是|而非|不要|别/.test(before) || /不对|错|不行/.test(after) });
    }
    if (!cands.length) return null;
    if (cands.every((c) => c.negated)) return { v: null, negatedOnly: true };
    const good = cands.filter((c) => !c.negated && !isCurrent(c.v));
    return { v: (good.length ? good[good.length - 1] : cands[cands.length - 1]).v, negatedOnly: false };
  }

  function ruleParse(ctx) {
    const t = ctx.text.replace(/\s+/g, '');
    const cur = Object.values(ctx.args || {}).join(' ');
    const R = (action, field = null, value = null, confidence = 0.8) => ({ action, field, value, confidence });
    const wantsChange = /不对|错|改|换|别|停|不是|不要|取消/.test(t);

    if (/没问题|没错|对的|继续|可以/.test(t) && !wantsChange) return R('none', null, null, 0.9);
    if (/先问|问我|问一下我|经过我|我同意|确认一下/.test(t)) return R('ask_first');
    if (/撤销|撤回/.test(t)) return R('undo');
    if (/跳过/.test(t)) return R('skip');

    const day = pickCandidate(t, /(周|星期|礼拜)[一二三四五六日天]|\d{1,2}[号日]/, (v) => cur.includes(normDay(v)));
    if (day) return day.negatedOnly ? R('modify', 'date', null, 0.6) : R('modify', 'date', normDay(day.v));

    const ppl = pickCandidate(t, /(\d+|[一二两三四五六七八九十]+)(个人|位|人)/, (v) => cur.includes(v));
    if (ppl?.negatedOnly) return R('modify', 'people', null, 0.6);
    if (ppl) {
      const n = cnToNum(ppl.v.match(/^(\d+|[一二两三四五六七八九十]+)/)[1]);
      if (Number.isFinite(n)) return R('modify', 'people', `${n}位`);
    }

    const tm = pickCandidate(t, /(\d{1,2}|[一二两三四五六七八九十]+)(点半|点|[:：]\d{2})/, () => false);
    if (tm?.negatedOnly) return R('modify', 'time', null, 0.6);
    if (tm) {
      const hm = tm.v.match(/^(\d{1,2}|[一二两三四五六七八九十]+)(点半|点|[:：](\d{2}))/);
      let h = cnToNum(hm[1]);
      const min = hm[2] === '点半' ? '30' : (hm[3] || '00');
      if (Number.isFinite(h)) {
        if (h < 12 && (/晚|下午|傍晚/.test(t) || h <= 9)) h += 12;
        return R('modify', 'time', `${String(h).padStart(2, '0')}:${min}`);
      }
    }

    if (/换一家|换家|换个店|换个餐厅|别的店|不要这家|太贵/.test(t)) return R('redo', 'restaurant');

    const groups = t.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,8}群/g);
    if (groups && /群/.test(t)) {
      const g = groups
        .map((x) => x.replace(/^(应该)?(是)?(发到|发给|发去|发|到|去)/, ''))
        .filter((x) => x.length > 1 && !/错|这个|那个/.test(x))
        .pop();
      if (g) return R('modify', 'to', g);
    }

    if (/(别|不要|先别)(发|订|付|下单|提交)|停下|停止|取消|住手|打住|先停/.test(t)) return R('stop');

    const fieldWords = [
      ['date', /日期|哪天|几号/],
      ['time', /时间|几点/],
      ['people', /人数|几个人/],
      ['restaurant', /餐厅|店/],
      ['to', /发错|收件人|发给/],
    ];
    const hit = fieldWords.find(([, re]) => re.test(t));
    if (hit) return R('modify', hit[0], null, 0.6);
    if (/不对|错了|有问题/.test(t)) return R('modify', null, null, 0.4);
    return R('none', null, null, 0.3);
  }

  async function parse(ctx, cfg) {
    const t0 = performance.now();
    if (cfg.mode === 'llm') {
      try {
        const { raw, usage } = await llmRequest(ctx, cfg);
        const result = sanitize(extractJSON(raw), ctx.fields);
        return { result, source: 'llm', latency: performance.now() - t0, raw, usage };
      } catch (err) {
        return {
          result: ruleParse(ctx),
          source: 'rule-fallback',
          latency: performance.now() - t0,
          error: err.name === 'AbortError' ? '请求超时' : err.message,
        };
      }
    }
    return { result: ruleParse(ctx), source: 'rule', latency: performance.now() - t0 };
  }

  window.CorrectionParser = { parse, ruleParse, buildUser, SYSTEM };
})();
