// Only an entire, explicit user command can create a folder. Model output never enters this parser.
const unquote = (s: string) =>
  s.trim().replace(/^[「“『《"](.+)[」”』》"]$/u, "$1");

export function loopIntent(raw: string) {
  const text = raw.trim().replace(
    /^(?:(?:星引)?总管[，,：:\s]*)?(?:(?:请(?:帮我|你)?|帮我|麻烦(?:帮我)?|直接|现在|开始|启动)\s*)*/,
    "",
  );
  const scoped = /^(?:在|为|给)\s*(.+?)\s*(?:里|中)?\s*(?:用\s*)?循环推进(?:模式)?/.exec(text);
  const prefix = scoped ?? /^(?:用\s*)?循环推进(?:模式)?/.exec(text);
  if (!prefix) return;
  const tail = text.slice(prefix[0].length).replace(/^\s*一下(?=[\s，,：:]|$)/, "").trim();
  const named = !scoped && /^((?:[A-Za-z]:[\\/])?[^：:，,\r\n]{1,240})[：:]([\s\S]*)$/.exec(tail);
  const project = scoped?.[1] || (named ? named[1] : undefined);
  const goal = (named ? named[2] : tail).replace(/^[\s：:，,]+/, "").trim();
  const unquoted = text.replace(/[「“『《][^」”』》]*[」”』》]|"[^"]*"/g, "");
  if (
    /[？?]|等我(?:确认|通知)|等.{1,12}再(?:开始|开工|执行|启动|推进)|(?:先别|先不|不要|不用|不必|暂不|暂缓)\s*(?:做|开工|启动|执行|运行|推进|创建)|先(?:只)?讨论|只是(?:举例|示例|问问)/.test(unquoted) ||
    /^(?:怎么|如何|是否|能不能|能否|是不是|要不要|的?(?:用法|入口|区别|设置)|到哪)|(?:怎么用|如何使用|是什么意思|是什么|有哪些|能用吗|可以吗|吗|么)[。！!\s]*$/.test(goal)
  )
    return;
  return { goal, ...(project ? { project: unquote(project) } : {}) };
}

