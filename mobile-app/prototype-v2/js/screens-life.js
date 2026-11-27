/* 生活：提醒、天气与问候、附近的吃和玩、每日简报；以及应用之外的系统入口（主屏幕、快捷方式、小组件、分享、通知）。 */
'use strict';

/* ================= 提醒 ================= */
SCREENS.reminders = () => {
  const tab = S.tabs.rem;
  const list = S.rems.filter(r => r.mode === S.mode && (tab === 'next' ? !r.done : r.done));
  const warn = S.set.sys.exact === 'denied' ? `<div style="padding:0 14px 10px">${box('没有精确定时许可，可能晚几分钟 <button class="btn text" data-act="go" data-arg="perms" style="height:20px">权限</button>', 'amber', 'warn')}</div>` : '';
  return page({
    title: '提醒',
    head: `<div class="seg-wrap">${seg([['next', '待提醒'], ['done', '已过']], tab, 'tabRem')}</div>`,
    body: `<div class="pb">${warn}${list.length ? `<div class="group">${list.map(r => `<div class="row"><span class="tile tone-blue">${ic('alarm')}</span><button class="row-t" data-act="sheet" data-arg="remedit:${r.id}"><b>${esc(r.text)}</b><small>${esc(r.when)}</small></button>${r.done ? '' : tg(r.on, 'remFlip', r.id, r.text)}</div>`).join('')}</div>`
      : `<div class="empty">${em('reminder', 88)}<b>${tab === 'next' ? '没有待提醒的事' : '还没有'}</b></div>`}</div>`,
    dock: `<button class="fab round" data-act="sheet" data-arg="remedit" aria-label="新提醒">${ic('plus')}</button>`,
  });
};
ACT.tabRem = v => { S.tabs.rem = v; render(); };
ACT.remFlip = id => { const r = S.rems.find(x => x.id === id); r.on = !r.on; render(); toast(r.on ? '已恢复提醒' : '已取消这个提醒'); };
SHEETS.remedit = ({ id }) => {
  const r = S.rems.find(x => x.id === id);
  return sheet(r ? '提醒详情' : '新提醒', `<div class="form"><label>内容<input class="field" id="rem-body" value="${esc(r?.text ?? '')}"></label>
    <label>提醒时间<input class="field" type="datetime-local" id="rem-at"></label></div>
    <div class="btns"><button class="btn pri grow" data-act="remSave" data-arg="${esc(id ?? '')}">保存</button>${r && !r.done ? `<button class="btn ghost" data-act="remFlip" data-arg="${esc(id)}">取消提醒</button>` : ''}</div>`);
};
ACT.remSave = id => {
  const text = document.querySelector('#rem-body').value.trim(), at = document.querySelector('#rem-at').value;
  if (!text || !at) return toast('请填写内容和提醒时间');
  const when = at.replace('T', ' ');
  const r = S.rems.find(x => x.id === id);
  if (r) Object.assign(r, { text, when });
  else S.rems.unshift({ id: uid('r'), mode: S.mode, text, when, on: true, done: false });
  S.sheet = null; render(); toast('提醒已设');
};

/* ================= 天气 ================= */
const wxIcon = k => ic(k === 'rain' ? 'rain' : 'cloud', 'sm');
function weatherBody() {
  return `<div class="wx"><div class="wx-now">${em('weather-rain', 72)}<div><b>${WX.temp}°</b><span>${WX.city} · ${WX.now}</span><small>${WX.lo}° – ${WX.hi}°</small></div></div>
    <div class="wx-hours">${WX.hours.map(([h, k, t]) => `<span class="${k}"><small>${h} 时</small>${wxIcon(k)}<b>${t}°</b></span>`).join('')}</div>
    ${box(`<b>${WX.rainAt} – ${WX.rainEnd} 有雨。</b>出门带伞。`, 'blue', 'umbrella')}</div>`;
}
SHEETS.weather = () => sheet(WX.city, `<div class="card">${weatherBody()}</div>
  ${group([
    row({ icon: 'bell', tone: 'blue', title: '下雨和预警通知', right: tg(S.set.notif.weather, 'flip', 'set.notif.weather', '下雨和预警通知') }),
    row({ icon: 'pin', tone: 'gray', title: '城市', right: esc(S.set.city), act: 'toast', arg: '原型：手填城市，或授权一次粗略位置' }),
  ])}
  <div class="hint center">示例数据 · 天气数据源还没有选定</div>`);
