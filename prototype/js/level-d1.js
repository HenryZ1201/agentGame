(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '').replace(/星期|礼拜/g, '周').replace('周天', '周日');
  const dayOf = (date) => String(date).split(' ')[0];

  const RESTAURANTS = [
    { id: 'shuxiang', name: '蜀香老灶火锅', price: 138, rating: 4.7, tag: '川味 · 1.2km' },
    { id: 'laode', name: '捞得香火锅（万达店）', price: 168, rating: 4.8, tag: '服务好 · 2.5km' },
    { id: 'tongguo', name: '老北京铜锅涮肉', price: 98, rating: 4.5, tag: '涮肉 · 3.1km' },
  ];

  const GROUPS = {
    hotpot: {
      title: '🍲 火锅搭子群（4）',
      history: [
        ['阿杰', '这周六晚上火锅走起？🔥'],
        ['小美', '+1，人均别超 150 哈'],
        ['大壮', '我都行！师傅你来订？'],
      ],
    },
  };

  const ui = {
    reset() {
      $('#dp-search').value = '';
      $('#dp-results').innerHTML = '<div class="dp-empty">搜点好吃的～</div>';
      $('#dp-results').classList.remove('collapsed');
      $('#dp-booking').classList.add('hidden');
      $('#dp-toast').classList.add('hidden');
      document.querySelectorAll('.opt.selected').forEach((b) => b.classList.remove('selected'));
      $('#win-chat').classList.add('hidden');
      $('#chat-msgs').innerHTML = '';
      $('#chat-head').textContent = '选择一个聊天';
      delete $('#chat-head').dataset.group;
      $('#chat-input').value = '';
      document.querySelectorAll('.chat-g.active').forEach((b) => b.classList.remove('active'));
    },
    showResults() {
      $('#dp-results').innerHTML = RESTAURANTS.map((r) => `
        <button type="button" tabindex="-1" class="dp-item" id="dp-r-${r.id}">
          <span class="dp-thumb">🍲</span>
          <span class="dp-info">
            <span class="dp-name">${esc(r.name)}</span>
            <span class="dp-meta"><b>★ ${r.rating}</b><span>人均 ¥${r.price}</span><span>${esc(r.tag)}</span></span>
          </span>
        </button>`).join('');
    },
    openBooking(r) {
      document.querySelectorAll('.dp-item').forEach((el) => el.classList.toggle('chosen', el.id === `dp-r-${r.id}`));
      $('#dp-results').classList.add('collapsed');
      $('#dp-bk-name').textContent = `${r.name} · 人均¥${r.price}`;
      $('#dp-booking').classList.remove('hidden');
    },
    select(group, el) {
      document.querySelectorAll(`.opt[data-group="${group}"]`).forEach((b) => b.classList.toggle('selected', b === el));
    },
    findOpt(group, value) {
      const v = norm(value);
      if (!v) return null;
      const opts = Array.from(document.querySelectorAll(`.opt[data-group="${group}"]`));
      return opts.find((b) => norm(b.dataset.val) === v)
        || opts.find((b) => v.includes(norm(b.dataset.key)) || norm(b.dataset.val).includes(v))
        || null;
    },
    toast(text) {
      const t = $('#dp-toast');
      t.textContent = text;
      t.classList.remove('hidden');
    },
    openChat() {
      $('#win-chat').classList.remove('hidden');
    },
    openGroup(id) {
      const g = GROUPS[id];
      document.querySelectorAll('.chat-g').forEach((b) => b.classList.toggle('active', b.id === `chat-g-${id}`));
      if ($('#chat-head').dataset.group === id) return;
      $('#chat-head').dataset.group = id;
      $('#chat-head').textContent = g.title;
      $('#chat-msgs').innerHTML = g.history.map(([who, text]) => `
        <div class="msg"><span class="msg-avatar">${esc(who.slice(0, 1))}</span>
        <span class="msg-col"><span class="msg-who">${esc(who)}</span><span class="msg-bubble">${esc(text)}</span></span></div>`).join('');
    },
    appendMsg(text) {
      const d = document.createElement('div');
      d.className = 'msg me';
      d.innerHTML = `<span class="msg-col"><span class="msg-who">师傅（小冒代发）</span><span class="msg-bubble">${esc(text)}</span></span><span class="msg-avatar">🧑‍🎓</span>`;
      $('#chat-msgs').appendChild(d);
      $('#chat-msgs').scrollTop = $('#chat-msgs').scrollHeight;
    },
  };

  const steps = [
    {
      id: 'search', icon: '🔍', tool: 'search', label: '搜索',
      args: { keyword: '火锅' },
      say: () => '师傅交给我！先搜一下火锅～',
      hints: ['搜错了，换个词', '先停一下'],
      async perform(api) {
        await api.click('#dp-search');
        await api.type('#dp-search', api.args.keyword);
        await api.click('#dp-search-btn');
        ui.showResults();
        await api.wait(250);
      },
    },
    {
      id: 'pick', icon: '🏪', tool: 'select_restaurant', label: '选餐厅',
      args: { restaurant: '蜀香老灶火锅（人均¥138）' },
      say: () => '这家 4.7 分，人均 138，没超预算，就它了！',
      hints: ['换一家', '这家太贵了'],
      async perform(api) {
        await api.click('#dp-r-shuxiang');
        ui.openBooking(RESTAURANTS[0]);
        await api.wait(200);
      },
    },
    {
      id: 'date', icon: '📅', tool: 'set_date', label: '选日期',
      args: { date: '周日 11/15' },
      say: (args, runNo) => (runNo > 1 ? `改成 ${args.date}！` : '日期选好啦～'),
      hints: ['是周六，不是周日', '日期不对', '先停一下'],
      error: {
        type: 'param',
        field: 'date',
        actions: ['modify', 'redo'],
        accept: ['周六', '14号', '14日', '11/14', '11.14', 'sat'],
        correctArgs: { date: '周六 11/14' },
        clarify: '师傅，日期要改成哪天呀？',
        fail: {
          emoji: '🚪',
          title: '周六晚上 6 点，你们四个准时站在蜀香老灶门口……',
          text: '店员：“您好，您的预订是明天（周日）哦～今天已经满座了。”',
        },
        lesson: '日期、人数这类关键参数，要对照原始需求看一眼。',
      },
      applyValue(field, value) {
        if (field && field !== 'date') return null;
        const b = ui.findOpt('date', value);
        return b ? b.dataset.val : null;
      },
      async perform(api) {
        const b = ui.findOpt('date', api.args.date);
        await api.click(b);
        ui.select('date', b);
        api.state.date = api.args.date;
        await api.wait(150);
      },
    },
    {
      id: 'time', icon: '⏰', tool: 'set_time', label: '选时间',
      args: { time: '18:00' },
      say: () => '晚上 6 点 ✔',
      hints: ['时间不对', '改成 7 点'],
      async perform(api) {
        const b = ui.findOpt('time', api.args.time);
        await api.click(b);
        ui.select('time', b);
        await api.wait(150);
      },
    },
    {
      id: 'people', icon: '👥', tool: 'set_people', label: '选人数',
      args: { people: '4位' },
      say: () => '4 位 ✔',
      hints: ['人数不对', '是 5 个人'],
      async perform(api) {
        const b = ui.findOpt('people', api.args.people);
        await api.click(b);
        ui.select('people', b);
        await api.wait(150);
      },
    },
    {
      id: 'submit', icon: '📝', tool: 'submit_booking', label: '提交预订',
      args: (state) => ({ booking: `${dayOf(state.date)} 18:00 · 4位` }),
      say: (args, runNo, state) => (state.booked ? '修改预订～' : '提交预订！'),
      hints: ['先别提交', '先问我再提交'],
      async perform(api) {
        await api.click('#dp-submit');
        const head = api.state.booked ? '已修改预订 ✅' : '预订成功 ✅';
        ui.toast(`${head} 蜀香老灶 · ${api.state.date} 18:00 · 4位`);
        api.state.booked = true;
        await api.wait(300);
      },
    },
    {
      id: 'message', icon: '💬', tool: 'send_message', label: '发消息',
      args: (state) => ({
        to: '火锅搭子群',
        text: state.msgSent
          ? `更正一下：是${dayOf(state.date)}晚6点哦🙏`
          : `订好啦！${dayOf(state.date)}晚6点 蜀香老灶，4位，冲～🔥`,
      }),
      say: (args, runNo, state) => (state.msgSent ? '我去群里更正一下……' : '跟群里说一声～'),
      hints: ['发错群了', '先别发'],
      async perform(api) {
        if ($('#win-chat').classList.contains('hidden')) {
          await api.click('#dock-chat');
          ui.openChat();
          await api.wait(250);
        }
        await api.click('#chat-g-hotpot');
        ui.openGroup('hotpot');
        await api.click('#chat-input');
        await api.type('#chat-input', api.args.text);
        await api.click('#chat-send');
        ui.appendMsg(api.args.text);
        $('#chat-input').value = '';
        api.state.msgSent = true;
        await api.wait(200);
      },
    },
  ];

  window.LEVEL_D1 = {
    id: 'D1',
    title: 'D1 · 订周六火锅',
    parTime: 40,
    fields: {
      keyword: '搜索词',
      restaurant: '餐厅',
      date: '日期',
      time: '时间',
      people: '人数',
      booking: '预订信息',
      to: '发送对象',
      text: '消息内容',
    },
    tip: '现实里的 AI 助手也会一本正经地填错信息。日期、人数、收件人、付款这些关键步骤值得多看一眼；发现不对就马上喊停，越早纠正，返工越少。',
    state: {},
    ui,
    steps,
    norm,
  };
})();
