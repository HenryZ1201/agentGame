(function () {
  'use strict';

  const AI = window.MW_AI;
  let C = null;
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const MEASURE_RE = /^(一|两|这|那)?(只|个|位|台|辆|条|头|把|杯|瓶|双|顶|块|本|部|架|棵|朵|张|件|支|根|颗)/;

  let online = false;
  let S = null;

  /* ---------- 工具 ---------- */

  const todayNo = () => Math.max(1, C.dayNoOf(new Date()));
  const dailyKey = (no) => `mw-daily-${no}`;

  function normalize(raw) {
    let s = String(raw || '').replace(/[\s，。！？、,.!?~…'"“”‘’：:；;（）()【】\[\]]+/g, '');
    s = s.replace(MEASURE_RE, '');
    return [...s].slice(0, C.round.nameMaxLen).join('');
  }

  const resetCounter = () => { $('counter').textContent = `0/${C.round.nameMaxLen}`; };

  async function loadConfig() {
    const read = async (file) => {
      const r = await fetch(file, { cache: 'no-store' });
      if (!r.ok) throw new Error(`读不到 ${file}（HTTP ${r.status}）`);
      try {
        return window.jsyaml.load(await r.text());
      } catch (e) {
        const where = e.mark ? `第 ${e.mark.line + 1} 行第 ${e.mark.column + 1} 列附近` : '';
        throw new Error(`${file} ${where}格式有误（常见原因：缩进没对齐、冒号后少了空格）。\n原始提示：${e.reason || e.message}`);
      }
    };
    const [cfg, guests] = await Promise.all([read('config.yaml'), read('guests.yaml')]);
    return window.MW_BUILD(cfg, guests);
  }

  function log(msg, cls = '') {
    const el = document.createElement('div');
    el.className = `log ${cls}`;
    el.textContent = msg;
    $('debug-log').prepend(el);
  }

  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  }

  /* ---------- 开局 ---------- */

  const RECENT_KEY = 'mw-practice-recent';
  const LEVEL_KEY = 'mw-practice-level';

  /* 练习难度。random 表示从配置的练习难度里抽；选过的会记住。 */
  function practiceLevelId() {
    let id = 'random';
    try { id = localStorage.getItem(LEVEL_KEY) || 'random'; } catch { /* 忽略 */ }
    if (id !== 'random' && !(C.levels || []).some((l) => l.id === id)) id = 'random';
    return id;
  }
  const levelById = (id) => (C.levels || []).find((l) => l.id === id) || null;

  /* 练习避开最近练过的规则和今晚的每日题。 */
  function practiceRound(no) {
    let recent = [];
    try { recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { /* 忽略 */ }
    const n = C.practiceNoRepeat;
    recent = n ? recent.slice(-n) : [];
    const id = practiceLevelId();
    const p = C.practice(new Set([...recent, C.ruleKey(C.daily(no).rule)]), id === 'random' ? null : id);
    recent = n ? [...recent, C.ruleKey(p.rule)].slice(-n) : [];
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    return p;
  }

  function newGame(daily) {
    const no = todayNo();
    const round = daily ? C.daily(no) : practiceRound(no);
    const { seed, rule, examples: ex } = round;
    const examples = ex.filter(Boolean);

    S = {
      daily, no, seed, rule, examples,
      probes: [], exam: [], examIdx: 0, answers: [],
      phase: 'probe', busy: false,
      clock: { used: 0, since: null },
      seen: new Map(examples.map((e) => [e.name, C.evalRule(rule, e.attrs)])),
    };

    const label = levelById(round.level)?.label;
    $('hud-title').textContent = daily ? `今晚交班 #${no}` : `练习一局 · ${label}`;
    $('debug-rule').textContent = C.ruleText(rule);
    $('wall-in').innerHTML = '';
    $('wall-out').innerHTML = '';
    $('probe-zone').hidden = false;
    $('exam-zone').hidden = true;
    $('probe').value = '';
    resetCounter();
    showJudge(null);
    renderProbes();
    startTimer();
    show('screen-game');
    log(`新局 ${daily ? '每日' : `练习 ${label}`} seed=${seed} 规则=${C.ruleText(rule)}`);
    intro();
  }

  /* 老K 当面示范：放进一位、拦下一位，然后点烟。 */
  async function intro() {
    const game = S;
    game.busy = true;
    lockInput(true);
    $('bouncer-face').classList.remove('thinking');
    for (const e of game.examples) {
      const pass = C.evalRule(game.rule, e.attrs);
      setGuest(e.emoji, e.name);
      setStamp(null);
      say('……');
      await sleep(600);
      if (S !== game) return;
      setStamp(pass);
      say(C.line(pass ? 'show_in' : 'show_out'));
      addChip(pass, e, 'example');
      await sleep(1300);
      if (S !== game) return;
    }
    setGuest('🧍', '等你领人过来');
    setStamp(null);
    say(C.line('briefing', { n: C.round.probes }));
    game.busy = false;
    lockInput(false);
    $('probe').focus();
  }

  /* ---------- 渲染 ---------- */

  function renderProbes() {
    const used = S.probes.length;
    $('probes').innerHTML = `<span class="probe-label">🚬 还能领</span>` + Array.from({ length: C.round.probes }, (_, i) =>
      `<i class="${i < used ? 'used' : ''}"></i>`).join('') + `<span class="probe-left">${C.round.probes - used}</span>`;
    $('btn-exam').disabled = S.phase !== 'probe';
    renderBonus();
  }

  function say(text) {
    const b = $('bubble');
    b.textContent = text;
    b.classList.remove('pop');
    void b.offsetWidth;
    b.classList.add('pop');
  }

  function setGuest(emoji, name) {
    const g = $('guest');
    $('guest-emoji').textContent = emoji;
    $('guest-name').textContent = name;
    g.classList.remove('enter');
    void g.offsetWidth;
    g.classList.add('enter');
  }

  function setStamp(pass, wrong = false) {
    const s = $('stamp');
    s.className = 'stamp';
    if (pass === null) return;
    s.textContent = pass ? '进' : '不进';
    void s.offsetWidth;
    s.classList.add('show', pass ? 'in' : 'out');
    if (wrong) s.classList.add('wrong');
    const door = $('door');
    door.classList.remove('flash-in', 'flash-out');
    void door.offsetWidth;
    door.classList.add(pass ? 'flash-in' : 'flash-out');
  }

  function addChip(pass, item, kind = '') {
    const chip = document.createElement('span');
    chip.className = `chip new ${kind}`;
    chip.innerHTML = `<em>${item.emoji}</em>${item.name}`;
    if (kind === 'example') chip.title = '老K 示范的';
    if (kind.includes('exam')) chip.title = kind.includes('wrong') ? '你判错了' : '你判对了';
    $(pass ? 'wall-in' : 'wall-out').appendChild(chip);
    setTimeout(() => chip.classList.remove('new'), 600);
  }

  /* 计时只走玩家能操作的时间：等模型、播动画、老K 说话时输入被锁，表就停。 */
  let timerHandle = null;

  function elapsedMs() {
    const c = S.clock;
    return c.used + (c.since !== null ? performance.now() - c.since : 0);
  }

  /* 现在还能拿到的奖励：还没判的都按会判对来算，所以判错或继续耗时，数字会往下掉。 */
  function bonusNow() {
    const total = C.round.examSize;
    const correct = S.answers.filter((a) => a.ok).length;
    const potential = correct + (total - S.answers.length);
    return C.score(potential, total, S.probes.length, elapsedMs() / 1000);
  }

  function renderBonus() {
    if (!S) return;
    const sc = bonusNow();
    const paint = (id, pts) => {
      const el = $(id);
      el.textContent = `+${fmtScore(pts)}`;
      el.classList.toggle('zero', pts <= 0);
    };
    paint('time-bonus', sc.time);
    paint('probe-bonus', sc.probes);
  }

  function renderTimer() {
    if (!S) return;
    const left = Math.max(0, C.scoring.timeZero - elapsedMs() / 1000);
    const sec = Math.ceil(left);
    const el = $('timer');
    el.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    el.classList.toggle('paused', S.phase !== 'over' && S.clock.since === null);
    el.classList.toggle('low', sec > 0 && sec <= 60);
    el.classList.toggle('out', sec === 0);
    renderBonus();
  }

  function startTimer() {
    if (timerHandle) clearInterval(timerHandle);
    renderTimer();
    timerHandle = setInterval(renderTimer, 250);
  }

  function stopTimer() {
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = null;
  }

  function clock(run) {
    const c = S.clock;
    if (run && c.since === null) c.since = performance.now();
    if (!run && c.since !== null) {
      c.used += performance.now() - c.since;
      c.since = null;
    }
  }

  function lockInput(on) {
    clock(!on && S.phase !== 'over');
    $('probe').disabled = on;
    $('btn-knock').disabled = on;
    $('btn-exam').disabled = on || S.phase !== 'probe';
    $('btn-let').disabled = on;
    $('btn-deny').disabled = on;
    $('bouncer-face').classList.toggle('thinking', on && S.phase === 'probe');
  }

  /* ---------- 试探 ---------- */

  async function lookup(name) {
    const bank = C.BANK_BY_NAME.get(name);
    const sure = bank && C.ruleAttrs(S.rule).every((id) => !bank.unsure.has(id));
    if (sure) return { known: true, emoji: bank.emoji, attrs: bank.attrs, source: '名单' };
    if (online) {
      try {
        const r = await AI.classify(name, C.ruleAttrs(S.rule), log);
        return { ...r, emoji: bank ? bank.emoji : r.emoji, source: '模型' };
      } catch { /* 落到名单 */ }
    }
    if (bank) return { known: true, emoji: bank.emoji, attrs: bank.attrs, source: '名单' };
    return null;
  }

  async function knock(raw) {
    if (S.busy || S.phase !== 'probe') return;
    const name = normalize(raw);
    if (!name) return;
    $('probe').value = '';
    resetCounter();

    if (name.includes('的') && !name.startsWith('的') && !C.BANK_BY_NAME.has(name)) {
      setGuest('🫥', name);
      setStamp(null);
      say(C.line('modifier', { name }));
      return;
    }

    if (S.seen.has(name)) {
      const pass = S.seen.get(name);
      const prev = S.probes.find((p) => p.name === name) || S.examples.find((e) => e.name === name);
      setGuest(prev ? prev.emoji : '🙂', name);
      setStamp(pass);
      say(C.line('again', { name }));
      return;
    }

    S.busy = true;
    lockInput(true);
    setGuest('❔', name);
    setStamp(null);
    say('……');
    const [res] = await Promise.all([lookup(name), sleep(500)]);
    S.busy = false;
    lockInput(false);

    if (!res) {
      const tips = C.shuffleR(Math.random, C.BANK).slice(0, 3).map((b) => b.name).join('、');
      say(`${C.line('offline', { name })}队伍里有：${tips}`);
      setGuest('🤷', name);
      $('probe').focus();
      return;
    }
    if (!res.known) {
      say(C.line('unknown', { name }));
      setGuest('🫥', name);
      $('probe').focus();
      return;
    }
    if (res.unsure && res.unsure.length) {
      say(C.line('unsure', { name }));
      setGuest('🤔', name);
      $('probe').focus();
      return;
    }

    const pass = C.evalRule(S.rule, res.attrs);
    const probe = { name, emoji: res.emoji, attrs: res.attrs, pass, source: res.source };
    S.probes.push(probe);
    S.seen.set(name, pass);
    setGuest(res.emoji, name);
    setStamp(pass);
    say(C.line(pass ? 'in' : 'out', { name }));
    addChip(pass, probe);
    renderProbes();

    if (S.probes.length >= C.round.probes) {
      lockInput(true);
      await sleep(1300);
      say(C.line('smoke_out'));
      await sleep(900);
      startExam();
    } else {
      $('probe').focus();
    }
  }

  /* ---------- 考试 ---------- */

  function startExam() {
    S.phase = 'exam';
    const rng = C.mulberry32((S.seed ^ 0x9e3779b9) >>> 0);
    S.exam = C.genExam(rng, S.rule, new Set(S.seen.keys()));
    S.examIdx = 0;
    $('probe-zone').hidden = true;
    $('exam-zone').hidden = false;
    renderProbes();
    say(C.line('exam_intro', { n: S.exam.length }));
    log(`考试：${S.exam.map((e) => `${e.name}${C.evalRule(S.rule, e.attrs) ? '进' : '不进'}`).join(' / ')}`);
    showExamGuest();
  }

  function showExamGuest() {
    const it = S.exam[S.examIdx];
    setGuest(it.emoji, it.name);
    setStamp(null);
    showJudge(null);
    $('exam-progress').textContent = `最后 ${S.exam.length} 位客人 · 第 ${S.examIdx + 1} 位：放不放？`;
    renderTally();
    lockInput(false);
  }

  function renderTally() {
    const done = S.answers.map((a) => (a.ok ? '✅' : '❌')).join('');
    const rest = '⬜'.repeat(Math.max(0, S.exam.length - S.answers.length));
    const right = S.answers.filter((a) => a.ok).length;
    $('tally').innerHTML = `${done}${rest}<b>对 ${right} · 错 ${S.answers.length - right}</b>`;
  }

  function showJudge(a) {
    const el = $('judge');
    el.className = 'judge';
    if (!a) return;
    const v = (pass) => (pass ? '进' : '不进');
    el.innerHTML = a.ok
      ? '<b>✅ 判对了</b>'
      : `<b>❌ 判错了</b><small>你判「${v(a.guess)}」，老K：「${v(a.truth)}」</small>`;
    void el.offsetWidth;
    el.classList.add('show', a.ok ? 'right' : 'wrong');
  }

  async function answer(letIn) {
    if (S.busy || S.phase !== 'exam') return;
    S.busy = true;
    lockInput(true);
    const it = S.exam[S.examIdx];
    const truth = C.evalRule(S.rule, it.attrs);
    const ok = letIn === truth;
    const a = { item: it, truth, ok, guess: letIn };
    S.answers.push(a);
    renderBonus();
    setStamp(truth);
    showJudge(a);
    renderTally();
    say(C.line(`${ok ? 'right' : 'wrong'}_${truth ? 'in' : 'out'}`, { name: it.name }));
    addChip(truth, it, ok ? 'exam' : 'exam wrong');
    await sleep(ok ? 1100 : 2200);
    S.busy = false;
    S.examIdx++;
    if (S.examIdx < S.exam.length) showExamGuest();
    else finish();
  }

  /* ---------- 结算 ---------- */

  function squares() {
    return S.answers.map((a) => (a.ok ? '🟩' : '🟥')).join('');
  }

  const fmtScore = (n) => n.toFixed(C.scoring.decimals);
  const fmtTime = (sec) => {
    const s = Math.round(sec);
    return s >= 60 ? `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒` : `${s} 秒`;
  };

  function finish() {
    clock(false);
    stopTimer();
    S.phase = 'over';
    const correct = S.answers.filter((a) => a.ok).length;
    const total = S.answers.length;
    const t = C.grade(correct, total, S.probes.length);
    S.seconds = S.clock.used / 1000;
    S.score = C.score(correct, total, S.probes.length, S.seconds);

    if (S.daily && !localStorage.getItem(dailyKey(S.no))) {
      localStorage.setItem(dailyKey(S.no), JSON.stringify({
        probes: S.probes.length, squares: squares(), correct, total,
        score: S.score.total, seconds: Math.round(S.seconds),
      }));
    }
    log(`计分 用时=${S.seconds.toFixed(1)}s ${JSON.stringify(S.score)}`);

    $('over-mark').textContent = t.mark;
    $('over-title').textContent = t.title;
    $('over-line').textContent = t.line;
    $('screen-over').classList.toggle('won', correct === total);
    $('score').innerHTML = `<b>${fmtScore(S.score.total)}</b><span>/ ${fmtScore(S.score.max)} 分</span>`;
    $('rule-reveal').textContent = `「${C.ruleText(S.rule)}」`;
    $('squares').textContent = squares();
    renderScore(correct, total);
    renderEyes();
    $('toast').textContent = '';
    show('screen-over');
  }

  function renderScore(correct, total) {
    const sc = S.score;
    const row = (name, detail, pts, plus) =>
      `<div><span>${name}</span><i>${detail}</i><b>${plus ? '+' : ''}${fmtScore(pts)}</b></div>`;
    const note = sc.acc < 1
      ? `<p class="score-note">没全对，两项奖励按判对比例 ${Math.round(sc.acc * 100)}% 折算</p>`
      : '';
    $('stats').innerHTML = row('判对', `${correct}/${total} 位`, sc.correct, false) +
      row('省烟', `领了 ${S.probes.length}/${C.round.probes} 位`, sc.probes, true) +
      row('速度', `用时 ${fmtTime(S.seconds)}`, sc.time, true) + note;
  }

  /* 每种标记只表达一件事：灰字 = 客人的特征，绿/红 = 老K 放不放，✅/❌ = 你判得对不对。 */
  function renderEyes() {
    const ids = C.ruleAttrs(S.rule);
    const verdict = (pass) => `<span class="v ${pass ? 'in' : 'out'}">${pass ? '进' : '不进'}</span>`;
    const row = (it, extra = '') => {
      const feat = ids.map((id) => (it.attrs[id] ? C.ATTR[id].pos : C.ATTR[id].neg)).join(' · ');
      return `<div class="eye"><em>${it.emoji}</em><b>${it.name}</b><span class="feat">${feat}</span>` +
        `${verdict(C.evalRule(S.rule, it.attrs))}${extra}</div>`;
    };
    const group = (cls, title, note, head, rows) => (rows.length
      ? `<section class="eye-group ${cls}"><h5>${title}<i>${note}</i></h5>${head}${rows.join('')}</section>`
      : '');
    const correct = S.answers.filter((a) => a.ok).length;
    const examHead = '<div class="eye head"><em></em><b></b><span class="feat"></span><span class="v">老K</span><span class="you">你</span></div>';
    const yours = (a) => `<span class="you">${a.guess ? '进' : '不进'} ${a.ok ? '✅' : '❌'}</span>`;

    $('eyes').innerHTML = [
      group('', '🎁 老K 示范的', '', '', S.examples.map((e) => row(e))),
      group('', '🙋 你领来试的', `${S.probes.length} 位`, '', S.probes.map((p) => row(p))),
      group('exam', `📝 最后 ${S.answers.length} 位客人`, `你判对 ${correct}/${S.answers.length}`, examHead, S.answers.map((a) => row(a.item, yours(a)))),
    ].join('');
  }

  function shareText() {
    const head = S.daily ? `🚪 门卫交班夜 #${S.no}` : '🚪 门卫交班夜 · 练习';
    const won = S.answers.every((a) => a.ok);
    return `${head}\n${fmtScore(S.score.total)} 分 · 领了 ${S.probes.length} 位 · 用时 ${fmtTime(S.seconds)}\n` +
      `最后 ${S.answers.length} 位 ${squares()}\n${won ? '🕶️ 接过了老K 的墨镜' : '🚪 明天再来实习'}`;
  }

  /* ---------- 开始页 ---------- */

  const mainBtn = (title, sub) => `${title}<small>${sub}</small>`;

  /* 欢迎页和结算页各一份，选中后两边一起变，并记住。 */
  function renderDiff() {
    const opts = [...C.levels, { id: 'random', label: '随机' }];
    const cur = practiceLevelId();
    document.querySelectorAll('.diff').forEach((box) => {
      box.hidden = false;
      box.replaceChildren();
      const name = document.createElement('span');
      name.className = 'diff-label';
      name.textContent = '练习难度';
      const row = document.createElement('div');
      row.className = 'diff-row';
      opts.forEach((o) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.level = o.id;
        b.textContent = o.label;
        b.classList.toggle('on', o.id === cur);
        b.onclick = () => {
          try { localStorage.setItem(LEVEL_KEY, o.id); } catch { /* 忽略 */ }
          renderStart();
        };
        row.appendChild(b);
      });
      box.append(name, row);
    });
  }

  /* 同一时间只给一个主按钮：没交班就主推每日题；交过了就主推练习，每日题退成次要入口。 */
  function renderStart() {
    renderDiff();
    const diffName = levelById(practiceLevelId())?.label || '随机';
    const no = todayNo();
    let r = null;
    try { r = JSON.parse(localStorage.getItem(dailyKey(no)) || 'null'); } catch { /* 忽略 */ }
    const daily = $('btn-daily');
    const practice = $('btn-practice');
    if (r) {
      const pts = typeof r.score === 'number' ? `${fmtScore(r.score)} 分 · ` : '';
      practice.className = 'btn primary start-main';
      practice.innerHTML = mainBtn('练习一局', `${diffName}难度 · 想玩几局玩几局 · 不记成绩`);
      daily.className = 'btn link';
      daily.textContent = `再看一遍今晚 #${no} 的题（不改成绩）`;
      $('daily-note').textContent = `今晚已交班：${pts}领了 ${r.probes} 位 · ${r.squares}　明天换新题`;
      $('start-actions').append(practice, $('diff-start'), daily);
    } else {
      daily.className = 'btn primary start-main';
      daily.innerHTML = mainBtn(`开始今晚交班 #${no}`, '每天一题 · 大家同一道 · 只记第一次成绩');
      practice.className = 'btn link';
      practice.textContent = `先练习一局（${diffName}难度，不记成绩）`;
      $('daily-note').textContent = '';
      $('start-actions').append(daily, practice, $('diff-start'));
    }
  }

  const CN_NUM = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'];
  const cn = (n) => CN_NUM[n] || String(n);

  function renderRules() {
    const r = C.round;
    const shows = [r.examplesIn && `放进${cn(r.examplesIn)}位`, r.examplesOut && `拦下${cn(r.examplesOut)}位`].filter(Boolean);
    $('rule-examples').textContent = `开局老K 会${shows.join('、') || '什么也不示范'}给你看` +
      `${r.coverEachTerm ? '；规矩看两样东西时，会多示范一位' : ''}。`;
    $('step-probes').textContent = r.probes;
    $('step-exam').textContent = r.examSize;
    $('rule-score').textContent = fmtScore(C.scoring.max);
    $('probe').maxLength = r.nameMaxLen;
  }

  const SKIN_KEY = 'mw-skin';

  /* 第一个色块是默认皮肤；<head> 里已提前套上存过的皮肤，避免闪一下默认色。 */
  function setupSkins() {
    const btns = [...document.querySelectorAll('#skins button')];
    const apply = (id) => {
      const btn = btns.find((b) => b.dataset.skin === id) || btns[0];
      document.documentElement.dataset.skin = btn.dataset.skin;
      btns.forEach((b) => b.classList.toggle('on', b === btn));
      $('skin-name').textContent = btn.title;
      return btn.dataset.skin;
    };
    let saved = null;
    try { saved = localStorage.getItem(SKIN_KEY); } catch { /* 忽略 */ }
    apply(saved);
    btns.forEach((b) => {
      b.onclick = () => {
        try { localStorage.setItem(SKIN_KEY, apply(b.dataset.skin)); } catch { /* 忽略 */ }
      };
    });
  }

  async function init() {
    setupSkins();
    try {
      C = await loadConfig();
    } catch (e) {
      $('config-error').textContent = `配置出错了：${e.message}`;
      $('config-error').hidden = false;
      $('btn-daily').disabled = true;
      $('btn-practice').disabled = true;
      $('badge-start').textContent = '配置出错';
      return;
    }
    AI.setup(C);
    C.warnings.forEach((w) => log(w, 'warn'));
    renderRules();
    renderStart();
    const st = await AI.status();
    online = !!st.online;
    const text = online ? `在线 · ${st.model}` : '离线 · 只认常见客人';
    ['badge-start', 'badge-game'].forEach((id) => {
      $(id).textContent = text;
      $(id).classList.toggle('online', online);
    });

    $('btn-daily').onclick = () => newGame(true);
    $('btn-practice').onclick = () => newGame(false);
    $('btn-again').onclick = () => newGame(false);
    $('btn-home').onclick = () => { renderStart(); show('screen-start'); };
    $('btn-exam').onclick = () => {
      if (S.phase === 'probe' && !S.busy) startExam();
    };
    $('btn-let').onclick = () => answer(true);
    $('btn-deny').onclick = () => answer(false);
    $('probe-form').onsubmit = (e) => {
      e.preventDefault();
      knock($('probe').value);
    };
    $('probe').oninput = () => {
      $('counter').textContent = `${[...$('probe').value].length}/${C.round.nameMaxLen}`;
    };
    $('btn-share').onclick = async () => {
      try {
        await navigator.clipboard.writeText(shareText());
        $('toast').textContent = '已复制，去考考朋友吧。';
      } catch {
        $('toast').textContent = shareText();
      }
    };
    document.addEventListener('keydown', (e) => {
      if (!S || S.phase !== 'exam' || S.busy) return;
      if (e.key === 'ArrowLeft' || e.key === '1') answer(true);
      if (e.key === 'ArrowRight' || e.key === '2') answer(false);
    });
  }

  window.MW_DEBUG = { state: () => S, content: () => C, newGame };
  init();
})();
