(function () {
  'use strict';

  const C = window.ZZ_CONTENT;
  const AI = window.ZZ_AI;
  const $ = (id) => document.getElementById(id);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => String(s || '').replace(/[\s，。！？、,.!?~…]+/g, '');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const MAX_HP = 3;
  const MAX_ROUNDS = 8;
  const TURN_MS = 15000;
  const MODE_KEY = 'zz-mode';
  const MODES = {
    rush: { name: '急中生智', rule: '每轮限时 15 秒。' },
    slow: { name: '从长计议', rule: '不限时，想清楚再动手。' },
  };

  function modeId() {
    return localStorage.getItem(MODE_KEY) === 'slow' ? 'slow' : 'rush';
  }

  function applyMode(id) {
    const mode = MODES[id] ? id : 'rush';
    localStorage.setItem(MODE_KEY, mode);
    document.querySelectorAll('.mode-card').forEach((el) => el.classList.toggle('on', el.dataset.mode === mode));
    $('rule-time').textContent = MODES[mode].rule;
  }

  let online = false;
  let model = null;
  let S = null;

  /* ---------- 导演层：决定下一轮的后果牌与严重度 ---------- */

  function direct(nextRound) {
    let severity = C.SEVERITY_BY_ROUND[Math.min(nextRound - 1, C.SEVERITY_BY_ROUND.length - 1)];
    const byId = (id) => C.CARDS.find((c) => c.id === id);

    if (nextRound % 3 === 0) return { card: byId('awkward'), severity: Math.max(1, severity - 1), callbackWord: null };

    const recentText = S.crisis.text;
    const candidates = S.pool.filter((w) => !recentText.includes(w));
    if (nextRound >= 4 && candidates.length && nextRound - S.lastCallback >= 3 && Math.random() < 0.45) {
      const word = candidates.includes(S.opening.subject) && Math.random() < 0.5 ? S.opening.subject : pick(candidates);
      S.lastCallback = nextRound;
      return { card: byId('callback'), severity, callbackWord: word };
    }

    const deck = C.CARDS.filter((c) => c.weight > 0 && c.id !== S.lastCard);
    let r = Math.random() * deck.reduce((a, c) => a + c.weight, 0);
    const card = deck.find((c) => (r -= c.weight) < 0) || deck[0];
    S.lastCard = card.id;
    return { card, severity, callbackWord: null };
  }

  /* ---------- 渲染 ---------- */

  function show(screen) {
    document.querySelectorAll('.screen').forEach((el) => el.classList.toggle('active', el.id === screen));
  }

  function heartSpans(dmg) {
    const after = S.hp;
    const before = Math.min(MAX_HP, after + dmg);
    return Array.from({ length: MAX_HP }, (_, i) => {
      const fresh = dmg > 0 && i >= after && i < before;
      const lost = i >= after && !fresh;
      const delay = fresh ? (i - after) * 180 : 0;
      return `<span class="${lost ? 'lost' : ''} ${fresh ? 'breaking' : ''}" style="${fresh ? `animation-delay:${delay}ms` : ''}">❤️</span>`;
    }).join('');
  }

  function renderHud(dmg = 0) {
    $('hearts').innerHTML = heartSpans(dmg);
    $('round').textContent = S.round;
    $('score').textContent = S.score;
  }

  function hideVerdict() {
    $('overlay').classList.remove('show');
    $('hit-report').hidden = true;
  }

  function showHit(dmg) {
    const after = S.hp;
    $('hit-loss').textContent = `扣了 ${dmg} 颗心`;
    $('hit-hearts').innerHTML = heartSpans(dmg);
    $('hit-left').textContent = after > 0 ? `还剩 ${after} 颗心` : '心扣光了';
    $('hit-report').hidden = false;
    const stage = document.querySelector('.stage');
    const flash = $('damage-flash');
    stage.classList.remove('shake');
    flash.classList.remove('show');
    void stage.offsetWidth;
    stage.classList.add('shake');
    flash.classList.add('show');
  }

  function renderCrisis(flip) {
    const c = S.crisis;
    const card = $('card');
    if (flip) {
      card.classList.remove('flip');
      void card.offsetWidth;
      card.classList.add('flip');
    }
    const apply = () => {
      const tag = $('card-tag');
      tag.textContent = c.tag;
      tag.className = 'card-tag' + (c.cardId ? ` ${c.cardId}` : '');
      $('severity').innerHTML = '危险度 ' + '<i>●</i>'.repeat(c.severity) + '○'.repeat(5 - c.severity);
      $('card-emoji').textContent = c.emoji;
      let html = esc(c.text);
      if (c.hook) {
        const h = esc(c.hook);
        const i = html.indexOf(h);
        if (i >= 0) html = html.slice(0, i) + `<mark>${h}</mark>` + html.slice(i + h.length);
      }
      $('card-text').innerHTML = html;
      $('items').innerHTML = c.items.map((it) => `<button type="button" class="chip">${esc(it)}</button>`).join('');
    };
    flip ? setTimeout(apply, 270) : apply();
  }

  function renderChain(el, final) {
    const parts = [];
    S.steps.forEach((s) => {
      parts.push(`<span class="node">${s.emoji}</span>`);
      parts.push(`<span class="arrow">→</span><span class="act">${esc(s.solution)}</span><span class="arrow">→</span>`);
    });
    const solved = S.steps.length && S.steps[S.steps.length - 1].crisis === S.crisis.text;
    if (!solved) parts.push(`<span class="node">${S.crisis.emoji}</span>`);
    if (final === 'lose') parts.push('<span class="arrow">→</span><span class="node">🪦</span>');
    if (final === 'win') parts.push('<span class="node">🏆</span>');
    el.innerHTML = parts.join('');
  }

  function log(title, detail, warn) {
    const div = document.createElement('div');
    div.className = 'log' + (warn ? ' warn' : '');
    div.textContent = `${title}\n${detail}`;
    $('debug-log').prepend(div);
  }

  const fmtMs = (ms) => `${Math.round(ms)}ms`;

  /* ---------- 计时 ---------- */

  function startTimer() {
    stopTimer();
    const barWrap = document.querySelector('.timer');
    if (!S.timed) {
      barWrap.classList.add('off');
      return;
    }
    barWrap.classList.remove('off');
    S.timeLeft = TURN_MS;
    S.timeTotal = S.timeLeft;
    let last = Date.now();
    S.timer = setInterval(() => {
      const now = Date.now();
      if (!document.hidden) S.timeLeft -= now - last;
      last = now;
      const p = Math.max(0, S.timeLeft / S.timeTotal);
      const bar = $('timer-bar');
      bar.style.width = `${p * 100}%`;
      bar.className = 'timer-bar' + (p < 0.25 ? ' danger' : p < 0.5 ? ' warn' : '');
      if (S.timeLeft <= 0) {
        stopTimer();
        resolve('', { verdict: '无效', action: '', why: '你愣住了。危机不会等你。' }, 'timeout');
      }
    }, 100);
  }

  function stopTimer() {
    if (S && S.timer) clearInterval(S.timer);
    if (S) S.timer = null;
  }

  function setInputEnabled(on) {
    $('answer').disabled = !on;
    $('btn-submit').disabled = !on;
    if (on) {
      $('answer').value = '';
      $('counter').textContent = '0/12';
      $('answer').focus();
    }
  }

  /* ---------- 流程 ---------- */

  function newGame() {
    const opening = pick(C.OPENINGS);
    const mode = modeId();
    S = {
      opening,
      mode,
      timed: mode === 'rush',
      hp: MAX_HP,
      score: 0,
      round: 1,
      great: 0,
      crisis: { ...opening, tag: '开局', severity: 1, hook: null, cardId: null },
      steps: [],
      usedActions: new Set(),
      pool: [opening.subject],
      lastCard: null,
      lastCallback: 0,
      timer: null,
      busy: false,
    };
    $('debug-log').innerHTML = '';
    hideVerdict();
    $('brewing').classList.remove('show');
    show('screen-game');
    $('play-mode').textContent = MODES[mode].name;
    renderHud();
    renderCrisis(false);
    renderChain($('chain'));
    setInputEnabled(true);
    startTimer();
  }

  async function submit() {
    if (!S || S.busy) return;
    const solution = $('answer').value.trim();
    if (!clean(solution)) return;
    stopTimer();
    S.busy = true;
    setInputEnabled(false);
    $('brewing-text').textContent = '裁判正在审视你的解法';
    $('brewing').classList.add('show');

    const j = await AI.judge({ crisis: S.crisis.text, items: S.crisis.items, solution, online });
    log(`【判定】${j.source} · ${fmtMs(j.latency)}`, (j.error ? `错误：${j.error}\n` : '') + (j.raw || JSON.stringify(j.result)), !!j.error);
    resolve(solution, { ...j.result }, j.source);
  }

  async function resolve(solution, verdict, source) {
    S.busy = true;
    setInputEnabled(false);
    $('brewing').classList.remove('show');

    let { verdict: v, action, why } = verdict;
    const rule = C.VERDICTS[v];
    if ((v === '妙' || v === '行') && action && S.usedActions.has(action)) {
      v = '勉强';
      why = `又${action}？换个招吧`;
    }
    if (action) S.usedActions.add(action);
    const R = C.VERDICTS[v] || rule;

    const usedItem = R.advance && S.crisis.items.find((it) => clean(solution).includes(clean(it)));
    const gain = R.score + (usedItem ? 1 : 0);
    S.hp = Math.max(0, S.hp - R.dmg);
    S.score += gain;
    if (v === '妙') S.great += 1;

    const deltas = [];
    if (R.dmg) deltas.push(`-${R.dmg} ❤️`);
    if (R.score) deltas.push(`+${R.score} 分`);
    if (usedItem) deltas.push(`就地取材 +1`);
    if (!R.advance && S.hp > 0) deltas.push('危机还在');

    $('stamp').textContent = v;
    $('stamp').className = `stamp ${R.cls}`;
    $('why').textContent = why;
    $('delta').textContent = deltas.filter((d) => !d.includes('❤️')).join(' · ');
    $('hit-report').hidden = true;
    $('overlay').classList.add('show');
    renderHud(R.dmg);
    if (R.dmg > 0) showHit(R.dmg);
    if (gain) {
      $('score').classList.remove('bump');
      void $('score').offsetWidth;
      $('score').classList.add('bump');
    }

    const hold = R.dmg > 0 ? 2400 : 1600;
    S.lastTry = { solution, verdict: v };
    if (S.hp <= 0) {
      await sleep(hold);
      return gameOver(false);
    }

    if (R.advance && S.steps.length + 1 >= MAX_ROUNDS) {
      S.steps.push({ emoji: S.crisis.emoji, crisis: S.crisis.text, solution, verdict: v, hook: null });
      await sleep(hold);
      return gameOver(true);
    }

    if (!R.advance) {
      await sleep(hold);
      hideVerdict();
      S.busy = false;
      setInputEnabled(true);
      startTimer();
      return;
    }

    const plan = direct(S.round + 1);
    const ctx = {
      crisis: S.crisis.text,
      solution,
      card: plan.card,
      severity: plan.severity,
      callbackWord: plan.callbackWord,
      chain: S.steps.map((s) => ({ crisis: s.crisis, solution: s.solution })),
      online,
    };
    const [cq] = await Promise.all([AI.consequence(ctx), sleep(1300)]);
    const errs = cq.errors && cq.errors.length ? `重试原因：${cq.errors.join('；')}\n` : '';
    log(
      `【后果】${cq.source} · ${fmtMs(cq.latency)} · 牌=${plan.card.name} 严重度=${plan.severity} 链=${ctx.chain.length}${plan.callbackWord ? ` 回归=${plan.callbackWord}` : ''}`,
      errs + (cq.raw || JSON.stringify(cq.result)),
      cq.source !== 'llm' && cq.source !== 'rule',
    );

    const r = cq.result;
    S.steps.push({ emoji: S.crisis.emoji, crisis: S.crisis.text, solution, verdict: v, hook: r.hook });
    if (cq.source.startsWith('llm') && r.hook.length >= 2 && r.hook.length <= 4 && !S.pool.includes(r.hook)) S.pool.push(r.hook);
    if (S.pool.length > 4) S.pool.splice(1, 1);
    S.round += 1;
    S.crisis = { emoji: r.emoji, text: r.next, items: r.items, hook: r.hook, tag: plan.card.name, cardId: plan.card.id, severity: plan.severity };

    hideVerdict();
    renderHud();
    renderCrisis(true);
    renderChain($('chain'));
    await sleep(500);
    S.busy = false;
    setInputEnabled(true);
    startTimer();
  }

  async function gameOver(won) {
    S.won = !!won;
    stopTimer();
    const screen = $('screen-over');
    screen.classList.toggle('victory', S.won);
    $('ending-mark').textContent = S.won ? '🏆' : '🪦';
    $('ending-kicker').textContent = S.won ? '闯关成功' : '墓志铭';
    $('epitaph').textContent = S.won ? '正在写成凯旋的故事…' : '正在撰写墓志铭…';
    $('story').textContent = '正在把整条因果链写成一个故事…';
    $('toast').textContent = '';
    $('stats').innerHTML = `<div><b>${S.steps.length}</b>${S.won ? '闯过的轮数' : '撑过的轮数'}</div><div><b>${S.score}</b>得分</div><div><b>${S.great}</b>妙解</div>`;
    renderChain($('final-chain'), S.won ? 'win' : 'lose');
    show('screen-over');

    const ep = await AI.ending({
      won: S.won,
      first: S.opening.text,
      subject: S.opening.subject,
      steps: S.steps,
      last: S.crisis.text,
      lastTry: S.lastTry,
      online,
    });
    log(
      `【结局】${ep.source} · ${fmtMs(ep.latency)} · ${S.won ? '胜利' : '失败'}`,
      (ep.errors && ep.errors.length ? `重试原因：${ep.errors.join('；')}\n` : '') + (ep.error ? `错误：${ep.error}\n` : '') + (ep.raw || `${ep.result.title}\n${ep.result.story}`),
      ep.source === 'fallback',
    );
    S.epitaph = ep.result.title;
    S.story = ep.result.story;
    $('epitaph').textContent = ep.result.title;
    $('story').textContent = ep.result.story;
  }

  function shareText() {
    const mark = S.won ? '🏆' : '🪦';
    const solved = S.steps.length && S.steps[S.steps.length - 1].crisis === S.crisis.text;
    const nodes = S.steps.map((s) => s.emoji).concat(solved ? [] : [S.crisis.emoji], [mark]).join('→');
    const head = S.won ? '闯关成功' : '墓志铭';
    return `《自作自受 · ${MODES[S.mode].name}》${S.won ? '闯过' : '撑了'} ${S.steps.length} 轮，得分 ${S.score}\n${nodes}\n${head}：${S.epitaph || ''}\n${S.story || ''}`;
  }

  /* ---------- 事件 ---------- */

  $('modes').addEventListener('click', (e) => {
    const card = e.target.closest('.mode-card');
    if (card) applyMode(card.dataset.mode);
  });
  applyMode(modeId());

  $('btn-start').addEventListener('click', newGame);
  $('btn-again').addEventListener('click', newGame);
  $('answer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  $('answer').addEventListener('input', () => {
    $('counter').textContent = `${$('answer').value.length}/12`;
  });
  $('items').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || $('answer').disabled) return;
    const input = $('answer');
    input.value = (input.value + chip.textContent).slice(0, 12);
    $('counter').textContent = `${input.value.length}/12`;
    input.focus();
  });
  $('btn-share').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareText());
      $('toast').textContent = '已复制，去坑朋友吧';
    } catch {
      $('toast').textContent = shareText();
    }
  });

  AI.status().then((st) => {
    online = st.online;
    model = st.model;
    const label = online ? `云端 ${model}` : '离线规则模式';
    ['mode-badge-start', 'mode-badge-game'].forEach((id) => {
      $(id).textContent = label;
      $(id).classList.toggle('online', online);
    });
  });

  window.ZZ_DEBUG = { get state() { return S; }, direct };
})();
