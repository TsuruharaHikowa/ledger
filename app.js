'use strict';

/* ---------- 工具 ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
/* ---------- 币种 ---------- */
// 金额一律以「分」（最小单位 ×100）存储；日元没有小数，显示和输入时不带小数
const CUR = {
  CNY: { name: '人民币', sym: '¥', dec: 2 },
  USD: { name: '美元', sym: '$', dec: 2 },
  JPY: { name: '日元', sym: 'JP¥', dec: 0 },
  EUR: { name: '欧元', sym: '€', dec: 2 },
  GBP: { name: '英镑', sym: '£', dec: 2 },
};
const CUR_KEYS = Object.keys(CUR);
const curOf = t => (CUR[t.cur] ? t.cur : 'CNY'); // 旧记录没有币种字段，按人民币算
const fmt = (c, cur = 'CNY') => {
  const d = CUR[cur].dec;
  return (c / 100).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
};
const money = (c, cur) => CUR[cur].sym + fmt(c, cur);
// 明细列表里人民币保持原样不带符号，其他币种带上符号以示区分
const tagMoney = (c, cur) => (cur === 'CNY' ? '' : CUR[cur].sym) + fmt(c, cur);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
const monthLabel = ym => `${ym.slice(0, 4)}年${Number(ym.slice(5))}月`;

