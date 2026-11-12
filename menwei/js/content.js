(function () {
  'use strict';

  /* 由 config.yaml + guests.yaml 构建出游戏用到的全部内容。参数含义见 config.yaml 里的注释。 */

  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
      t = (t + 0x6d2b79f5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pickR = (rng, arr) => arr[Math.floor(rng() * arr.length)];
  function shuffleR(rng, arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const int = (v, name, min = 0) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) throw new Error(`config.yaml：${name} 应该是不小于 ${min} 的整数，现在是「${v}」`);
    return n;
  };
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`config.yaml：${name} 应该是数字，现在是「${v}」`);
    return n;
  };
  const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

  function parseEpoch(v) {
    const d = v instanceof Date ? v : new Date(String(v));
    if (Number.isNaN(d.getTime())) throw new Error(`config.yaml：rules.epoch 不是合法日期：「${v}」`);
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  function build(cfg, guestsRaw) {
    const warnings = [];
    if (!cfg || typeof cfg !== 'object') throw new Error('config.yaml 是空的');
    const R = cfg.round || {};
    const E = R.exam || {};
    const RU = cfg.rules || {};
    const B = RU.balance || {};

    const round = {
      examplesIn: int(R.examples?.in ?? 1, 'round.examples.in'),
      examplesOut: int(R.examples?.out ?? 1, 'round.examples.out'),
      coverEachTerm: R.examples?.cover_each_term !== false,
      probes: int(R.probes ?? 8, 'round.probes', 1),
      examSize: int(E.size ?? 5, 'round.exam.size', 1),
      examMinIn: int(E.min_in ?? 2, 'round.exam.min_in'),
      examMaxIn: int(E.max_in ?? 3, 'round.exam.max_in'),
      traps: int(E.traps ?? 2, 'round.exam.traps'),
      nameMaxLen: int(R.name_max_len ?? 8, 'round.name_max_len', 1),
    };
    if (round.examMinIn > round.examMaxIn) throw new Error('config.yaml：round.exam.min_in 不能大于 max_in');
    if (round.examMinIn > round.examSize) throw new Error('config.yaml：round.exam.min_in 不能大于 size');

    /* ---------- 特征 ---------- */

    const ATTRS = list(cfg.attributes).map((a, i) => {
      for (const k of ['id', 'name', 'yes', 'no', 'judge']) {
        if (!a || a[k] == null || a[k] === '') throw new Error(`config.yaml：attributes 第 ${i + 1} 项缺少 ${k}`);
      }
      return {
        id: String(a.id), key: String(a.name), pos: String(a.yes), neg: String(a.no),
        q: String(a.judge), enabled: a.enabled !== false,
      };
    });
    if (!ATTRS.length) throw new Error('config.yaml：attributes 至少要有一个特征');
    const dup = ATTRS.find((a, i) => ATTRS.findIndex((b) => b.id === a.id || b.key === a.key) !== i);
    if (dup) throw new Error(`config.yaml：特征 id 或 name 重复：${dup.id} / ${dup.key}`);
    const ATTR = Object.fromEntries(ATTRS.map((a) => [a.id, a]));

    /* ---------- 熟客 ---------- */

    const BANK = list(guestsRaw).map((g, i) => {
      if (!g || !g.name) throw new Error(`guests.yaml：第 ${i + 1} 位客人缺少 name`);
      const check = (ids) => list(ids).map(String).filter((id) => {
        if (ATTR[id]) return true;
        warnings.push(`guests.yaml：「${g.name}」用了不存在的特征「${id}」，已忽略`);
        return false;
      });
      const yes = new Set(check(g.yes));
      return {
        name: String(g.name),
        emoji: String(g.emoji || '🙂'),
        attrs: Object.fromEntries(ATTRS.map((a) => [a.id, yes.has(a.id)])),
        unsure: new Set(check(g.unsure)),
        labeled: [...yes, ...check(g.unsure)],
      };
    });
    const BANK_BY_NAME = new Map(BANK.map((it) => [it.name, it]));

    const labeled = new Set(BANK.flatMap((it) => it.labeled));
    const USABLE = ATTRS.filter((a) => {
      if (!a.enabled) return false;
      if (labeled.has(a.id)) return true;
      warnings.push(`特征「${a.key}」在 guests.yaml 里没有任何客人标注过，暂不用来出规则`);
      return false;
    }).map((a) => a.id);
    if (!USABLE.length) throw new Error('没有可以用来出规则的特征（都被关闭或没有标注）');

    /* ---------- 难度档 ---------- */

    const LEVELS = {};
    for (const [name, lv] of Object.entries(RU.levels || {})) {
      const ops = list(lv.ops).map(String);
      if (!ops.length || ops.some((o) => o !== 'and' && o !== 'or')) {
        throw new Error(`config.yaml：rules.levels.${name}.ops 只能填 and / or`);
      }
      const terms = Math.min(int(lv.terms, `rules.levels.${name}.terms`, 1), USABLE.length);
      LEVELS[name] = {
        id: name,
        label: String(lv.label || { easy: '简单', medium: '普通', hard: '困难' }[name] || name),
        terms,
        ops,
        maxNeg: int(lv.max_negations ?? 1, `rules.levels.${name}.max_negations`),
      };
    }
    if (!Object.keys(LEVELS).length) throw new Error('config.yaml：rules.levels 至少要有一个难度档');
    const levelOf = (name, where) => {
      if (!LEVELS[name]) throw new Error(`config.yaml：${where} 用了不存在的难度档「${name}」`);
      return LEVELS[name];
    };
    const WEEKLY = WEEKDAYS.map((d) => levelOf(String((RU.weekly || {})[d] ?? Object.keys(LEVELS)[0]), `rules.weekly.${d}`));
    const PRACTICE = list(RU.practice).map((n) => levelOf(String(n), 'rules.practice'));
    if (!PRACTICE.length) PRACTICE.push(...Object.values(LEVELS));

    const balance = {
      minIn: int(B.min_in ?? 4, 'rules.balance.min_in'),
      minOut: int(B.min_out ?? 4, 'rules.balance.min_out'),
      minRatio: num(B.min_ratio ?? 0.08, 'rules.balance.min_ratio'),
      maxRatio: num(B.max_ratio ?? 0.8, 'rules.balance.max_ratio'),
      minDisc: int(B.min_discriminating ?? 2, 'rules.balance.min_discriminating'),
    };
    const OR_COMBOS = list(RU.or_combos).map((c, i) => {
      const ids = list(c).map(String);
      if (ids.length < 2) throw new Error(`config.yaml：rules.or_combos 第 ${i + 1} 组至少要有两个特征`);
      const bad = ids.find((id) => !ATTR[id]);
      if (bad) throw new Error(`config.yaml：rules.or_combos 第 ${i + 1} 组用了不存在的特征「${bad}」`);
      return ids;
    }).filter((ids) => ids.every((id) => USABLE.includes(id)));
    for (const [name, lv] of Object.entries(LEVELS)) {
      if (lv.terms > 1 && lv.ops.includes('or') && !OR_COMBOS.some((c) => c.length === lv.terms)) {
        warnings.push(`难度档 ${name}：rules.or_combos 里没有 ${lv.terms} 个特征的组合，这一档不出“或者”规则`);
      }
    }
    const NO_REPEAT_DAYS = int(RU.no_repeat_days ?? 14, 'rules.no_repeat_days');
    const practiceNoRepeat = int(RU.practice_no_repeat ?? 8, 'rules.practice_no_repeat');
    const EPOCH = parseEpoch(RU.epoch ?? '2026-11-01');

    /* ---------- 规则：{ op: 'and' | 'or', terms: [{ id, neg }] } ---------- */

    const lit = (t, attrs) => !!attrs[t.id] !== t.neg;
    const evalRule = (rule, attrs) => (rule.op === 'or'
      ? rule.terms.some((t) => lit(t, attrs))
      : rule.terms.every((t) => lit(t, attrs)));
    const ruleAttrs = (rule) => rule.terms.map((t) => t.id);
    const ruleKey = (rule) => `${rule.op}:${rule.terms.map((t) => `${t.neg ? '!' : ''}${t.id}`).sort().join(',')}`;
    const decidable = (item, rule) => rule.terms.every((t) => !item.unsure.has(t.id));
    const de = (s) => (s.endsWith('的') ? s : `${s}的`);

    function ruleText(rule) {
      const ph = (t) => (t.neg ? ATTR[t.id].neg : ATTR[t.id].pos);
      const ts = rule.terms;
      if (ts.length === 1) return `${de(ph(ts[0]))}才能进`;
      if (rule.op === 'or') {
        const head = ts.slice(0, -1).map(ph).join('、');
        return `${head}或者${de(ph(ts[ts.length - 1]))}才能进`;
      }
      let s = ph(ts[0]);
      let sawNeg = ts[0].neg;
      ts.slice(1).forEach((t, i) => {
        const last = i === ts.length - 2;
        const join = t.neg ? (sawNeg ? '、也' : '、但') : '、而且';
        if (t.neg) sawNeg = true;
        s += join + (last ? de(ph(t)) : ph(t));
      });
      return `${s}才能进`;
    }

    /* 多特征规则：这位客人能戳穿“只看其中某一个特征”的猜法。 */
    const discriminates = (item, rule) => rule.terms.length > 1
      && rule.terms.some((t) => evalRule(rule, item.attrs) !== lit(t, item.attrs));

    function pickIds(rng, level, op) {
      if (op === 'and') return shuffleR(rng, USABLE).slice(0, level.terms);
      const combos = OR_COMBOS.filter((c) => c.length === level.terms);
      return combos.length ? shuffleR(rng, pickR(rng, combos)) : null;
    }

    /* 先定“而且”还是“或者”，再在这一类里抽，免得容易过平衡检查的那类挤掉另一类。 */
    function genRule(rng, level, avoid = new Set()) {
      const ops = level.terms === 1 ? ['and'] : shuffleR(rng, level.ops);
      for (const av of [avoid, new Set()]) {
        for (const op of ops) {
          const rule = tryRule(rng, level, op, av);
          if (rule) return rule;
        }
      }
      warnings.push('按当前参数抽不出满足平衡检查的规则，临时退回单特征规则');
      return { op: 'and', terms: [{ id: USABLE[0], neg: false }] };
    }

    function tryRule(rng, level, op, avoid) {
      for (let i = 0; i < 1500; i++) {
        const ids = pickIds(rng, level, op);
        if (!ids) return null;
        const maxNeg = op === 'or' ? 0 : Math.min(level.maxNeg, ids.length);
        const nNeg = Math.floor(rng() * (maxNeg + 1));
        const negSet = new Set(shuffleR(rng, ids).slice(0, nNeg));
        const terms = ids.map((id) => ({ id, neg: negSet.has(id) })).sort((a, b) => a.neg - b.neg);
        const rule = { op: ids.length === 1 ? 'and' : op, terms };
        if (avoid.has(ruleKey(rule))) continue;

        const dec = BANK.filter((it) => decidable(it, rule));
        const ins = dec.filter((it) => evalRule(rule, it.attrs)).length;
        const outs = dec.length - ins;
        if (ins < Math.max(balance.minIn, round.examplesIn + round.examMinIn)) continue;
        if (outs < Math.max(balance.minOut, round.examplesOut + round.examSize - round.examMaxIn)) continue;
        const ratio = ins / dec.length;
        if (ratio < balance.minRatio || ratio > balance.maxRatio) continue;
        if (terms.length > 1 && terms.some((t) =>
          dec.filter((it) => evalRule(rule, it.attrs) !== lit(t, it.attrs)).length < balance.minDisc)) continue;
        return rule;
      }
      return null;
    }

    function taker(rng, rule, exclude) {
      const dec = shuffleR(rng, BANK.filter((it) => decidable(it, rule) && !exclude.has(it.name)));
      const used = new Set();
      return (pred) => {
        const it = dec.find((x) => !used.has(x.name) && pred(x));
        if (it) used.add(it.name);
        return it;
      };
    }

    function genExamples(rng, rule) {
      const take = taker(rng, rule, new Set());
      const isIn = (it) => evalRule(rule, it.attrs);
      const out = [];
      if (round.coverEachTerm && rule.terms.length > 1) {
        /* 考题会给每个特征配陷阱，所以示范里每个特征也要先露一次脸，否则玩家无从猜起。 */
        for (const t of shuffleR(rng, rule.terms)) out.push(take((x) => lit(t, x.attrs) !== isIn(x)));
      }
      const count = (pass) => out.filter((x) => x && isIn(x) === pass).length;
      for (let i = count(true); i < round.examplesIn; i++) out.push(take(isIn));
      for (let i = count(false); i < round.examplesOut; i++) out.push(take((x) => !isIn(x)));
      return out.filter(Boolean).sort((a, b) => isIn(b) - isIn(a));
    }

    function genExam(rng, rule, exclude) {
      const take = taker(rng, rule, exclude);
      const isIn = (it) => evalRule(rule, it.attrs);
      const maxIn = Math.min(round.examMaxIn, round.examSize);
      const nIn = round.examMinIn + Math.floor(rng() * (maxIn - round.examMinIn + 1));
      const exam = [];
      let ins = 0;
      let outs = 0;
      const canTake = (x) => (isIn(x) ? ins < nIn : outs < round.examSize - nIn);
      const add = (it) => {
        if (!it) return;
        exam.push(it);
        if (isIn(it)) ins++; else outs++;
      };
      if (rule.terms.length > 1) {
        /* 每个特征各配一位：只看这一个特征来判，在他身上就会判错。 */
        for (const t of shuffleR(rng, rule.terms)) add(take((x) => lit(t, x.attrs) !== isIn(x) && canTake(x)));
        while (exam.length < round.traps) {
          const it = take((x) => discriminates(x, rule) && canTake(x));
          if (!it) break;
          add(it);
        }
      }
      while (exam.length < round.examSize) {
        const it = take(canTake) || take(() => true);
        if (!it) break;
        add(it);
      }
      return shuffleR(rng, exam);
    }

    /* ---------- 每日一局 ---------- */

    const dateOf = (no) => new Date(EPOCH.getFullYear(), EPOCH.getMonth(), EPOCH.getDate() + no - 1);
    const seedOf = (d) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    const dayNoOf = (d) => Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - EPOCH) / 86400000) + 1;

    /* 从开服日逐天往后推，保证同一天全服同题，且若干天内不重复规则。 */
    const dailyMemo = [];
    function daily(no) {
      for (let i = dailyMemo.length + 1; i <= no; i++) {
        const d = dateOf(i);
        const seed = seedOf(d);
        const rng = mulberry32(seed);
        const avoid = new Set(dailyMemo.slice(-NO_REPEAT_DAYS).map((x) => ruleKey(x.rule)));
        const rule = genRule(rng, WEEKLY[d.getDay()], avoid);
        dailyMemo.push({ no: i, seed, rule, examples: genExamples(rng, rule) });
      }
      return dailyMemo[no - 1];
    }

    /* levelId 指定难度档；不传或传了不存在的档，就从练习难度里随机抽。 */
    function practice(avoid = new Set(), levelId) {
      const seed = Math.floor(Math.random() * 1e9);
      const rng = mulberry32(seed);
      const level = LEVELS[levelId] || pickR(rng, PRACTICE);
      const rule = genRule(rng, level, avoid);
      return { no: null, seed, rule, level: level.id, examples: genExamples(rng, rule) };
    }

    /* ---------- 台词与评价 ---------- */

    const LINES = cfg.lines || {};
    function line(key, vars = {}) {
      const v = LINES[key];
      const s = Array.isArray(v) ? v[Math.floor(Math.random() * v.length)] : v;
      return String(s ?? '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    }

    const GRADES = list(cfg.grades).map((g, i) => ({
      maxProbes: int(g.max_probes, `grades 第 ${i + 1} 条 max_probes`),
      mark: String(g.mark || '🕶️'), title: String(g.title || ''), line: String(g.line || ''),
    }));
    const FAIL = { mark: '🚪', title: '', line: '', ...(cfg.fail || {}) };
    function grade(correct, total, probes) {
      if (correct < total) return FAIL;
      return GRADES.find((g) => probes <= g.maxProbes) || GRADES[GRADES.length - 1] || FAIL;
    }

    /* ---------- 计分 ---------- */

    const SC = cfg.scoring || {};
    const scoring = {
      correct: num(SC.correct ?? 90, 'scoring.correct'),
      probes: num(SC.probes_bonus ?? 6, 'scoring.probes_bonus'),
      time: num(SC.time_bonus ?? 4, 'scoring.time_bonus'),
      timeFull: num(SC.time_full ?? 30, 'scoring.time_full'),
      timeZero: num(SC.time_zero ?? 300, 'scoring.time_zero'),
      decimals: int(SC.decimals ?? 1, 'scoring.decimals'),
    };
    if (scoring.timeZero <= scoring.timeFull) throw new Error('config.yaml：scoring.time_zero 要大于 time_full');
    scoring.max = scoring.correct + scoring.probes + scoring.time;
    if (scoring.probes + scoring.time >= scoring.correct / round.examSize) {
      warnings.push('scoring：省烟奖励 + 速度奖励不小于判对一位的分数，又快又省可能压过多判对一位');
    }
    const roundTo = (x) => Number(x.toFixed(scoring.decimals));

    function score(correct, total, probesUsed, seconds) {
      const acc = total ? correct / total : 0;
      const saved = Math.max(0, round.probes - probesUsed) / round.probes;
      const speed = Math.min(1, Math.max(0, (scoring.timeZero - seconds) / (scoring.timeZero - scoring.timeFull)));
      const parts = {
        correct: roundTo(total ? (scoring.correct * correct) / total : 0),
        probes: roundTo(scoring.probes * saved * acc),
        time: roundTo(scoring.time * speed * acc),
      };
      return { ...parts, acc, total: roundTo(parts.correct + parts.probes + parts.time), max: scoring.max };
    }

    return {
      ATTRS, ATTR, BANK, BANK_BY_NAME, round, warnings, scoring, practiceNoRepeat,
      levels: PRACTICE.map((lv) => ({ id: lv.id, label: lv.label })),
      model: cfg.model || {},
      evalRule, ruleText, ruleAttrs, ruleKey, genExam, mulberry32, shuffleR, daily, practice, dayNoOf, line, grade, score,
    };
  }

  window.MW_BUILD = build;
})();