export function createIntent(
  raw: string,
): { name: string; parent?: string } | undefined {
  const text = raw
    .trim()
    .replace(/[。！!]$/, "")
    .replace(/^(?:请(?:帮我)?|帮我|麻烦(?:帮我)?)\s*/, "");
  const match =
    /^(?:在\s*(.+?)\s*)?(?:新建|创建|新开)\s*(?:一个|个)?\s*(?:本地|本机)?\s*(?:项目(?:\s+|[：:,，]\s*(?:名字叫|名为|叫作|叫)?\s*|(?=[「“『《"]))(.+)|(?:名为|名叫|叫作|叫)?\s*(.+?)\s*(?:的)?项目)$/.exec(
      text,
    );
  if (!match) return;
  if (match[1] && !/^[A-Za-z]:[\\/]/.test(unquote(match[1]))) return;
  const value = (match[2] || match[3]).trim();
  // Prose, questions and multiple instructions are not names. Quoting supports spaces.
  if (
    !/^(?:[「“『《"][^「」“”『』《》"\r\n]+[」”』》"]|[\p{L}\p{N}_.-]+)$/u.test(
      value,
    ) ||
    /[？?]|(?:吗|么|如何|怎么样)$/.test(value) ||
    (!/^[「“『《"]/.test(value) &&
      /(?:然后|并且|之后|不要|是否|再说|前先|之前|会不会|需要|应该|方案|可行性|的风险)/.test(
        value,
      ))
  )
    return;
  return {
    name: unquote(value),
    parent: match[1] ? unquote(match[1]) : undefined,
  };
}
export const listIntent = (s: string) =>
  /^(?:(?:请|帮我|看看|查查|显示|列出|查看|刷新|这台电脑|本机|本地|当前|我|我们|现在|所有|已发现|已有|的|一下|上|有|都|已经|存着|[，,\s])*(?:哪些项目|什么项目|项目(?:清单|列表)|全部项目|项目有哪些|项目有哪几个)|(?:列出|显示|查看)(?:本地|本机|所有|全部|已有|的|\s)*项目)[。？?!！\s]*$/.test(
    s.trim(),
  );

export function fileSearchIntent(text: string) {
  const match = /^(?:请帮我|帮我|请)?\s*(?:在\s*([^\r\n]+?)\s+)?(?:查找|搜索)\s*(文件夹|文件)(?:\s*[:：]\s*|\s+)([^\r\n]+?)\s*[。！!]?$/.exec(
    text.trim(),
  );
  if (!match) return;
  const name = unquote(match[3]);
  if (!name || name.length > 255 || /[\\/:*?"<>|\x00-\x1f]/.test(name)) return;
  const location = match[1] ? unquote(match[1]) : undefined;
  const drive = location?.match(/^([a-z])\s*盘$/i);
  return {
    name,
    kind: match[2] === "文件" ? ("f" as const) : ("d" as const),
    path: drive ? drive[1] + ":\\" : location,
  };
}

export function folderReadIntent(raw: string) {
  const text = raw.trim().replace(/[。？?!！]+$/, "");
  if (
    /^(?:星引[，,]?\s*|你)?\s*(?:现在)?\s*(?:已经)?\s*(?:可不可以|可以|能不能|能|能否)\s*(?:读取?|访问|查看)\s*(?:本机|本地|电脑上的)?\s*(?:文件夹|目录)(?:了)?(?:吧|吗|么)?$/.test(text)
  )
    return { kind: "probe" as const };
  const command = text.replace(/^(?:请帮我|帮我|请)\s*/, "");
  const request =
    /^(?:看看|看一下|查看|列出|读取?(?:一下)?)\s*(.+?)\s*(?:文件夹|目录)?\s*里(?:面)?(?:有(?:什么|哪些)(?:文件)?|的(?:文件|内容))$/.exec(command) ||
    /^(?:列出|读取?(?:一下)?)\s*(.+)$/.exec(command);
  if (!request) return;
  const path = unquote(request[1]);
  if (/^[A-Za-z]:[\\/][^\r\n]*$/.test(path))
    return { kind: "list" as const, path };
}

export function locateIntent(s: string): string | undefined {
  const m =
    /^(?:请|请帮我|帮我|麻烦)?\s*(?:找一下|查找|找找|寻找|定位|打开|找)\s*(?:一下)?\s*(?:本地|本机)?\s*(?:项目[：:\s]*)?(.+?)\s*[。！!]?$/u.exec(
      s.trim(),
    );
  if (!m || /进度|进展|开发到了|讨论|文件内容|网页|浏览器|具体文件/.test(m[1]))
    return;
  if (!/项目|工程|目录|文件夹/i.test(s) && !/^[A-Za-z]:[\\/]/.test(m[1]))
    return;
  return unquote(
    m[1].replace(/\s*(?:这个|的)?(?:项目|工程|文件夹|目录)$/u, ""),
  );
}
export const progressIntent = (s: string) =>
  /进度|进展|开发到|做到哪|哪一步|项目.{0,12}(?:状态|情况)|项目\s*$/i.test(s);
export const localProjectLookupIntent = (s: string) =>
  /^(?:请帮我|帮我|请|你)?\s*(?:自己)?\s*(?:再\s*)?(?:在|再)\s*(?:本机|本地)?\s*(?:projects?|项目(?:目录|文件夹)?)\s*(?:里面?|中|下)\s*(?:再\s*)?(?:找|查找|搜索|搜)/i.test(s.trim());
export function discussionProject(s: string) {
  const m =
    /^(?:请)?(?:为|给|针对)\s*(?:[「“『《"]([^「」“”『』《》"]{1,100})[」”』》"](?:项目|工程)?|([^「」“”『』《》"\s]{1,100}?))\s*(?:新开|新建|继续|开个|另开)/.exec(
      s,
    );
  return m?.[1] || m?.[2];
}
export function suggestedName(s: string) {
  const forProject = discussionProject(s);
  if (forProject) return forProject;
  const quoted = /[「“『《"]([^「」“”『』《》"\r\n]{1,100})[」”』》"]/.exec(
    s,
  )?.[1];
  if (quoted) return quoted;
  return (
    locateIntent(s) ||
    /(?:看看|查查|查看|核对|查询|为|给)\s*([\p{L}\p{N}_.-]+?)(?:项目|工程|的进度)/u.exec(
      s,
    )?.[1]
  );
}