/* ---------- 本地数据库（IndexedDB，数据只存在本机） ---------- */
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('ledger', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('tx', { keyPath: 'id' });
      r.result.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function run(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && out.result);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
const dbAll = () => run('tx', 'readonly', s => s.getAll());
const dbPut = tx => run('tx', 'readwrite', s => s.put(tx));
const dbPutMany = list => run('tx', 'readwrite', s => { list.forEach(t => s.put(t)); });
const dbDel = id => run('tx', 'readwrite', s => s.delete(id));
const dbClear = () => run('tx', 'readwrite', s => s.clear());
const metaGet = k => run('meta', 'readonly', s => s.get(k));
const metaSet = (k, v) => run('meta', 'readwrite', s => s.put(v, k));

/* ---------- 默认分类 ---------- */
const DEFAULT_CATS = [
  { id: 'food', type: 'expense', name: '餐饮' },
  { id: 'transport', type: 'expense', name: '交通' },
  { id: 'shopping', type: 'expense', name: '购物' },
  { id: 'daily', type: 'expense', name: '日用' },
  { id: 'housing', type: 'expense', name: '住房' },
  { id: 'fun', type: 'expense', name: '娱乐' },
  { id: 'medical', type: 'expense', name: '医疗' },
  { id: 'study', type: 'expense', name: '学习' },
  { id: 'phone', type: 'expense', name: '通讯' },
  { id: 'gift', type: 'expense', name: '人情' },
  { id: 'other', type: 'expense', name: '其他' },
  { id: 'salary', type: 'income', name: '工资' },
  { id: 'bonus', type: 'income', name: '奖金' },
  { id: 'invest', type: 'income', name: '理财' },
  { id: 'parttime', type: 'income', name: '兼职' },
  { id: 'redpacket', type: 'income', name: '红包' },
  { id: 'other_in', type: 'income', name: '其他' },
];
const GONE = { name: '已删除分类' };

/* ---------- 状态 ---------- */
const S = {
  tab: 'home',
  month: today().slice(0, 7),
  stats: { mode: 'month', month: today().slice(0, 7), year: today().slice(0, 4), type: 'expense' },
  txs: [],
  cats: [],
  cur: 'CNY', // 当前币种：记新账默认用它，统计也按它计算；切换后会保存，不会自动切回
  sheet: null, // { kind: 'edit' | 'cats' | 'cur', ... }
};
const cat = id => S.cats.find(c => c.id === id) || GONE;
const glyph = c => esc([...c.name][0] || '?'); // 用分类名的第一个字当图标
const sumOf = (list, type) => list.reduce((a, t) => a + (t.type === type ? t.amount : 0), 0);
const inCur = (list, cur = S.cur) => list.filter(t => curOf(t) === cur);
// 按币种分别求和（不同币种不能直接相加），按固定币种顺序返回 [[币种, 金额], ...]
const sumByCur = (list, type) => CUR_KEYS.map(k => [k, sumOf(inCur(list, k), type)]).filter(([, v]) => v);
const curPill = () => `<button class="cur-pill" data-action="open-cur" aria-label="切换币种">${CUR[S.cur].name}<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg></button>`;

/* ---------- 明细页 ---------- */
function viewHome() {
  const list = S.txs.filter(t => t.date.startsWith(S.month))
    .sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);
  const cur = S.cur, mine = inCur(list);
  const exp = sumOf(mine, 'expense'), inc = sumOf(mine, 'income');
  const days = [];
  for (const t of list) {
    if (!days.length || days[days.length - 1].date !== t.date) days.push({ date: t.date, items: [] });
    days[days.length - 1].items.push(t);
  }
  const bal = inc - exp;
  // 本月还有其他币种的记录时，在汇总卡片下方单独列出
  const others = list.filter(t => curOf(t) !== cur);
  const otherLine = (type, word) => {
    const parts = sumByCur(others, type);
    return parts.length ? `<div>${word} ${parts.map(([k, v]) => money(v, k)).join(' · ')}</div>` : '';
  };
  return `
  <div class="pin">
  <div class="top">
    <div class="title"><h1>记账本</h1>${curPill()}</div>
    ${periodNav(monthLabel(S.month), 'home')}
  </div>
  <section class="hero">
    <div class="k">本月支出</div>
    <div class="v"><small>${CUR[cur].sym}</small>${fmt(exp, cur)}</div>
    <div class="row">
      <div class="cell"><span class="k">收入</span><b>${money(inc, cur)}</b></div>
      <div class="cell"><span class="k">结余</span><b>${bal < 0 ? '-' : ''}${money(Math.abs(bal), cur)}</b></div>
    </div>
    ${others.length ? `<div class="others"><span class="k">其他币种</span>${otherLine('expense', '支出')}${otherLine('income', '收入')}</div>` : ''}
  </section>
  </div>
  ${days.length ? days.map(dayBlock).join('') : `<div class="empty">这个月还没有记录<br>点右下角的 + 记一笔</div>`}`;
}
function periodNav(label, scope) {
  return `<div class="period">
    <button data-action="period" data-scope="${scope}" data-d="-1" aria-label="上一个">‹</button>
    <button class="label" data-action="period" data-scope="${scope}" data-d="0">${label}</button>
    <button data-action="period" data-scope="${scope}" data-d="1" aria-label="下一个">›</button>
  </div>`;
}
function dayBlock(day) {
  const d = new Date(day.date + 'T00:00:00');
  const part = (type, word) => {
    const s = sumByCur(day.items, type);
    return s.length ? `${word} ${s.map(([k, v]) => tagMoney(v, k)).join(' · ')}` : '';
  };
  const totals = [part('expense', '支出'), part('income', '收入')].filter(Boolean).join('　');
  return `<section class="day">
    <div class="day-head"><span>${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}${day.date === today() ? ' · 今天' : ''}</span><span>${totals}</span></div>
    <div class="card">${day.items.map(txRow).join('')}</div>
  </section>`;
}
function txRow(t) {
  const c = cat(t.cat);
  return `<button class="tx" data-action="edit" data-id="${esc(t.id)}">
    <span class="ic">${glyph(c)}</span>
    <span class="mid"><div class="name">${esc(c.name)}</div>${t.note ? `<div class="note">${esc(t.note)}</div>` : ''}</span>
    <span class="amt ${t.type}">${t.type === 'income' ? '+' : '-'}${tagMoney(t.amount, curOf(t))}</span>
  </button>`;
}

