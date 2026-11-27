/* 设计规范页：定位、原则、颜色、字号、状态词表、图标、小引、组件。 */
'use strict';
const EMBLEMS = [
  ['note', '记一笔'], ['voice-note', '语音记一笔'], ['memory', '记忆'], ['reminder', '提醒'], ['persona', '人格与风格'], ['permissions', '权限'],
  ['usage', '用量与花费'], ['mode-life', '生活模式'], ['mode-work', '工作模式'], ['weather-rain', '天气与预警'], ['nearby', '附近的吃和玩'], ['daily-brief', '每日简报'],
  ['album', '相册整理'], ['camera-ask', '拍照即问'], ['link-read', '链接与文件'], ['diagram', '架构图'], ['slides', 'PPT'], ['handoff', '交接'],
  ['receipt', '回执'], ['decision', '决定'], ['exec-codex', 'Codex'], ['exec-dsh', 'DSH'], ['agent-tree', 'Agent 结构'], ['relay', '跨网络送达'],
  ['computer-asleep', '电脑离线'], ['offline-phone', '手机断网'], ['find-sessions', '找会话'], ['phone-assistant', '手机助手'], ['backup', '备份'], ['app-lock', '应用锁'], ['all-clear', '都处理完了'],
];
const STAGE_EVIDENCE = {
  local: '只保存在手机上，还没有尝试发送', received: 'Hub 已登记，仍在排队；没有开始证据', verify: '可能已经送出，但缺少匹配的回执',
  running: '原执行端确认对应的回合已开始', review: '回合结束且有结果，等约定检查或你核对', done: '通过约定检查，或你核对之后',
  failed: '原执行端的失败回执，或核对没有通过', cancelled: '你在发送之前撤销',
};
const TOKEN_KEYS = [['--bg', '底色'], ['--surface', '卡片'], ['--surface-2', '次级面'], ['--ink', '标题'], ['--text', '正文'], ['--muted', '次要'], ['--accent', '强调'], ['--accent-soft', '强调浅'], ['--line', '分隔']];

