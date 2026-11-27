/* 小引：状态说明（对应桌面的悬停提示）和介绍页（动作与回执的对应）。 */
'use strict';
const PET_GROUPS = [
  ['常驻', ['idle', 'sleep']],
  ['对话', ['listen', 'think', 'talk']],
  ['工作', ['queued', 'handoff', 'received', 'working', 'unknown', 'review', 'done', 'failed']],
  ['互动', ['poke', 'drag']],
];
const PET_RULES = [
  '交接卡授权了但还没有回执，只播「已记下」。「送出」是对「电脑已收到」回执的反应，不是对你点击的反应。',
  '发送结果不知道时播「送达待核对」：伴星不回来，也不进入「执行中」。',
  '「待验收」和「完成」分开：回合结束不等于完成，你核对之后才播「完成」。',
  '重开应用按账本的当前状态直接进入对应动作，不重播「送出」和「完成」。',
];

/* 点状态文字打开：每项工作的准确状态，并能跳到最需要处理的一项。 */
SHEETS.pet = () => {
  const a = petNow(), d = PET.animations[a], live = liveTasks();
  const order = ['failed', 'verify', 'review', 'running', 'received', 'sending', 'local'];
  const sorted = [...live].sort((x, y) => order.indexOf(x.stage) - order.indexOf(y.stage));
  const first = sorted[0];
  const work = S.mode !== 'work' ? box('生活模式下不显示工作状态。', '', 'sun')
    : sorted.length ? group(sorted.map(t => row({ img: EXEC[t.exec].img, title: esc(t.title), sub: `${STAGE[t.stage].label} · ${STAGE[t.stage].who || ''}`, act: 'go', arg: `receipt:${t.id}` })))
      : box('没有交出去的工作在进行。', '', 'check');
  return sheet(`${esc(S.set.persona.name)}现在`, `
    <div class="pet-now">${Pet.html(a, 2, 'sheet')}<div><b>${d.label}</b><span>${esc(d.trigger)}</span></div></div>
    ${work}
    ${first ? `<button class="btn pri block" data-act="go" data-arg="receipt:${first.id}">去处理最要紧的一项</button>` : ''}
    <button class="btn text" data-act="go" data-arg="pet">认识小引 ›</button>`);
};

SCREENS.pet = () => {
  const a = S.flags.petDemo || 'idle', d = PET.animations[a];
  return page({
    title: '小引',
    body: `<div class="pb">
      <div class="pet-stage">${Pet.html(a, 3, 'demo')}</div>
      <div class="pet-info"><b>${d.label}</b><span>${esc(S.flags.petWhy || d.trigger)}</span>
        <div class="btns" style="justify-content:center"><button class="btn pri sm" data-act="petDemo">${ic('play', 'sm fill')}演示派工</button><button class="btn ghost sm" data-act="petPlay" data-arg="poke">戳一下</button></div></div>
      <div style="padding:6px 14px 0">${box('<b>伴星在哪，任务就在哪</b>', 'accent', 'spark')}</div>
      ${PET_GROUPS.map(([title, names]) => `${sec(title)}<div class="pet-grid">${names.map(n => `<button class="${n === a ? 'on' : ''}" data-act="petPlay" data-arg="${n}">${Pet.html(n, 1, `g-${n}`)}<b>${PET.animations[n].label}</b></button>`).join('')}</div>`).join('')}
      ${sec('设置')}${group([
        row({ icon: 'eye', title: '在首页显示', right: tg(S.set.pet.show, 'flip', 'set.pet.show', '在首页显示小引') }),
        row({ icon: 'moon', tone: 'gray', title: '免打扰', right: tg(S.set.pet.dnd, 'flip', 'set.pet.dnd', '小引免打扰') }),
      ])}</div>`,
  });
};
ACT.petPlay = n => { GEN_PET++; S.flags.petBase = PET.animations[n].loop ? n : (S.flags.petBase || 'idle'); S.flags.petDemo = n; S.flags.petWhy = ''; render(); };
let GEN_PET = 0;
ACT.petDemo = async () => {
  const mine = ++GEN_PET;
  const steps = [
    [0, 'listen', '你在输入'], [1700, 'think', '请求已发出，还没有输出'], [1700, 'talk', '小引在回答，给出交接卡'],
    [2300, 'queued', '你点了「交给电脑」；还没有回执'], [2600, 'handoff', '模拟：电脑的「已收到」回执到了'],
    [3000, 'working', '模拟：执行端确认回合开始'], [3400, 'review', '模拟：回合结束，有结果，等你核对'], [3000, 'done', '模拟：你核对通过'],
  ];
  for (const [wait, name, why] of steps) {
    await sleep(wait);
    if (mine !== GEN_PET || cur().n !== 'pet') return;
    S.flags.petDemo = name; S.flags.petWhy = why; S.flags.petBase = 'idle';
    render();
  }
};
/* 介绍页上的一次性动作播完之后转入下一个动作。 */
function petDemoEnd(name) {
  const a = PET.animations[name];
  S.flags.petDemo = a.next || S.flags.petBase || 'idle';
  if (cur().n === 'pet') render();
}