/* ---------- 统计页 ---------- */
function viewStats() {
  const st = S.stats;
  const key = st.mode === 'month' ? st.month : st.year;
  const cur = S.cur;
  const list = inCur(S.txs.filter(t => t.date.startsWith(key)));
  const exp = sumOf(list, 'expense'), inc = sumOf(list, 'income'), bal = inc - exp;
  const typed = list.filter(t => t.type === st.type);
  const total = sumOf(typed, st.type);
  const word = st.type === 'expense' ? '支出' : '收入';

  // 分类排行
  const by = new Map();
  for (const t of typed) by.set(t.cat, (by.get(t.cat) || 0) + t.amount);
  const ranks = [...by.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranks.length ? ranks[0][1] : 1;
  const colorOf = (id, i) => i < PIE_MAX ? catColor(id) : 'var(--other)';

  return `
  <div class="top">
    <div class="title"><h1>统计</h1>${curPill()}</div>
    ${periodNav(st.mode === 'month' ? monthLabel(st.month) : `${st.year}年`, 'stats')}
  </div>
  <div class="bar-row">
    <div class="seg">
      <button data-action="stats-mode" data-v="month" class="${st.mode === 'month' ? 'on' : ''}">按月</button>
      <button data-action="stats-mode" data-v="year" class="${st.mode === 'year' ? 'on' : ''}">按年</button>
    </div>
    <div class="seg">
      <button data-action="stats-type" data-v="expense" class="${st.type === 'expense' ? 'on' : ''}">支出</button>
      <button data-action="stats-type" data-v="income" class="${st.type === 'income' ? 'on' : ''}">收入</button>
    </div>
  </div>
  <div class="tiles">
    <div class="tile"><div class="k">支出</div><div class="v">${tileNum(exp, cur)}</div></div>
    <div class="tile"><div class="k">收入</div><div class="v">${tileNum(inc, cur)}</div></div>
    <div class="tile"><div class="k">结余</div><div class="v">${bal < 0 ? '-' : ''}${tileNum(Math.abs(bal), cur)}</div></div>
  </div>
  <section class="panel">
    <div class="panel-head"><h2>${st.mode === 'month' ? '每日' : '每月'}${word}</h2><span class="sub">点按柱子查看金额</span></div>
    <div class="chart" id="trend"></div>
  </section>
  <section class="panel">
    <div class="panel-head"><h2>${word}分类</h2><span class="sub">点按色块查看</span></div>
    ${ranks.length ? donut(ranks, total, word) + ranks.map(([id, v], i) => {
      const c = cat(id);
      return `<div class="rank" style="--c:${colorOf(id, i)}">
        <div class="line1"><span><i class="dot"></i><span class="nm">${esc(c.name)}</span><span class="pct">${(v / total * 100).toFixed(1)}%</span></span><span class="val">${money(v, cur)}</span></div>
        <div class="track"><i style="width:${(v / top * 100).toFixed(1)}%"></i></div>
      </div>`;
    }).join('') : `<div class="empty" style="padding:28px 0">这段时间没有${CUR[cur].name}${word}记录</div>`}
  </section>`;
}

// 饼图：金额最高的 5 个分类各占一块，其余合并为「其他分类」
const PIE_MAX = 5;
// 分类颜色按它在分类列表中的位置固定，不随排名变化
function catColor(id) {
  const c = S.cats.find(x => x.id === id);
  if (!c) return 'var(--other)';
  return `var(--c${S.cats.filter(x => x.type === c.type).indexOf(c) % 8 + 1})`;
}
function donut(ranks, total, word) {
  const R = 58, C = 2 * Math.PI * R;
  const segs = ranks.slice(0, PIE_MAX).map(([id, v]) => ({ name: cat(id).name, v, color: catColor(id) }));
  const rest = ranks.slice(PIE_MAX).reduce((a, r) => a + r[1], 0);
  if (rest) segs.push({ name: '其他分类', v: rest, color: 'var(--other)' });
  const gap = segs.length > 1 ? 2 : 0;
  let off = 0;
  const arcs = segs.map(s => {
    const len = s.v / total * C;
    const arc = `<circle class="slice" data-action="slice" data-name="${esc(s.name)} ${(s.v / total * 100).toFixed(1)}%" data-val="${money(s.v, S.cur)}" cx="80" cy="80" r="${R}" style="stroke:${s.color}" stroke-dasharray="${Math.max(len - gap, 0.5)} ${C}" stroke-dashoffset="${-off}"/>`;
    off += len;
    return arc;
  }).join('');
  return `<div class="donut" id="donut" data-name="总${word}" data-val="${money(total, S.cur)}">
    <svg viewBox="0 0 160 160" role="img" aria-label="${word}分类占比"><g transform="rotate(-90 80 80)">${arcs}</g></svg>
    <div class="center"><div class="k" id="d-k">总${word}</div><div class="v" id="d-v">${money(total, S.cur)}</div></div>
  </div>`;
}

// 小方块里空间有限：百万以上改用「万」为单位
const tileNum = (c, cur) => c >= 1e8 ? `${(c / 1e6).toFixed(2)}万` : fmt(c, cur);

function trendData() {
  const st = S.stats;
  if (st.mode === 'month') {
    const [y, m] = st.month.split('-').map(Number);
    const n = new Date(y, m, 0).getDate();
    const data = Array.from({ length: n }, (_, i) => ({ label: (i === 0 || (i + 1) % 5 === 0) ? String(i + 1) : '', tip: `${m}月${i + 1}日`, value: 0 }));
    for (const t of inCur(S.txs)) if (t.type === st.type && t.date.startsWith(st.month)) data[Number(t.date.slice(8)) - 1].value += t.amount;
    return data;
  }
  const data = Array.from({ length: 12 }, (_, i) => ({ label: `${i + 1}月`, tip: `${st.year}年${i + 1}月`, value: 0 }));
  for (const t of inCur(S.txs)) if (t.type === st.type && t.date.startsWith(st.year)) data[Number(t.date.slice(5, 7)) - 1].value += t.amount;
  return data;
}
function niceMax(yuan) {
  if (yuan <= 0) return 100;
  const e = Math.pow(10, Math.floor(Math.log10(yuan)));
  const f = yuan / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e;
}
const shortYuan = v => v >= 10000 ? `${+(v / 10000).toFixed(1)}万` : String(+v.toFixed(1));

function drawTrend() {
  const el = $('#trend');
  if (!el) return;
  const data = trendData();
  const W = el.clientWidth || 311, H = 170, pl = 36, pr = 4, pt = 8, pb = 22;
  const ih = H - pt - pb, iw = W - pl - pr;
  const max = niceMax(Math.max(...data.map(d => d.value)) / 100);
  const slot = iw / data.length;
  const bw = Math.max(2, Math.min(slot - 2, 20));
  let g = '';
  for (const f of [0, 0.5, 1]) {
    const y = pt + ih * (1 - f);
    g += `<line class="${f ? 'grid' : 'base'}" x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}"/>`;
    g += `<text class="tick" x="${pl - 6}" y="${y + 3.5}" text-anchor="end">${shortYuan(max * f)}</text>`;
  }
  data.forEach((d, i) => {
    const cx = pl + slot * i + slot / 2;
    const h = d.value ? Math.max(2, d.value / 100 / max * ih) : 0;
    if (h) {
      const x = cx - bw / 2, y = pt + ih - h, r = Math.min(4, bw / 2, h);
      g += `<path class="bar" data-i="${i}" d="M${x},${pt + ih}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${pt + ih}Z"/>`;
    }
    if (d.label) g += `<text class="tick" x="${cx}" y="${H - 6}" text-anchor="middle">${d.label}</text>`;
    g += `<rect class="hit" data-action="bar" data-i="${i}" x="${pl + slot * i}" y="${pt}" width="${slot}" height="${ih}"/>`;
  });
  el.classList.remove('has-sel');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="趋势柱状图">${g}</svg>`;
  el._data = data; el._geo = { pl, slot, W };
}
function selectBar(i) {
  const el = $('#trend');
  const d = el._data[i], { pl, slot, W } = el._geo;
  el.querySelectorAll('.bar.sel').forEach(b => b.classList.remove('sel'));
  $('.tip', el)?.remove();
  const bar = el.querySelector(`.bar[data-i="${i}"]`);
  bar?.classList.add('sel');
  el.classList.toggle('has-sel', !!bar);
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.textContent = `${d.tip}　${money(d.value, S.cur)}`;
  el.appendChild(tip);
  const half = tip.offsetWidth / 2;
  tip.style.left = Math.min(W - half, Math.max(half, pl + slot * i + slot / 2)) + 'px';
}

/* ---------- 设置页 ---------- */
function viewSettings() {
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  return `
  <div class="top"><h1>设置</h1></div>
  ${standalone ? '' : `<div class="hint">在 Safari 里点底部的「分享」按钮，选择「添加到主屏幕」，就能像 App 一样全屏、离线使用。</div>`}
  <div class="group-title">分类</div>
  <div class="card">
    <button class="item" data-action="open-cats"><span class="t">分类管理<small>添加或删除收支分类</small></span><span class="arrow">›</span></button>
  </div>
  <div class="group-title">数据备份（共 ${S.txs.length} 笔记录）</div>
  <div class="card">
    <button class="item" data-action="export-json"><span class="t">导出备份<small>保存全部数据为 JSON 文件，可用于恢复</small></span><span class="arrow">›</span></button>
    <button class="item" data-action="import-json"><span class="t">导入备份<small>从 JSON 备份文件恢复，与现有数据合并</small></span><span class="arrow">›</span></button>
    <button class="item" data-action="export-csv"><span class="t">导出表格<small>导出为 CSV，可用 Excel / Numbers 打开</small></span><span class="arrow">›</span></button>
  </div>
  <div class="group-title">危险操作</div>
  <div class="card">
    <button class="item danger" data-action="wipe"><span class="t">清空所有记录<small>删除全部账目，无法恢复</small></span></button>
  </div>
  <div class="foot">数据只保存在这台设备上，不会上传到任何服务器。<br>删除主屏幕图标或清除 Safari 网站数据会丢失账目，请定期导出备份。</div>`;
}

/* ---------- 记一笔 / 编辑 弹层 ---------- */
function openEdit(tx) {
  const type = tx ? tx.type : 'expense';
  S.sheet = {
    kind: 'edit',
    id: tx ? tx.id : null,
    type,
    cat: tx ? tx.cat : S.cats.find(c => c.type === type)?.id,
    cur: tx ? curOf(tx) : S.cur,
    amt: tx ? String(tx.amount / 100) : '',
    date: tx ? tx.date : (S.month === today().slice(0, 7) ? today() : `${S.month}-01`),
    note: tx ? tx.note || '' : '',
    created: tx ? tx.created : null,
  };
  renderSheet();
}
function amtText(a) {
  if (!a) return '0.00';
  const [i, d] = a.split('.');
  return Number(i).toLocaleString('zh-CN') + (a.includes('.') ? '.' + (d || '') : '');
}
function sheetEdit() {
  const E = S.sheet, c = cat(E.cat);
  return `
  <div class="sheet-head">
    <button class="txt" data-action="close-sheet">取消</button>
    <div class="seg">
      <button data-action="edit-type" data-v="expense" class="${E.type === 'expense' ? 'on' : ''}">支出</button>
      <button data-action="edit-type" data-v="income" class="${E.type === 'income' ? 'on' : ''}">收入</button>
    </div>
    ${E.id ? `<button class="txt del" data-action="delete-tx">删除</button>` : `<span class="txt"></span>`}
  </div>
  <div class="cats">
    ${S.cats.filter(x => x.type === E.type).map(x => `<button class="cat ${x.id === E.cat ? 'on' : ''}" data-action="pick-cat" data-id="${esc(x.id)}">${esc(x.name)}</button>`).join('')}
  </div>
  <div class="amount-row">
    <span class="left"><span class="who" id="who">${esc(c.name)}</span><span class="cur-wrap ${E.curMenu ? 'open' : ''}">
      <button class="cur-chip" data-action="edit-cur" aria-label="更换这笔的币种" aria-expanded="${!!E.curMenu}">${CUR[E.cur].name}<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg></button>
      ${E.curMenu ? `<span class="cur-menu" role="menu">${CUR_KEYS.map(k => `<button role="menuitemradio" aria-checked="${k === E.cur}" class="${k === E.cur ? 'on' : ''}" data-action="edit-pick-cur" data-v="${k}"><span class="sym">${CUR[k].sym}</span><span class="nm">${CUR[k].name}</span>${k === E.cur ? '<span class="check">✓</span>' : ''}</button>`).join('')}</span>` : ''}
    </span></span>
    <span class="num"><small>${CUR[E.cur].sym}</small><span id="amt">${amtText(E.amt)}</span></span>
  </div>
  <div class="meta-row">
    <input type="date" id="f-date" value="${esc(E.date)}" aria-label="日期">
    <input type="text" id="f-note" value="${esc(E.note)}" placeholder="备注（可选）" maxlength="40" enterkeyhint="done">
  </div>
  <div class="keys">
    ${['7', '8', '9'].map(k => `<button data-action="key" data-k="${k}">${k}</button>`).join('')}<button class="fn" data-action="key" data-k="del" aria-label="退格">⌫</button>
    ${['4', '5', '6'].map(k => `<button data-action="key" data-k="${k}">${k}</button>`).join('')}<button class="fn" data-action="key" data-k="clr">清空</button>
    ${['1', '2', '3'].map(k => `<button data-action="key" data-k="${k}">${k}</button>`).join('')}<button class="ok" data-action="save-tx">完成</button>
    <button data-action="key" data-k=".">.</button><button data-action="key" data-k="0">0</button><button data-action="key" data-k="00">00</button>
  </div>
  ${E.curMenu ? `<div class="menu-mask" data-action="close-cur-menu"></div>` : ''}`;
}
function pressKey(k) {
  const E = S.sheet;
  let a = E.amt;
  if (k === 'del') a = a.slice(0, -1);
  else if (k === 'clr') a = '';
  else if (k === '.') {
    if (!CUR[E.cur].dec) return toast(`${CUR[E.cur].name}没有小数`);
    if (!a.includes('.')) a = (a || '0') + '.';
  }
  else if (a.includes('.')) a += k.slice(0, 2 - a.split('.')[1].length);
  else if (a === '' || a === '0') a = k === '00' ? '0' : k;
  else if ((a + k).length <= 9) a += k;
  E.amt = a;
  $('#amt').textContent = amtText(a);
}
async function saveTx() {
  const E = S.sheet;
  const amount = Math.round(parseFloat(E.amt || '0') * 100);
  if (!(amount > 0)) return toast('请先输入金额');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(E.date)) return toast('请选择日期');
  const tx = { id: E.id || uid(), type: E.type, cat: E.cat, amount, cur: E.cur, date: E.date, note: E.note.trim(), created: E.created || Date.now() };
  await dbPut(tx);
  // 记新账时换了币种，就把它当作当前币种记住，下一笔继续用
  if (!E.id && E.cur !== S.cur) await setCur(E.cur);
  const i = S.txs.findIndex(t => t.id === tx.id);
  if (i >= 0) S.txs[i] = tx; else S.txs.push(tx);
  S.month = tx.date.slice(0, 7);
  closeSheet();
  render();
  toast(E.id ? '已修改' : '已记一笔');
}

/* ---------- 币种选择 弹层 ---------- */
function sheetCur() {
  return `
  <div class="sheet-head">
    <span class="txt"></span>
    <div class="sheet-title">选择币种</div>
    <button class="txt right strong" data-action="close-sheet">完成</button>
  </div>
  <div class="card cur-list">
    ${CUR_KEYS.map(k => `<button class="item ${k === S.cur ? 'on' : ''}" data-action="pick-cur" data-v="${k}">
      <span class="sym">${CUR[k].sym}</span><span class="t">${CUR[k].name}<small>${k}</small></span>${k === S.cur ? '<span class="check">✓</span>' : ''}
    </button>`).join('')}
  </div>
  <div class="foot">切换后会一直保持，直到你再次切换。<br>新记录默认使用当前币种，汇总和统计按币种分开计算。</div>`;
}
async function setCur(k) {
  S.cur = k;
  await metaSet('cur', k);
}

/* ---------- 分类管理 弹层 ---------- */
function sheetCats() {
  const C = S.sheet;
  return `
  <div class="sheet-head">
    <span class="txt"></span>
    <div class="seg">
      <button data-action="cats-type" data-v="expense" class="${C.type === 'expense' ? 'on' : ''}">支出分类</button>
      <button data-action="cats-type" data-v="income" class="${C.type === 'income' ? 'on' : ''}">收入分类</button>
    </div>
    <button class="txt right strong" data-action="close-sheet">完成</button>
  </div>
  <div class="add-cat">
    <input id="c-name" placeholder="新分类名称" maxlength="6" aria-label="名称">
    <button data-action="add-cat">添加</button>
  </div>
  <div class="card cat-list">
    ${S.cats.filter(c => c.type === C.type).map(c => `<div class="item"><span class="t">${esc(c.name)}</span><button class="rm" data-action="rm-cat" data-id="${esc(c.id)}">删除</button></div>`).join('')}
  </div>`;
}
async function addCat() {
  const C = S.sheet;
  const name = $('#c-name').value.trim();
  if (!name) return toast('请输入分类名称');
  if (S.cats.some(c => c.type === C.type && c.name === name)) return toast('这个分类已经有了');
  S.cats.push({ id: 'c_' + uid(), type: C.type, name });
  await metaSet('cats', S.cats);
  renderSheet();
}
async function rmCat(id) {
  const c = cat(id);
  if (S.cats.filter(x => x.type === c.type).length <= 1) return toast('至少保留一个分类');
  const used = S.txs.filter(t => t.cat === id).length;
  if (!confirm(`删除分类「${c.name}」？${used ? `\n已有 ${used} 笔记录使用它，这些记录会保留，但显示为「已删除分类」。` : ''}`)) return;
  S.cats = S.cats.filter(x => x.id !== id);
  await metaSet('cats', S.cats);
  renderSheet();
}

/* ---------- 备份 ---------- */
async function saveFile(name, text, mime) {
  const file = new File([text], name, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function exportJSON() {
  if (!S.txs.length) return toast('还没有记录可以导出');
  saveFile(`记账本备份-${today()}.json`, JSON.stringify({ app: 'ledger', version: 1, exported: new Date().toISOString(), cats: S.cats, txs: S.txs }, null, 1), 'application/json');
}
function exportCSV() {
  if (!S.txs.length) return toast('还没有记录可以导出');
  const q = s => `"${String(s).replace(/"/g, '""')}"`;
  const rows = [...S.txs].sort((a, b) => a.date.localeCompare(b.date) || a.created - b.created)
    .map(t => [t.date, t.type === 'income' ? '收入' : '支出', q(cat(t.cat).name), (t.amount / 100).toFixed(CUR[curOf(t)].dec), curOf(t), q(t.note || '')].join(','));
  saveFile(`记账本-${today()}.csv`, '﻿日期,类型,分类,金额,币种,备注\n' + rows.join('\n'), 'text/csv');
}
async function importJSON(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('文件不是有效的备份'); }
  const txs = Array.isArray(data?.txs) ? data.txs.filter(t =>
    t && typeof t.id === 'string' && (t.type === 'expense' || t.type === 'income') &&
    Number.isInteger(t.amount) && t.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(t.date)) : null;
  if (!txs || data.app !== 'ledger') return toast('文件不是有效的备份');
  if (!confirm(`备份中有 ${txs.length} 笔记录，导入后会与现有数据合并（相同的记录以备份为准）。继续吗？`)) return;
  const clean = txs.map(t => ({ id: t.id, type: t.type, cat: String(t.cat ?? ''), amount: t.amount, cur: curOf(t), date: t.date, note: String(t.note ?? '').slice(0, 40), created: Number(t.created) || Date.now() }));
  await dbPutMany(clean);
  if (Array.isArray(data.cats)) {
    for (const c of data.cats) {
      if (c && typeof c.id === 'string' && typeof c.name === 'string' && (c.type === 'expense' || c.type === 'income') && !S.cats.some(x => x.id === c.id))
        S.cats.push({ id: c.id, type: c.type, name: c.name.slice(0, 6) });
    }
    await metaSet('cats', S.cats);
  }
  S.txs = await dbAll();
  render();
  toast(`已导入 ${clean.length} 笔记录`);
}
async function wipe() {
  if (!S.txs.length) return toast('没有可清空的记录');
  if (!confirm(`确定清空全部 ${S.txs.length} 笔记录吗？此操作无法恢复，建议先导出备份。`)) return;
  if (!confirm('再确认一次：真的要删除所有账目吗？')) return;
  await dbClear();
  S.txs = [];
  render();
  toast('已清空');
}