CARDS.weather = () => `<div class="card">${weatherBody()}<div class="hint">示例数据 · 数据源待选定</div></div>`;

/* ================= 附近的吃和玩 ================= */
CARDS.places = m => `<div class="card places"><div class="card-h">${em('nearby', 40)}<div class="t"><b>附近 ${m.items.length} 家</b></div></div>
  ${m.items.map((p, i) => `<div class="place"><div class="pl-h"><i>${i + 1}</i><b>${esc(p.name)}</b><button class="ib" data-act="toast" data-arg="原型：跳到地图应用导航" aria-label="地图">${ic('pin', 'sm')}</button><button class="ib" data-act="toast" data-arg="原型：跳到点评页，不代下单" aria-label="去看看">${ic('ext', 'sm')}</button></div>
    <small class="pl-meta">${esc(p.dist)} · ${p.tags.map(esc).join(' · ')}</small>
    <div class="pl-why">${md(p.why)}</div></div>`).join('')}</div>`;
SHEETS.locask = () => sheet('用一次你的位置？', `${hero('nearby')}<div class="hint center">只取这一次的粗略位置</div>`,
{ foot: `<button class="btn ghost grow" data-act="locNo">手填</button><button class="btn pri grow" data-act="locYes">允许这一次</button>` });
ACT.locYes = async () => { S.set.sys.location = 'granted'; S.set.tools.place_now = true; S.sheet = null; render(); if (S.flags.afterLoc) await S.flags.afterLoc(true); };
ACT.locNo = async () => { S.sheet = null; render(); if (S.flags.afterLoc) await S.flags.afterLoc(false); };

/* ================= 每日简报 ================= */
CARDS.brief = () => `<div class="card brief"><div class="card-h">${em('daily-brief', 40)}<div class="t"><b>今天</b><small>${S.date}</small></div></div>
  <div class="br-row" title="日程">${ic('cal', 'sm')}<span>14:00 看登录页改动 · 19:30 给妈妈回电话</span></div>
  <div class="br-row" title="天气">${ic('umbrella', 'sm')}<span>${WX.lo}–${WX.hi}°，${WX.rainAt} 后有雨</span></div>
  <div class="br-row" title="工作">${ic('brief', 'sm')}<span>1 个问题等你回答 · 1 项交接在等电脑</span></div>
  <div class="br-row" title="收件箱">${ic('note', 'sm')}<span>收件箱 6 条</span></div></div>`;