function renderSpec() {
  const el = $('#view-spec');
  if (el.dataset.done) return;
  el.dataset.done = '1';
  const themes = [['mode-work', '工作 · 浅色'], ['mode-life', '生活 · 浅色'], ['mode-work dark', '工作 · 深色'], ['mode-life dark', '生活 · 深色']];
  const masks = (name, alt) => `<div class="icon-masks">
    <figure><img src="${A(name)}" class="m-squircle" width="96" height="96" alt="${alt}"><figcaption>启动器</figcaption></figure>
    <figure><img src="${A(name)}" class="m-circle" width="64" height="64" alt=""><figcaption>圆形遮罩</figcaption></figure>
    <figure><img src="${A(name)}" class="m-squircle" width="48" height="48" alt=""><figcaption>48</figcaption></figure>
    <figure><img src="${A(name)}" class="m-squircle" width="24" height="24" alt=""><figcaption>24</figcaption></figure></div>`;
  const stages = ['local', 'received', 'verify', 'running', 'review', 'done', 'failed', 'cancelled'];
  el.innerHTML = `
    <h1>设计规范</h1>
    <p class="lede">一个用自己的额度、不受免费应用限额约束的私人助手。<b>随手记、接着聊、记得你，要动手时交给电脑上的 agent。</b></p>
    <p class="lede" style="color:var(--p-muted);font-size:13px">依据：docs/mobile-assistant-v2.md、docs/mobile-manager-v1.md、docs/desktop-pet.md。这一页是原型用到的视觉与文案约定，不是实现。</p>

    <section><h2>六条原则</h2><p>每一屏都按这几条取舍。</p>
      <div class="sp-card principles">
        <div><b>入口只有一个</b>首页就是对话和一个输入框。新能力以对话里的卡片和助手可用的工具出现，不加功能面板，不设底部标签。</div>
        <div><b>状态只跟证据走</b>没有回执就不往前显示。结果不知道时写「待核对」，不用一句「正在处理」盖过去。小引也只播有证据的动作。</div>
        <div><b>看得见，撤得回</b>工具过程、来源、用到的记忆、花了多少，都在答复下面。写入之后留一条「撤销」。</div>
        <div><b>原文不动</b>笔记原文、对话原文逐字保留。标签、摘要这些是另存的一层，可以整体清除。</div>
        <div><b>两种模式，两种颜色</b>工作是主星的紫，生活是伴星的琥珀。内容去向不同，颜色要一眼分得清。</div>
        <div><b>做不到的事照实写</b>通知只能尽量送达、数据源还没选定、某个模型看不了图，都直接写在界面上。</div>
      </div></section>

    <section><h2>颜色</h2><p>四套主题共用同一组状态色。颜色值取自页面上实际生效的设计令牌。</p>
      <div class="sp-grid c2">${themes.map(([cls, label]) => `<div class="device flat ${cls} theme-demo" data-theme><small style="color:var(--muted)">${label}</small>
        <div class="swatches" data-swatches></div>
        <div class="demo-row" style="margin-top:14px"><button class="btn pri sm">交给电脑</button><button class="btn soft sm">记一笔</button><button class="btn ghost sm">改目标</button><span class="chip sm on">已选</span><span class="chip sm">标签</span></div>
        <div class="demo-row">${['gray', 'blue', 'amber', 'violet', 'green', 'red'].map((t, i) => badge(['已记下', '电脑已收到', '执行中', '待验收', '已完成', '执行失败'][i], t)).join('')}</div></div>`).join('')}</div></section>

    <section><h2>字号与文案</h2><p>用系统中文字体。<b>能用图标表达的就不再加介绍：</b>列表直接显示内容，当前值放右侧；并列操作用图标和短标签。回执优先显示状态和结果，完整记录可以展开。同意与费用提示放在确认前。</p>
      <div class="sp-card">
        <div class="type-row"><small>问候 · 25 / 750</small><span style="font-size:25px;font-weight:750">上午好，阿霖</span></div>
        <div class="type-row"><small>页面标题 · 16.5 / 650</small><span style="font-size:16.5px;font-weight:650">登录页改版</span></div>
        <div class="type-row"><small>正文 · 15 / 1.7</small><span style="font-size:15px">周六多云，周日下午转小雨，建议把出门放在周六。</span></div>
        <div class="type-row"><small>卡片标题 · 15 / 650</small><span style="font-size:15px;font-weight:650">登录页主按钮改为「继续」</span></div>
        <div class="type-row"><small>说明 · 12.5</small><span style="font-size:12.5px;color:var(--p-muted)">LAPTOP-8F2M4C · Codex 原会话「登录页重构」</span></div>
        <div class="type-row"><small>状态标签 · 12 / 650</small><span style="font-size:12px;font-weight:650">电脑已收到，等待执行</span></div>
      </div></section>

    <section><h2>状态词表</h2><p>手机上的状态文案、需要的证据和小引的动作一一对应。文案由程序生成，不经模型改写，也不随人格设定变化。</p>
      <div class="sp-card device flat mode-work" style="padding:6px 18px"><table class="sp-table"><tr><th>手机显示</th><th>已有的证据</th><th>小引</th></tr>
        ${stages.map(k => { const s = STAGE[k], p = s.pet ? PET.animations[s.pet] : null; return `<tr><td>${badge(s.label, s.tone)}</td><td>${STAGE_EVIDENCE[k]}</td><td>${p ? `${p.label} <code>${s.pet}</code>` : k === 'done' ? `完成 <code>done</code>，播一次` : '—'}</td></tr>`; }).join('')}
      </table></div></section>

    <section><h2>应用图标</h2><p>沿用现有图标，另给两个候选。定位从工作总管扩成个人助手之后要不要换，由用户决定。三张都是 2026-11-25 前后用 gpt-image-2.5-sunburst 生成的全幅方图，遮罩由启动器套用。</p>
      <div class="sp-grid c3">
        <div class="sp-card icon-cand"><b>A · 引导星与伴星（现用）</b><p>白色引导星加琥珀伴星，弧线表示手机与电脑相连。已装在手机上。</p>${masks('app-icon-a', '现用图标')}</div>
        <div class="sp-card icon-cand"><b>C · 小引</b><p>把小引放上图标：更像一个助手，也和应用里的形象对得上。小尺寸下靠剪影和伴星辨认。</p>${masks('app-icon-c', '候选 C')}</div>
        <div class="sp-card icon-cand"><b>D · 从夜到晨</b><p>紫到琥珀的渐变对应工作和生活两种模式，图形仍是引导星与伴星。</p>${masks('app-icon-d', '候选 D')}</div>
      </div></section>

    <section><h2>特殊图标</h2><p>${EMBLEMS.length} 张，256 px 透明底，同一套柔和的立体风格。用在页面头部、对话卡片和空状态；小尺寸的操作图标另用线性图标。Codex 和 DSH 是原创的几何图形，不是对应产品的官方标志。</p>
      <div class="em-grid">${EMBLEMS.map(([n, label]) => `<figure><img src="${A(n)}" alt="" loading="lazy"><b>${label}</b>${n}</figure>`).join('')}</div></section>

    <section><h2>界面小图标</h2><p>24 格线性图标，内联 SVG，跟随文字颜色，不用生成图。</p>
      <div class="ic-grid">${Object.keys(ICONS).map(k => `<span><svg viewBox="0 0 24 24">${ICONS[k]}</svg>${k}</span>`).join('')}</div></section>

    <section><h2>小引</h2><p>和桌面端是同一套精灵表：每帧 64×64，15 个动作共 142 帧，只按整数倍显示。动作与触发证据以 docs/desktop-pet.md 为准，手机没有新增动作。</p>
      <div class="pet-spec">${Object.entries(PET.animations).map(([k, a]) => `<figure>${Pet.html(k, 2, `spec-${k}`)}<b>${a.label} <code>${k}</code></b>${esc(a.trigger)}</figure>`).join('')}</div>
      <h3>几条不会破的规矩</h3><div class="sp-card"><ul style="margin:0;padding-left:18px">${PET_RULES.map(r => `<li>${r}</li>`).join('')}</ul></div><h3>在手机上的位置</h3>
      <div class="sp-card">首页头像处：没有消息时 2 倍大小居中，开始对话后缩成顶部的 1 倍头像，旁边一行状态文字。点小引播放「戳一下」，拖动播放「拖动」；点状态文字打开状态说明，可跳到最需要处理的那项工作。生活模式下不播放工作状态。不做系统级悬浮窗。</div></section>

    <section><h2>组件</h2><p>都由同一组令牌驱动，换模式和深浅色不用改组件。</p>
      <div class="sp-grid c2">${[['mode-work', '工作'], ['mode-life', '生活']].map(([cls, label]) => `<div class="device flat ${cls}"><div class="demo-row"><small style="color:var(--muted);font-weight:700">${label}模式</small></div>
        <div class="demo-row"><button class="btn pri">${ic('up', 'sm')}交给电脑</button><button class="btn soft">挂到项目</button><button class="btn ghost">改目标</button><button class="btn danger sm">撤销</button></div>
        <div class="demo-row"><span class="tg on"></span><span class="tg"></span><div class="seg" style="flex:1"><button class="on">最近</button><button>项目</button><button>分类</button></div></div>
        <div class="demo-row"><span class="chip">${ic('spark', 'xs')}Flash</span><span class="fchip">${ic('jar', 'xs')}2</span><span class="fchip">≈¥0.033</span><span class="ibtn sm">${ic('export', 'sm')}</span><span class="tag codex">Codex</span><span class="tag dsh">DSH</span></div>
        <div class="demo-row"><div class="savedline">${ic('pen', 'xs')}<span>记进收件箱：阳台的薄荷该换盆了</span><button>撤销</button></div></div>
        <div class="demo-row" style="display:block"><div class="composer"><div class="c-in" style="color:var(--faint)">说说要做的事，或“接着昨天那个…”</div><div class="c-row"><span class="c-btn">${ic('plus')}</span><span class="c-model">${ic('spark', 'xs')}Flash</span><span class="c-sp"></span><span class="c-note">${ic('pen', 'sm')}记一笔</span><span class="c-send">${ic('up')}</span></div></div></div></div>`).join('')}</div></section>`;
  $$('[data-theme]', el).forEach(box => {
    const cs = getComputedStyle(box);
    box.querySelector('[data-swatches]').innerHTML = TOKEN_KEYS.map(([k, label]) => { const v = cs.getPropertyValue(k).trim(); return `<span class="swatch" style="color:var(--muted)"><i style="background:${v}"></i><b style="color:var(--ink)">${label}</b><code>${v}</code></span>`; }).join('');
    box.style.background = cs.getPropertyValue('--bg');
  });
}