/* ---------- 渲染 ---------- */
function render() {
  $('#view').innerHTML = S.tab === 'home' ? viewHome() : S.tab === 'stats' ? viewStats() : viewSettings();
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  $('#fab').hidden = S.tab !== 'home';
  if (S.tab === 'stats') drawTrend();
}
function renderSheet() {
  const k = S.sheet.kind;
  $('#sheet').innerHTML = k === 'edit' ? sheetEdit() : k === 'cur' ? sheetCur() : sheetCats();
  $('#sheet-root').hidden = false;
  document.documentElement.classList.add('sheet-open');
}
function closeSheet() {
  const wasCats = S.sheet?.kind === 'cats';
  S.sheet = null;
  $('#sheet-root').hidden = true;
  document.documentElement.classList.remove('sheet-open');
  if (wasCats) render();
}
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1800);
}

/* ---------- 事件 ---------- */
const ACTIONS = {
  tab(el) { S.tab = el.dataset.tab; render(); scrollTo(0, 0); },
  period(el) {
    const d = Number(el.dataset.d), now = today();
    if (el.dataset.scope === 'home') S.month = d ? shiftMonth(S.month, d) : now.slice(0, 7);
    else if (S.stats.mode === 'month') S.stats.month = d ? shiftMonth(S.stats.month, d) : now.slice(0, 7);
    else S.stats.year = d ? String(Number(S.stats.year) + d) : now.slice(0, 4);
    render();
  },
  add() { openEdit(null); },
  edit(el) { const t = S.txs.find(x => x.id === el.dataset.id); if (t) openEdit(t); },
  'close-sheet': closeSheet,
  'edit-type'(el) {
    const E = S.sheet;
    if (E.type === el.dataset.v) return;
    E.type = el.dataset.v;
    E.cat = S.cats.find(c => c.type === E.type)?.id;
    renderSheet();
  },
  'pick-cat'(el) {
    S.sheet.cat = el.dataset.id;
    document.querySelectorAll('.cat').forEach(b => b.classList.toggle('on', b === el));
    $('#who').textContent = cat(el.dataset.id).name;
  },
  // 点币种按钮打开下拉菜单，再点一次或点菜单外面关闭
  'edit-cur'() { S.sheet.curMenu = !S.sheet.curMenu; renderSheet(); },
  'close-cur-menu'() { S.sheet.curMenu = false; renderSheet(); },
  'edit-pick-cur'(el) {
    const E = S.sheet;
    E.cur = el.dataset.v;
    E.curMenu = false;
    if (!CUR[E.cur].dec && E.amt.includes('.')) E.amt = E.amt.split('.')[0];
    renderSheet();
  },
  'open-cur'() { S.sheet = { kind: 'cur' }; renderSheet(); },
  async 'pick-cur'(el) {
    const k = el.dataset.v;
    closeSheet();
    if (k === S.cur) return;
    await setCur(k);
    render();
    toast(`已切换为${CUR[k].name}`);
  },
  key(el) { pressKey(el.dataset.k); },
  'save-tx': saveTx,
  async 'delete-tx'() {
    if (!confirm('删除这笔记录？')) return;
    const id = S.sheet.id;
    await dbDel(id);
    S.txs = S.txs.filter(t => t.id !== id);
    closeSheet(); render(); toast('已删除');
  },
  'stats-mode'(el) { S.stats.mode = el.dataset.v; render(); },
  'stats-type'(el) { S.stats.type = el.dataset.v; render(); },
  bar(el) { selectBar(Number(el.dataset.i)); },
  slice(el) {
    // 点一块显示该分类，再点一次恢复总额
    const box = $('#donut'), on = !el.classList.contains('sel');
    box.querySelectorAll('.slice.sel').forEach(x => x.classList.remove('sel'));
    el.classList.toggle('sel', on);
    box.classList.toggle('has-sel', on);
    const src = on ? el : box;
    $('#d-k').textContent = src.dataset.name;
    $('#d-v').textContent = src.dataset.val;
  },
  'open-cats'() { S.sheet = { kind: 'cats', type: 'expense' }; renderSheet(); },
  'cats-type'(el) { S.sheet.type = el.dataset.v; renderSheet(); },
  'add-cat': addCat,
  'rm-cat'(el) { rmCat(el.dataset.id); },
  'export-json': exportJSON,
  'export-csv': exportCSV,
  'import-json'() { $('#import-file').click(); },
  wipe,
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el && ACTIONS[el.dataset.action]) ACTIONS[el.dataset.action](el);
});
document.addEventListener('input', e => {
  if (!S.sheet || S.sheet.kind !== 'edit') return;
  if (e.target.id === 'f-date') S.sheet.date = e.target.value;
  if (e.target.id === 'f-note') S.sheet.note = e.target.value;
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'f-note') e.target.blur(); });
$('#import-file').addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) importJSON(f);
});
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (S.tab === 'stats') drawTrend(); }, 150); });

/* ---------- 启动 ---------- */
(async function init() {
  try {
    db = await openDB();
    S.txs = await dbAll();
    S.cats = (await metaGet('cats')) || null;
    if (!S.cats) { S.cats = DEFAULT_CATS.map(c => ({ ...c })); await metaSet('cats', S.cats); }
    const savedCur = await metaGet('cur');
    if (CUR[savedCur]) S.cur = savedCur;
  } catch (err) {
    $('#view').innerHTML = `<div class="empty"><span class="big">⚠️</span>无法打开本地存储。<br>请确认没有使用无痕浏览模式。</div>`;
    return;
  }
  render();
  // 请求浏览器不要自动清理本机数据
  navigator.storage?.persist?.().catch(() => {});
  // 离线支持：本地调试时默认不启用缓存，加 ?sw=1 可强制启用
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && (!local || location.search.includes('sw=1'))) {
    // 新版本接管后自动刷新一次，让改动立即生效（首次安装不刷新；正在记账时不打断）
    const hadSW = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadSW && !S.sheet) location.reload(); });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
      // 从后台切回来时也检查一次更新（主屏幕 App 常常不会真正重启）
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(() => {});
  }
})();