/* ================= 系统入口：主屏幕、长按、小组件、分享、通知 ================= */
const SYS_TABS = [['home', '主屏幕'], ['press', '长按图标'], ['share', '分享进来'], ['notif', '通知']];
function fakeApp(label, color, glyph) { return `<span class="l-app"><i style="background:${color}">${glyph ? ic(glyph) : ''}</i><small>${label}</small></span>`; }
SCREENS.launcher = () => {
  const v = S.flags.sys || 'home';
  const star = `<button class="l-app star${v === 'press' ? ' pressed' : ''}" data-act="sysOpen"><img src="${A(S.flags.icon || 'app-icon-a')}" width="56" height="56" alt=""><small>星引</small></button>`;
  const widgets = `<div class="w-row"><button class="widget w-note" data-act="sysCapture" data-arg="主屏幕小组件">${ic('pen')}<span>记一笔…</span><i data-act="sysVoice" role="button" aria-label="语音记一笔">${ic('mic', 'sm')}</i></button></div>
    <div class="w-row"><button class="widget w-pet" data-act="sysOpen">${Pet.html('queued', 1, 'widget')}<span><small>星引 · 工作</small><b>已记下，等电脑上线</b><em>登录页主按钮改为「继续」</em></span></button>
      <div class="w-clock"><b>${S.clock}</b><small>${S.date}</small><span>${ic('umbrella', 'xs')}${WX.rainAt} 后有雨</span></div></div>`;
  const grid = `<div class="l-grid">${fakeApp('微信', '#2bb673', 'chat')}${fakeApp('浏览器', '#3f73e8', 'globe')}${fakeApp('相册', '#f08a5d', 'image')}${star}</div>`;
  const press = v === 'press' ? `<div class="l-pop"><b>星引</b>
      <button data-act="sysCapture" data-arg="图标快捷方式">${ic('pen', 'sm')}记一笔</button><button data-act="sysVoice">${ic('mic', 'sm')}语音记一笔</button>
      <button data-act="sysNewChat">${ic('newchat', 'sm')}新对话</button><button data-act="sysCamera">${ic('camera', 'sm')}拍照即问</button></div>` : '';
  const share = v === 'share' ? `<div class="scrim" data-act="sysTab" data-arg="home"></div><div class="sheet l-share"><i class="grab"></i>
      <div class="ls-what">${ic('link')}<span><b>登录页设计模式 12 例</b><small>design.example/login-patterns · 来自浏览器</small></span></div>
      <div class="ls-apps"><button data-act="sysShare" data-arg="note"><img src="${A('app-icon-a')}" width="52" height="52" alt=""><span>星引<br><b>记一笔</b></span></button>
        <button data-act="sysShare" data-arg="chat"><img src="${A('app-icon-a')}" width="52" height="52" alt=""><span>星引<br><b>放进对话</b></span></button>
        ${fakeApp('微信', '#2bb673', 'chat')}${fakeApp('复制', '#8a90a8', 'copy')}</div>
      </div>` : '';
  const notif = v === 'notif' ? `<div class="l-shade"><small>通知</small>
      <button class="notif" data-act="sysNotif" data-arg="rem"><img src="${A('app-icon-a')}" width="22" height="22" alt=""><div><small>星引 · 提醒 · 现在</small><b>给妈妈回电话</b><span>19:30</span></div></button>
      <button class="notif" data-act="sysNotif" data-arg="wx"><img src="${A('app-icon-a')}" width="22" height="22" alt=""><div><small>星引 · 天气 · 17:20</small><b>40 分钟后有雨</b><span>上海 · 出门带伞</span></div></button>
      <button class="notif" data-act="sysNotif" data-arg="work"><img src="${A('app-icon-a')}" width="22" height="22" alt=""><div><small>星引 · 工作 · 10:31</small><b>待验收</b><span>${esc(computerLabel(S.computers.work))} · alcor-web</span></div></button>
      <p>工作通知只写类型、电脑名和项目名。</p></div>` : '';
  return `<div class="page launcher v-${v}"><div class="l-wall"></div>
    <div class="l-body">${widgets}${grid}${press}</div>
    <div class="l-dock">${fakeApp('', '#17a673', 'phone')}${fakeApp('', '#3f73e8', 'chat')}${fakeApp('', '#f5a524', 'camera')}${fakeApp('', '#8a90a8', 'grid')}</div>
    ${notif}${share}
    <div class="l-tabs">${SYS_TABS.map(([k, label]) => `<button class="${k === v ? 'on' : ''}" data-act="sysTab" data-arg="${k}">${label}</button>`).join('')}</div></div>`;
};
ACT.sysTab = v => { S.flags.sys = v; render(); };
function sysEnter() { S.stack = [{ n: 'home' }]; S.flags.sys = 'home'; }
ACT.sysOpen = () => { sysEnter(); S.enter = 'enter'; render(); };
ACT.sysCapture = via => { S.flags.capVia = via; S.flags.capFrom = 'launcher'; S.flags.sys = 'home'; openSheet('capture'); };
ACT.sysVoice = (a, el, e) => { if (e) e.stopPropagation(); S.flags.sys = 'home'; openSheet('voice'); recStart(); };
ACT.sysNewChat = () => { sysEnter(); ACT.newChat(); };
ACT.sysCamera = () => { sysEnter(); go('camera'); };
ACT.sysShare = k => {
  S.flags.sys = 'home';
  if (k === 'note') { S.flags.capVia = '分享自浏览器'; S.flags.capFrom = 'launcher'; S.flags.capText = ''; S.flags.capAtts = [{ icon: 'link', label: 'design.example/login-patterns', key: 'link' }]; return openSheet('capture'); }
  sysEnter();
  const id = uid('x');
  S.convs[id] = { id, mode: S.mode, kind: 'chat', title: '新对话', time: '刚刚', recent: '', used: 100, msgs: [{ kind: 'sys', text: '分享来的链接已备好，发送后才会去读' }] };
  S.mats[id] = [{ icon: 'link', label: 'design.example/login-patterns' }];
  go('chat', { id });
};
ACT.sysNotif = k => {
  sysEnter();
  if (k === 'rem') { S.mode = 'life'; return go('reminders'); }
  if (k === 'wx') { S.mode = 'life'; S.events.forEach(e => { if (e.type === 'weather') e.unread = false; }); S.enter = 'enter'; render(); return openSheet('weather'); }
  S.mode = 'work';
  const e = S.events.find(x => x.type === 'review');
  if (e) return ACT.openEvent(e.id);
  go('inbox');
};
