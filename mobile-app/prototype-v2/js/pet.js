/* 小引：复用桌面的精灵表（assets/pet，由 art/postprocess.ps1 从 desktop-app/assets/pet 同步）。
   动作与触发证据以 docs/desktop-pet.md 为准；这里只播放，不新增动作。 */
'use strict';
const PET = window.ALCOR_PET;
const Pet = (() => {
  const FW = PET.frameWidth, FH = PET.frameHeight;
  const clock = new Map(); // 同一只小引在重绘之后接着原来的帧播放
  let n = 0;
  let onEnd = () => {};
  const html = (anim, scale = 2, id = 'main', attrs = '') =>
    `<pet-sprite class="pet" data-pet="${id}" data-anim="${PET.animations[anim] ? anim : 'idle'}" style="--pet-s:${scale}" ${attrs}></pet-sprite>`;
  function tick(ts) {
    n++;
    const ended = [];
    for (const el of document.querySelectorAll('.pet')) {
      const name = el.dataset.anim, a = PET.animations[name];
      if (!a) continue;
      const live = !!el.closest('#device');
      const dev = el.closest('.device');
      const reduce = !!dev && dev.classList.contains('reduce');
      const scale = parseFloat(el.style.getPropertyValue('--pet-s')) || 2;
      const key = `${live ? 'L' : 'B'}:${el.dataset.pet}:${name}`;
      let c = clock.get(key);
      if (!c || c.seen < n - 1) { c = { frame: 0, last: ts, seen: n, adv: -1 }; clock.set(key, c); }
      if (c.adv !== n) {
        c.adv = n; c.seen = n;
        if (reduce) {
          // 减弱动画：循环动作只显示首帧，一次性动作直接结束
          c.frame = a.loop ? 0 : a.frames - 1;
          if (!a.loop && live && ts - c.last > 300) { clock.delete(key); ended.push([el.dataset.pet, name]); }
        } else if (ts - c.last >= 1000 / a.fps) {
          c.last = ts;
          if (c.frame + 1 < a.frames) c.frame++;
          else if (a.loop || !live) c.frame = 0;
          else { clock.delete(key); ended.push([el.dataset.pet, name]); }
        }
      }
      el.style.backgroundPosition = `${-c.frame * FW * scale}px ${-a.row * FH * scale}px`;
    }
    for (const [id, name] of ended) onEnd(id, name);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return { html, meta: PET, set onEnd(fn) { onEnd = fn; } };
})();

/* 按 desktop-pet.md 的显示顺序决定播哪个动作：互动 ＞ 对话 ＞ 工作状态 ＞ 常驻。 */
function petBase() {
  if (S.pet.drag) return 'drag';
  const onHome = cur().n === 'home' && !S.sheet && !S.drawer;
  if (onHome && S.busy === 'think') return 'think';
  if (onHome && S.busy === 'talk') return 'talk';
  if (onHome && S.typing) return 'listen';
  if (S.mode === 'work') {
    const have = new Set(liveTasks().map(t => STAGE[t.stage].pet));
    const order = S.set.pet.dnd ? ['failed', 'unknown', 'review'] : PET_ORDER;
    for (const k of order) if (have.has(k)) return k;
  }
  return S.pet.sleep ? 'sleep' : 'idle';
}
const petNow = () => S.pet.shot || petBase();

/* 小引旁边的一行状态文字：大类来自动作，准确文案在状态说明里。 */
function petLine() {
  const a = petNow();
  const talk = { listen: '在听', think: '在想', talk: '在回答', idle: '待命', sleep: '休息中', drag: '被拎起来了', poke: '嘿', handoff: '电脑收到了，送出', done: '完成' }[a];
  if (talk) return { text: talk, tone: a === 'done' ? 'green' : a === 'handoff' ? 'blue' : '' };
  const stageOf = { queued: 'local', received: 'received', working: 'running', unknown: 'verify', review: 'review', failed: 'failed' }[a];
  return { text: STAGE[stageOf].short, tone: STAGE[stageOf].tone };
}
function petCap() {
  const l = petLine();
  return `<button class="pet-cap ${l.tone ? 'tone-' + l.tone : ''}" data-act="sheet" data-arg="pet">${l.tone ? '<i class="dot"></i>' : ''}${esc(S.set.persona.name)} · ${esc(l.text)}${ic('right', 'xs')}</button>`;
}
