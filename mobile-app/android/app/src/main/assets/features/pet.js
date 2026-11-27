import './pet-data.js';
import { WORK } from './modes.js';

const { animations, frameWidth, frameHeight } = window.ALCOR_PET;
const priority = ['failed', 'unknown', 'review', 'working', 'received', 'queued'];
const lines = {
  idle: '待命', sleep: '休息中', listen: '在听', think: '在想', talk: '在回答',
  poke: '嘿', drag: '被拎起来了', handoff: '电脑已收到', done: '完成',
  failed: '执行失败', unknown: '送达待核对', review: '待验收', working: '执行中',
  received: '电脑已收到', queued: '已记下',
};

export function workPose(w, peers) {
  const r = w.receipt;
  if (w.stage === 'verify') return { pose: 'unknown' };
  if (w.stage === 'failed' && r?.stage === 'failed') return { pose: 'failed' };
  if (w.stage === 'review' && r?.stage === 'review')
    return r.evidenceHash ? { pose: 'review' } : { pose: 'received', label: '结果待同步' };
  if (w.stage === 'running' && r?.stage === 'running' && r.turnId) {
    return peers[w.peer]?.online ? { pose: 'working' } : { pose: 'unknown', label: '电脑未连接' };
  }
  if (w.stage === 'waiting' && r?.stage === 'waiting')
    return { pose: 'received', label: r.question ? '等你回答' : '等待权限' };
  if (w.stage === 'queued' && r?.stage === 'queued') return { pose: 'received' };
  if (['local', 'uploading', 'upload-paused', 'sending'].includes(w.stage) && w.command) return { pose: 'queued' };
  return null;
}

export const petCanvas = (slot = 'home') =>
  `<canvas class="pet-sprite" data-pet="${slot}" width="${frameWidth}" height="${frameHeight}" aria-hidden="true"></canvas>`;

/** Owns the animation clock, independent of re-rendering the WebView or streaming a message. */
export function petPlayer(root, state) {
  const sprite = new Image();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const seen = new Map(), chat = new Map();
  const frame = new WeakMap();
  let seeded = false, timer, lastActivity = performance.now(), typed, dragging, clickAfterDrag = false;
  let action = 'idle', started = performance.now(), shot, position, baseWork;

  const clock = () => performance.now();
  const shotFor = (pose, now) => {
    const a = animations[pose];
    return { pose, expiry: now + a.frames * 1000 / a.fps };
  };
  function observe(now, visible) {
    const { data, ui } = state();
    for (const w of Object.values(data.work)) {
      let mark = seen.get(w.id);
      if (!mark) {
        mark = { stages: new Set(), offset: 0 };
        seen.set(w.id, mark);
      }
      // A later authoritative receipt for the same request cannot replay a one-time motion.
      for (; mark.offset < w.log.length; mark.offset++) {
        const l = w.log[mark.offset];
        if ((!seeded || l.stage !== w.stage) && (l.stage === 'queued' || l.stage === 'done')) mark.stages.add(l.stage);
      }
      if (w.receipt?.stage !== w.stage || !['queued', 'done'].includes(w.stage) || mark.stages.has(w.stage)) continue;
      mark.stages.add(w.stage);
      if (seeded && visible && ui.mode === WORK) shot = shotFor(w.stage === 'queued' ? 'handoff' : 'done', now);
    }
    seeded = true;
  }
  function current(now, home) {
    const { ui } = state();
    if (shot && now >= shot.expiry) shot = null;
    if (dragging) return { pose: 'drag' };
    if (shot?.pose === 'poke') return shot;
    if (home && !ui.sheet) {
      const talking = chat.get(ui.current);
      if (talking) return { pose: talking };
      if (typed?.id === ui.current && typed.until > now) return { pose: 'listen' };
    }
    const work = home && ui.mode === WORK ? baseWork : undefined;
    if (work && priority.indexOf(work.pose) < 3) return work;
    if (shot && home && ui.mode === WORK && !ui.sheet) return shot;
    if (work) return work;
    return { pose: now - lastActivity >= 120000 ? 'sleep' : 'idle' };
  }
  function draw(canvas, pose, elapsed) {
    if (!sprite.naturalWidth) return;
    const a = animations[pose], n = reduced.matches ? 0 : Math.min(a.frames - 1, Math.floor(elapsed * a.fps / 1000));
    const index = a.loop && !reduced.matches ? Math.floor(elapsed * a.fps / 1000) % a.frames : n;
    const signature = pose + ':' + index;
    if (frame.get(canvas) === signature) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, frameWidth, frameHeight);
    ctx.drawImage(sprite, index * frameWidth, a.row * frameHeight, frameWidth, frameHeight, 0, 0, frameWidth, frameHeight);
    frame.set(canvas, signature);
  }
  function paint() {
    clearTimeout(timer);
    const canvas = root.querySelector('[data-pet="home"]'), profile = root.querySelector('[data-pet="profile"]');
    if (document.hidden || (!canvas && !profile)) return;
    if (profile) draw(profile, 'idle', 0);
    if (!canvas) return;
    const now = clock(), next = current(now, true);
    if (next.pose !== action) { action = next.pose; started = now; }
    const label = root.querySelector('[data-pet-label]');
    if (label) {
      const words = next.label ?? lines[action];
      if (label.textContent !== words) label.textContent = words;
    }
    canvas.dataset.motion = action;
    if (position) canvas.style.transform = `translate(${position.x}px,${position.y}px)`;
    else if (canvas.style.transform) canvas.style.transform = '';
    draw(canvas, action, now - started);
    timer = setTimeout(paint, reduced.matches ? 250 : 1000 / animations[action].fps);
  }
  function sync() {
    const { data, ui } = state();
    const home = !!root.querySelector('[data-pet="home"]');
    const visible = !document.hidden && ui.mode === WORK && !ui.sheet && home;
    if (!visible && shot?.pose !== 'poke') shot = null;
    if (!home) { dragging = false; position = null; }
    observe(clock(), visible);
    baseWork = undefined;
    if (home && ui.mode === WORK) {
      for (const w of Object.values(data.work)) {
        const next = workPose(w, data.peers);
        if (!next) continue;
        if (!baseWork || priority.indexOf(next.pose) < priority.indexOf(baseWork.pose)) baseWork = next;
        if (baseWork.pose === 'failed') break;
      }
    }
    paint();
  }
  sprite.addEventListener('load', paint);
  sprite.src = 'assets/pet/' + window.ALCOR_PET.image;
  reduced.addEventListener('change', paint);
  return {
    sync,
    hide() { shot = null; dragging = false; position = null; typed = null; paint(); },
    touch() { lastActivity = clock(); },
    input(id) { lastActivity = clock(); typed = { id, until: lastActivity + 1100 }; paint(); },
    chat(id, phase) { if (phase) chat.set(id, phase); else chat.delete(id); lastActivity = clock(); paint(); },
    drag(x, y) { dragging = true; position = { x, y }; paint(); },
    stopDrag() {
      if (!dragging) return;
      dragging = false; position = null; clickAfterDrag = true; lastActivity = clock();
      setTimeout(() => { clickAfterDrag = false; }, 0);
      paint();
    },
    poke() {
      if (clickAfterDrag) return;
      lastActivity = clock();
      shot = shotFor('poke', lastActivity);
      paint();
    },
  };
}
