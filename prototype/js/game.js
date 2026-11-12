(function () {
  'use strict';

  const L = window.LEVEL_D1;
  const P = window.CorrectionParser;
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const SPEEDS = { 1: { mult: 1, name: '盯着做' }, 2: { mult: 1.5, name: '偶尔看看' }, 4: { mult: 2, name: '放手去做' } };
  const DUR = { move: 650, click: 220, char: 55, preStep: 350, postStep: 650, end: 1800 };
  const CONFIRM_BELOW = 0.75;
  const PTS = { step: 10, direct: 100, late: 50, misfire: -30, missed: -150, timePerSec: 3 };

  /* ---------- 设置 ---------- */

  const CFG_KEY = 'shifu-proto-cfg-v1';
  const DEFAULT_CFG = {
    mode: 'llm',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3:4b',
    apiKey: '',
    timeoutMs: 10000,
    noThink: true,
    disableThinkingParam: false,
    jsonMode: false,
    showDebug: true,
  };
  const PRESETS = {
    ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:4b', noThink: true, disableThinkingParam: false },
    lmstudio: { baseUrl: 'http://localhost:1234/v1', model: 'qwen3-4b', noThink: true, disableThinkingParam: false },
    dashscope: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-4b', noThink: false, disableThinkingParam: true },
  };

  function loadCfg() {
    try {
      return { ...DEFAULT_CFG, ...JSON.parse(localStorage.getItem(CFG_KEY) || '{}') };
    } catch {
      return { ...DEFAULT_CFG };
    }
  }
  let cfg = loadCfg();
  const modeLabel = (c = cfg) => (c.mode === 'llm' ? `🧠 模型 ${c.model}` : '📏 离线规则');

  /* ---------- 可暂停、可变速、可中止的时钟 ---------- */

  class Abort extends Error {}
  function nextFrame(fn) {
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      fn(performance.now());
    };
    requestAnimationFrame(run);
    setTimeout(run, 34);
  }
  const clock = {
    speed: 1,
    paused: false,
    token: 0,
    animate(ms, onT) {
      const tok = this.token;
      return new Promise((resolve, reject) => {
        let elapsed = 0;
        let last = performance.now();
        const tick = (now) => {
          if (tok !== clock.token) return reject(new Abort());
          if (!clock.paused) elapsed += Math.max(0, now - last) * clock.speed;
          last = now;
          const t = ms <= 0 ? 1 : Math.min(1, elapsed / ms);
          if (onT) onT(t);
          if (t >= 1) resolve();
          else nextFrame(tick);
        };
        nextFrame(tick);
      });
    },
    wait(ms) {
      return this.animate(ms);
    },
  };

  /* ---------- 游戏状态 ---------- */

  const G = {
    phase: 'BRIEF',
    startAt: 0,
    endAt: 0,
    score: 0,
    trustPts: 0,
    catchPts: 0,
    misfirePts: 0,
    misfires: 0,
    caught: [],
    runCounts: {},
    maxReached: -1,
    target: null,
    pending: null,
    holdSayUntil: 0,
  };
  const HOLD_SAY_MS = 2200;

  L.steps.forEach((s) => {
    s.fixed = false;
    if (typeof s.args !== 'function') s.curArgs = { ...s.args };
  });
  L.state = {};
  L.ui.reset();

  const stage = $('#stage');
  const desktop = $('#desktop');
  const ghost = $('#ghost');

  function setPhase(p) {
    G.phase = p;
    document.body.dataset.phase = p;
  }

  /* ---------- 小冒：台词、心情、分数 ---------- */

  function say(text, mood) {
    if (text) {
      const b = $('#bubble');
      b.textContent = text;
      b.classList.remove('pop-in');
      void b.offsetWidth;
      b.classList.add('pop-in');
    }
    if (mood) $('#mood').textContent = mood;
  }

  function addScore(n) {
    G.score += n;
    $('#score').textContent = G.score;
    const f = document.createElement('span');
    f.className = `float ${n >= 0 ? 'plus' : 'minus'}`;
    f.textContent = n >= 0 ? `+${n}` : `${n}`;
    $('#score-wrap').appendChild(f);
    setTimeout(() => f.remove(), 1000);
  }

  setInterval(() => {
    if (G.startAt && !G.endAt) $('#timer').textContent = ((performance.now() - G.startAt) / 1000).toFixed(1);
  }, 100);

  /* ---------- 幽灵光标 ---------- */

  const ghostPos = { x: 0, y: 0 };
  function placeGhost(x, y) {
    ghostPos.x = x;
    ghostPos.y = y;
    ghost.style.transform = `translate(${x}px, ${y}px)`;
  }
  function resolveEl(target) {
    const el = typeof target === 'string' ? $(target) : target;
    if (!el) throw new Error(`找不到元素：${target}`);
    return el;
  }
  function pointOf(el) {
    const d = desktop.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left - d.left + Math.min(r.width / 2, 80), y: r.top - d.top + r.height * 0.55 };
  }
  async function moveTo(target) {
    const p = pointOf(resolveEl(target));
    const sx = ghostPos.x;
    const sy = ghostPos.y;
    await clock.animate(DUR.move, (t) => {
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      placeGhost(sx + (p.x - sx) * e, sy + (p.y - sy) * e);
    });
  }
  function ripple(p) {
    const r = document.createElement('span');
    r.className = 'ripple';
    r.style.left = `${p.x}px`;
    r.style.top = `${p.y}px`;
    desktop.appendChild(r);
    setTimeout(() => r.remove(), 600);
  }

  function makeApi(i, args, runNo) {
    return {
      args,
      runNo,
      state: L.state,
      wait: (ms) => clock.wait(ms),
      move: (target) => moveTo(target),
      async click(target) {
        const el = resolveEl(target);
        await moveTo(el);
        ghost.classList.add('pressing');
        ripple(pointOf(el));
        el.classList.add('agent-hit');
        el.dataset.step = i;
        await clock.wait(DUR.click);
        ghost.classList.remove('pressing');
        el.classList.remove('agent-hit');
      },
      async type(target, text) {
        const el = resolveEl(target);
        el.value = '';
        for (const ch of text) {
          await clock.wait(DUR.char);
          el.value += ch;
        }
      },
    };
  }

  /* ---------- 操作记录芯片 ---------- */

  function chipArgs(args) {
    return Object.values(args || {}).join(' · ');
  }
  function upsertChip(i, status) {
    const s = L.steps[i];
    let c = $(`#chip-${i}`);
    if (!c) {
      $('.chips-empty')?.remove();
      c = document.createElement('button');
      c.type = 'button';
      c.tabIndex = -1;
      c.id = `chip-${i}`;
      c.dataset.idx = i;
      $('#chips').appendChild(c);
    }
    const a = chipArgs(s.lastArgs);
    c.title = `${s.label}（${s.tool}）${a ? '：' + a : ''}`;
    c.innerHTML = `
      <span class="chip-no">${i + 1}</span>
      <span class="chip-icon">${s.icon}</span>
      <span class="chip-body">
        <span class="chip-tool">${esc(s.label)} <code>${esc(s.tool)}</code></span>
        <span class="chip-args">${esc(a || '—')}</span>
      </span>
      <span class="chip-badge"></span>`;
    setChip(i, status);
    c.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function setChip(i, status) {
    const c = $(`#chip-${i}`);
    if (!c) return;
    const s = L.steps[i];
    c.className = `chip ${status}${s.fixed ? ' is-fixed' : ''}`;
  }
  function flashChip(i, cls) {
    const c = $(`#chip-${i}`);
    if (!c) return;
    c.classList.add(cls);
    setTimeout(() => c.classList.remove(cls), 900);
  }

  /* ---------- 执行流 ---------- */

  function resolveArgs(step) {
    return typeof step.args === 'function' ? step.args(L.state) : { ...step.curArgs };
  }

  async function executeStep(i) {
    const step = L.steps[i];
    const runNo = (G.runCounts[i] || 0) + 1;
    G.runCounts[i] = runNo;
    const args = resolveArgs(step);
    step.lastArgs = args;
    $$(`[data-step="${i}"]`).forEach((el) => el.removeAttribute('data-step'));
    upsertChip(i, 'running');
    if (step.say && performance.now() > G.holdSayUntil) say(step.say(args, runNo, L.state), '😄');
    await clock.wait(DUR.preStep);
    await step.perform(makeApi(i, args, runNo));
    setChip(i, 'done');
    if (runNo === 1) {
      const pts = Math.round(PTS.step * SPEEDS[clock.speed].mult);
      G.trustPts += pts;
      addScore(pts);
    }
    G.maxReached = Math.max(G.maxReached, i);
    await clock.wait(DUR.postStep);
  }

  async function runLoop(from) {
    try {
      for (let i = from; i < L.steps.length; i++) await executeStep(i);
      say('师傅，我办好了！✌️', '😎');
      await clock.wait(DUR.end);
      finish();
    } catch (e) {
      if (!(e instanceof Abort)) console.error(e);
    }
  }

  function rerunFrom(j) {
    clock.token++;
    for (let k = j; k <= G.maxReached; k++) setChip(k, 'redo');
    G.maxReached = j - 1;
    closePop(true);
    runAgain();
    nextFrame(() => runLoop(j));
  }

  /* ---------- 暂停 / 继续 ---------- */

  function setPauseBtn(paused) {
    $('#btn-pause').innerHTML = paused ? '▶ 继续<small>空格键</small>' : '✋ 喊停！<small>空格键</small>';
    $('#btn-pause').classList.toggle('resume', paused);
  }
  function pause() {
    if (G.phase !== 'RUNNING') return;
    clock.paused = true;
    setPhase('PAUSED');
    stage.classList.add('paused');
    setPauseBtn(true);
    say('（小冒停下了手）师傅，哪里不对吗？', '😳');
  }
  function runAgain() {
    clock.paused = false;
    setPhase('RUNNING');
    stage.classList.remove('paused');
    setPauseBtn(false);
  }
  function resume() {
    if (G.phase !== 'PAUSED') return;
    say('好嘞，继续！', '😄');
    runAgain();
  }
  function togglePause() {
    if (G.phase === 'RUNNING') pause();
    else if (G.phase === 'PAUSED') resume();
  }

  /* ---------- 纠正弹窗 ---------- */

  const pop = $('#pop');
  const popInput = $('#pop-input');

  function popReply(text) {
    const r = $('#pop-reply');
    r.innerHTML = `<span class="pr-avatar">🧑‍🎓</span><span>${esc(text)}</span>`;
    r.classList.remove('hidden');
  }

  function openPop(i) {
    if (G.phase === 'RUNNING') pause();
    if (!['PAUSED', 'CORRECTING'].includes(G.phase)) return;
    const s = L.steps[i];
    G.target = i;
    setPhase('CORRECTING');
    $$('.chip.targeted').forEach((c) => c.classList.remove('targeted'));
    $(`#chip-${i}`)?.classList.add('targeted');
    $('#pop-no').textContent = i + 1;
    $('#pop-step').innerHTML = `<span class="ps-icon">${s.icon}</span><span><b>${esc(s.label)}</b> <code>${esc(s.tool)}</code><br><span class="ps-args">${esc(chipArgs(s.lastArgs) || '—')}</span></span>`;
    const hints = s.hints || ['这步不对，停一下', '先问我再做'];
    $('#pop-hints').innerHTML = hints.map((h) => `<button type="button" class="hint">${esc(h)}</button>`).join('') + '<button type="button" class="hint ok">这步没问题</button>';
    $('#pop-reply').classList.add('hidden');
    $('#pop-confirm').classList.add('hidden');
    $('#pop-mode').textContent = modeLabel();
    popInput.disabled = false;
    popInput.value = '';
    pop.classList.remove('hidden');
    say(`第 ${i + 1} 步怎么了，师傅？`, '😳');
    setTimeout(() => popInput.focus(), 0);
  }

  function closePop(silent) {
    pop.classList.add('hidden');
    $$('.chip.targeted').forEach((c) => c.classList.remove('targeted'));
    G.target = null;
    G.pending = null;
    if (!silent && ['CORRECTING', 'CONFIRM', 'PARSING'].includes(G.phase)) setPhase('PAUSED');
  }

  function backToCorrecting(msg) {
    setPhase('CORRECTING');
    $('#pop-confirm').classList.add('hidden');
    popInput.disabled = false;
    popInput.select();
    popInput.focus();
    popReply(msg);
    say(msg, '🤔');
  }

  async function submitPop(text) {
    text = String(text || '').trim();
    if (!text || G.phase !== 'CORRECTING') return;
    const i = G.target;
    const step = L.steps[i];
    setPhase('PARSING');
    popInput.disabled = true;
    popReply('🤔 小冒正在理解你的话……');
    const res = await P.parse({ step, args: step.lastArgs, text, fields: L.fields }, cfg);
    logDebug(i, text, res);
    if (G.phase !== 'PARSING' || G.target !== i) return;
    handleParsed(i, res.result);
  }

  const fieldLabel = (f) => L.fields[f] || f || '这一步';
  function describe(r) {
    switch (r.action) {
      case 'modify': return r.value ? `把${fieldLabel(r.field)}改成「${r.value}」` : `${fieldLabel(r.field)}不对`;
      case 'redo': return `${fieldLabel(r.field)}换一个重新做`;
      case 'skip': return '跳过这一步';
      case 'stop': return '先停下整个任务';
      case 'ask_first': return '这一步先问你再做';
      case 'undo': return '撤销这一步';
      default: return '这步没问题';
    }
  }

  function handleParsed(i, r) {
    if (r.action === 'none') {
      closePop(true);
      setPhase('PAUSED');
      resume();
      return;
    }
    if (r.action === 'modify' && !r.value) {
      backToCorrecting(`${fieldLabel(r.field)}要改成什么呀？师傅说具体点～`);
      return;
    }
    if (r.confidence < CONFIRM_BELOW) {
      setPhase('CONFIRM');
      G.pending = { i, r };
      popReply(`师傅，你是说「${describe(r)}」吗？`);
      say('我复述一下，师傅看对不对～', '🤔');
      $('#pop-confirm').classList.remove('hidden');
      return;
    }
    decide(i, r);
  }

  function judge(step, r, loose) {
    const e = step.error;
    const v = L.norm(r.value);
    const valueOk = !!v && e.accept.some((a) => v.includes(L.norm(a)));
    const actionOk = e.actions.includes(r.action);
    const fieldOk = !r.field || r.field === e.field;
    if (actionOk && valueOk && (loose || fieldOk)) return 'fix';
    if (!loose && r.action === 'modify' && v && (!r.field || r.field === e.field)) return 'wrongValue';
    return 'unclear';
  }

  function decide(i, r) {
    const step = L.steps[i];
    if (r.action === 'modify' && !r.value) {
      backToCorrecting(`${fieldLabel(r.field)}要改成什么呀？师傅说具体点～`);
      return;
    }
    if (step.error && !step.fixed) {
      const verdict = judge(step, r, false);
      if (verdict === 'fix') return applyFix(i, 'direct');
      if (verdict === 'wrongValue') return applyWrongValue(i, r);
      return backToCorrecting(step.error.clarify || '师傅，那这步应该怎么改呀？');
    }
    for (let j = 0; j < i; j++) {
      const s = L.steps[j];
      if (s.error && !s.fixed && judge(s, r, true) === 'fix') return applyFix(j, 'late', i);
    }
    return misfire(i);
  }

  function applyFix(j, kind, fromIdx) {
    const s = L.steps[j];
    s.fixed = true;
    s.curArgs = { ...s.curArgs, ...s.error.correctArgs };
    const pts = kind === 'direct' ? PTS.direct : PTS.late;
    G.catchPts += pts;
    G.caught.push({ idx: j, kind, from: fromIdx });
    addScore(pts);
    const newVal = Object.values(s.error.correctArgs).join(' ');
    if (kind === 'direct') {
      say(`收到！${fieldLabel(s.error.field)}改成 ${newVal}，马上重做～`, '😅');
    } else {
      say(`啊！原来是第 ${j + 1} 步的${fieldLabel(s.error.field)}错了……我回去改成 ${newVal}，后面的重新走一遍 (｡•́︿•̀｡)`, '😰');
    }
    G.holdSayUntil = performance.now() + HOLD_SAY_MS;
    rerunFrom(j);
  }

  function applyWrongValue(i, r) {
    const s = L.steps[i];
    const field = r.field || s.error.field;
    const nv = s.applyValue ? s.applyValue(field, r.value) : null;
    if (!nv) {
      backToCorrecting(`没有「${r.value}」这个选项呀，师傅要选哪个？`);
      return;
    }
    s.curArgs = { ...s.curArgs, [field]: nv };
    say(`收到，改成 ${nv}！`, '😄');
    G.holdSayUntil = performance.now() + HOLD_SAY_MS;
    rerunFrom(i);
  }

  function misfire(i) {
    G.misfires++;
    G.misfirePts += PTS.misfire;
    addScore(PTS.misfire);
    flashChip(i, 'misfire');
    closePop(true);
    runAgain();
    say('师傅……这步我对照过便利贴，是对的呀 (；′⌒`) 我先接着做啦', '🥺');
    G.holdSayUntil = performance.now() + HOLD_SAY_MS;
  }

  /* ---------- 结算 ---------- */

  function finish() {
    setPhase('DONE');
    G.endAt = performance.now();
    clock.paused = true;
    stage.classList.remove('paused');
    const elapsed = (G.endAt - G.startAt) / 1000;
    $('#timer').textContent = elapsed.toFixed(1);

    const missed = L.steps.map((s, i) => ({ s, i })).filter(({ s }) => s.error && !s.fixed);
    missed.forEach(({ i }) => setChip(i, 'missed'));
    const missPts = PTS.missed * missed.length;
    const timeBonus = missed.length ? 0 : Math.max(0, Math.round((L.parTime - elapsed) * PTS.timePerSec));
    const total = G.score + missPts + timeBonus;
    const stars = missed.length ? 1 : (G.misfires === 0 && elapsed <= L.parTime ? 3 : 2);
    const verdict = ['', '翻车了……但小冒学到了，你也是', '活儿办成了，还能更利落', '完美带教！小冒对你心服口服'][stars];

    const caughtHtml = G.caught.map(({ idx, kind }) => {
      const s = L.steps[idx];
      return kind === 'direct'
        ? `<li>✅ 第 ${idx + 1} 步「${esc(s.label)}」：当场喊停，一句话纠正</li>`
        : `<li>⚠️ 第 ${idx + 1} 步「${esc(s.label)}」：事后补救，后面的步骤都返工了${L.state.msgSent ? '，群里还得发一条更正' : ''}</li>`;
    }).join('');

    const missedHtml = missed.map(({ s, i }) => `
      <div class="fail-card">
        <div class="fail-emoji">${s.error.fail.emoji}</div>
        <div>
          <div class="fail-title">${esc(s.error.fail.title)}</div>
          <div class="fail-text">${esc(s.error.fail.text)}</div>
          <div class="fail-lesson">漏掉的是第 ${i + 1} 步「${esc(s.label)}」：${esc(s.error.lesson)}</div>
        </div>
      </div>`).join('');

    const row = (k, v, cls = '') => `<div class="row ${cls}"><span>${k}</span><b>${v >= 0 ? '+' : ''}${v}</b></div>`;

    $('#settle-card').innerHTML = `
      <div class="settle-head">
        <div class="settle-avatar">${stars === 3 ? '🤩' : stars === 2 ? '😊' : '😵'}</div>
        <div>
          <h2>师傅，我办好了！</h2>
          <div class="stars">${'★'.repeat(stars)}<span>${'★'.repeat(3 - stars)}</span></div>
          <div class="verdict">${verdict}</div>
        </div>
      </div>
      <div class="settle-grid">
        <div class="breakdown">
          ${row('信任分（放手执行的步骤）', G.trustPts)}
          ${row('抓错分', G.catchPts)}
          ${G.misfires ? row(`误纠正 ×${G.misfires}`, G.misfirePts, 'neg') : ''}
          ${missed.length ? row(`漏网之鱼 ×${missed.length}`, missPts, 'neg') : ''}
          ${row(`时间奖励（用时 ${elapsed.toFixed(1)}s / 目标 ${L.parTime}s）`, timeBonus)}
          <div class="row total"><span>总分</span><b>${total}</b></div>
        </div>
        <div class="recap">
          ${caughtHtml ? `<div class="recap-title">你抓到了</div><ul>${caughtHtml}</ul>` : ''}
          ${missed.length ? `<div class="recap-title">翻车集锦</div>${missedHtml}` : ''}
          ${!missed.length && !G.misfires ? '<div class="praise">该喊停时喊停，该放手时放手，这就是“信任校准”。</div>' : ''}
          ${G.misfires ? '<div class="praise warn">有几步其实是对的，过度怀疑也会拖慢进度哦。</div>' : ''}
        </div>
      </div>
      <div class="tip">💡 <b>现实小贴士</b>：${esc(L.tip)}</div>
      <div class="actions"><button type="button" class="primary big" id="btn-again">再来一单</button></div>`;
    $('#settle').classList.remove('hidden');
    $('#btn-again').addEventListener('click', () => location.reload());
  }

  /* ---------- 调试日志 ---------- */

  const SOURCE_LABEL = { llm: '🧠 模型', rule: '📏 规则', 'rule-fallback': '⚠️ 模型失败→规则' };
  function logDebug(i, text, res) {
    const list = $('#debug-list');
    $('.debug-empty', list)?.remove();
    const d = document.createElement('div');
    d.className = `debug-item ${res.source}`;
    d.innerHTML = `
      <div class="di-head"><span>${SOURCE_LABEL[res.source]}</span><span>第 ${i + 1} 步</span><span>${Math.round(res.latency)} ms</span></div>
      <div class="di-text">“${esc(text)}”</div>
      <code class="di-json">${esc(JSON.stringify(res.result))}</code>
      ${res.error ? `<div class="di-err">${esc(res.error)}</div>` : ''}
      ${res.raw != null ? `<details><summary>模型原始输出${res.usage ? `（${res.usage.prompt_tokens ?? '?'} → ${res.usage.completion_tokens ?? '?'} tokens）` : ''}</summary><pre>${esc(res.raw)}</pre></details>` : ''}`;
    list.prepend(d);
  }
  function applyDebugVisibility() {
    $('#debug').classList.toggle('hidden', !cfg.showDebug);
  }
  $('#debug-toggle').addEventListener('click', () => {
    const collapsed = $('#debug').classList.toggle('collapsed');
    $('#debug-toggle').textContent = collapsed ? '展开' : '收起';
  });

  /* ---------- 设置面板 ---------- */

  function fillSettings(c) {
    $$('input[name="cfg-mode"]').forEach((r) => { r.checked = r.value === c.mode; });
    $('#cfg-base').value = c.baseUrl;
    $('#cfg-model').value = c.model;
    $('#cfg-key').value = c.apiKey;
    $('#cfg-timeout').value = c.timeoutMs;
    $('#cfg-nothink').checked = c.noThink;
    $('#cfg-thinkparam').checked = c.disableThinkingParam;
    $('#cfg-json').checked = c.jsonMode;
    $('#cfg-debug').checked = c.showDebug;
  }
  function readSettings() {
    return {
      mode: $('input[name="cfg-mode"]:checked')?.value || 'llm',
      baseUrl: $('#cfg-base').value.trim(),
      model: $('#cfg-model').value.trim(),
      apiKey: $('#cfg-key').value.trim(),
      timeoutMs: Math.max(1000, Number($('#cfg-timeout').value) || 10000),
      noThink: $('#cfg-nothink').checked,
      disableThinkingParam: $('#cfg-thinkparam').checked,
      jsonMode: $('#cfg-json').checked,
      showDebug: $('#cfg-debug').checked,
    };
  }
  let pausedBySettings = false;
  function openSettings() {
    if (G.phase === 'RUNNING') {
      pause();
      pausedBySettings = true;
    }
    fillSettings(cfg);
    $('#cfg-test-out').textContent = '';
    $('#settings').classList.remove('hidden');
  }
  function closeSettings() {
    $('#settings').classList.add('hidden');
    if (pausedBySettings && G.phase === 'PAUSED') resume();
    pausedBySettings = false;
  }
  $('#btn-settings').addEventListener('click', openSettings);
  $('#start-settings').addEventListener('click', openSettings);
  $('#cfg-cancel').addEventListener('click', closeSettings);
  $('#cfg-save').addEventListener('click', () => {
    cfg = readSettings();
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    $('#start-mode').textContent = modeLabel();
    applyDebugVisibility();
    closeSettings();
  });
  $$('.presets button').forEach((b) => b.addEventListener('click', () => {
    fillSettings({ ...readSettings(), mode: 'llm', ...PRESETS[b.dataset.preset] });
  }));
  $('#cfg-test').addEventListener('click', async () => {
    const out = $('#cfg-test-out');
    out.textContent = '测试中……';
    const step = L.steps.find((s) => s.id === 'date');
    const res = await P.parse({ step, args: { date: '周日 11/15' }, text: '是周六不是周日', fields: L.fields }, readSettings());
    out.textContent = [
      `来源：${SOURCE_LABEL[res.source]}　耗时：${Math.round(res.latency)} ms`,
      `解析：${JSON.stringify(res.result)}`,
      res.error ? `错误：${res.error}` : '',
      res.raw != null ? `原始输出：${res.raw}` : '',
    ].filter(Boolean).join('\n');
  });

  /* ---------- 事件绑定 ---------- */

  $('#btn-start').addEventListener('click', () => {
    $('#start').classList.add('hidden');
    setPhase('RUNNING');
    G.startAt = performance.now();
    say('师傅交给我！保证办得漂漂亮亮～', '😄');
    runLoop(0);
  });

  $('#btn-pause').addEventListener('click', togglePause);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });

  $$('.speed-group button').forEach((b) => b.addEventListener('click', () => {
    clock.speed = Number(b.dataset.speed);
    $$('.speed-group button').forEach((x) => x.classList.toggle('active', x === b));
  }));

  const CAN_TARGET = ['RUNNING', 'PAUSED', 'CORRECTING'];
  desktop.addEventListener('click', (e) => {
    const el = e.target.closest('[data-step]');
    if (!el || !CAN_TARGET.includes(G.phase)) return;
    e.preventDefault();
    e.stopPropagation();
    openPop(Number(el.dataset.step));
  }, true);
  $('#chips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (c && CAN_TARGET.includes(G.phase)) openPop(Number(c.dataset.idx));
  });

  $('#pop-send').addEventListener('click', () => submitPop(popInput.value));
  $('#pop-cancel').addEventListener('click', () => closePop());
  $('#pop-hints').addEventListener('click', (e) => {
    const h = e.target.closest('.hint');
    if (!h || G.phase !== 'CORRECTING') return;
    popInput.value = h.textContent;
    submitPop(h.textContent);
  });
  $('#pop-yes').addEventListener('click', () => {
    if (G.phase !== 'CONFIRM' || !G.pending) return;
    const { i, r } = G.pending;
    G.pending = null;
    $('#pop-confirm').classList.add('hidden');
    setPhase('CORRECTING');
    decide(i, r);
  });
  $('#pop-retry').addEventListener('click', () => {
    if (G.phase !== 'CONFIRM') return;
    G.pending = null;
    backToCorrecting('那师傅再说一遍？我没太听懂 (・_・;)');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#settings').classList.contains('hidden')) closeSettings();
      else if (['CORRECTING', 'CONFIRM'].includes(G.phase)) closePop();
      return;
    }
    if (e.target.matches('input, textarea, select')) {
      if (e.key === 'Enter' && e.target === popInput) submitPop(popInput.value);
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      togglePause();
    }
  });

  /* ---------- 初始化 ---------- */

  $('#start-mode').textContent = modeLabel();
  applyDebugVisibility();
  requestAnimationFrame(() => placeGhost(desktop.clientWidth * 0.5, desktop.clientHeight - 90));
})();
