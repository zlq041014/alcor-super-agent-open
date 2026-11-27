import {
  lstat,
  realpath,
  readdir,
  readFile,
  writeFile,
  rename,
  unlink,
  mkdir,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sensitive } from "../hub/native-work";
import { glob, pathKey } from "../core/glob";

export interface PathPolicy {
  protect: string[];
  allowOnly?: string[];
  lockPackageScripts: boolean;
}
export interface JournalSink {
  rejected(path: string, reason: string): void;
  before?(path: string, contents: Buffer | null): Promise<void>;
  after?(path: string, contents: Buffer): Promise<void>;
  directory?(path: string): void;
  directoryCreated?(path: string): void;
  ensureActive?(): void;
}
export type WorkspaceOptions = {
  write: boolean;
  paths?: PathPolicy;
  journal?: JournalSink;
  graph?: (request: string | number, action: "suggest_branches" | "submit_delivery" | "record_research_use" | "start_preview", value: unknown) => string;
  research?: (value: unknown) => string;
  reportResearchUse?: boolean;
  allowPreview?: boolean;
};

const limit = 256 * 1024;
const ignored =
  /^(?:\.|node_modules$|dist$|build$|vendor$|credentials?(?:[.-]|$)|secrets?(?:[.-]|$)|auth\.json$|key\.txt$|id_(?:rsa|ed25519)|.*\.(?:pem|key|pfx|p12|dpapi)$)/i;
const component = (s: string) =>
  !!s &&
  !ignored.test(s) &&
  !/[<>:"|?*\x00-\x1f]/.test(s) &&
  !/[. ]$/.test(s) &&
  !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s);
export const workspaceFile = (path: string) =>
  path.split(/[\\/]/).every(component) && !sensitive(path);
const textProp = { type: "string" };
function tool(
  name: string,
  description: string,
  props: string[],
  optional: string[] = [],
) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(props.map((k) => [k, textProp])),
      required: props.filter((k) => !optional.includes(k)),
      additionalProperties: false,
    },
  };
}
const readTools = [
  tool(
    "list_files",
    "List up to 300 visible files and directories under a project-relative directory (default: project root).",
    ["path"],
    ["path"],
  ),
  tool(
    "read_file",
    "Read a UTF-8 text file in the selected workspace. Paths are project-relative.",
    ["path"],
  ),
];
const writeTools = [
  tool(
    "create_directory",
    "Create a new project directory under an existing directory.",
    ["path"],
  ),
  tool(
    "write_file",
    "Create a new UTF-8 text file in an existing project directory. Does not overwrite existing files.",
    ["path", "text"],
  ),
  tool(
    "edit_file",
    "Replace one unique exact text fragment in an existing UTF-8 project file.",
    ["path", "old_text", "new_text"],
  ),
];

// Native DSH file policy restricts writes but allows host-wide reads. Offer
// only these workspace-scoped tools to the session through ACP's supported MCP transport.
export function workspaceMcp(
  root: string,
  { write, paths, journal, graph, research, reportResearchUse, allowPreview }: WorkspaceOptions,
) {
  const graphTools = graph ? [
    tool("suggest_branches",
      "Propose independent deliverables. Supply a JSON object with nodes; each node has key, title, goal, acceptance, outputs, dependencies, resources and required.",
      ["value"]),
    tool("submit_delivery", "Submit a JSON object with paths to finished UTF-8 files in this workspace.", ["value"]),
  ] : [];
  const tools = write ? [...readTools, ...writeTools, ...graphTools,
    ...(graph && reportResearchUse ? [tool("record_research_use",
      "Record a supplied research note's key, disposition (adopted or declined), and reason as a JSON object.", ["value"])] : []),
    ...(graph && allowPreview ? [tool("start_preview",
      "Hand off the already authorized MP4 preview. Pass an empty JSON object as value, then end the turn.", ["value"])] : []),
  ] : research ? [tool("submit_research",
    "Submit a JSON finding with route, recommendation, conditions, fact, unresolved and citations ({id, quote}).",
    ["value"])] : readTools;
  const protectedNames = new Set(paths?.protect.map(pathKey));
  const only = paths?.allowOnly?.map(glob);
  const reject = (path: string, reason: string): never => {
    journal?.rejected(path, reason);
    throw new Error(
      "该文件属于验收检查，不能修改。如认为检查有误，请在最终答复中说明。",
    );
  };
  const guardScripts = (path: string, after: string, before?: string) => {
    if (
      !paths?.lockPackageScripts ||
      basename(path).toLowerCase() !== "package.json"
    )
      return;
    const scripts = (json: string) => {
      const value = JSON.parse(json.replace(/^\uFEFF/, ""));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new SyntaxError();
      return value.scripts;
    };
    let unchanged: boolean;
    try {
      unchanged = isDeepStrictEqual(
        before === undefined ? undefined : scripts(before),
        scripts(after),
      );
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      return reject(path, "package.json 不是有效 JSON");
    }
    if (!unchanged) reject(path, "package.json 的 scripts 不能修改");
  };
  async function target(raw: unknown, directory: boolean, create: boolean) {
    if (typeof raw !== "string" || raw.length > 1000 || isAbsolute(raw))
      throw Error("需要项目内相对路径");
    const parts = raw.split(/[\\/]/);
    if (directory && (!raw || raw === ".")) parts.length = 0;
    if (!parts.every(component) || sensitive(raw))
      throw Error("路径超出范围或属于受保护文件");
    const base = await realpath(root);
    if (resolve(base).toLowerCase() !== resolve(root).toLowerCase())
      throw Error("项目根已重定向");
    let path = base;
    for (const [i, part] of parts.entries()) {
      path = join(path, part);
      let st;
      try {
        st = await lstat(path);
      } catch (e: any) {
        if (e.code === "ENOENT" && create && i === parts.length - 1)
          return path;
        throw Error("文件或目录不存在");
      }
      const rel = relative(base, await realpath(path));
      if (st.isSymbolicLink() || rel.startsWith("..") || isAbsolute(rel))
        throw Error("不能访问目录链接");
      if (
        i === parts.length - 1 &&
        !directory &&
        (!st.isFile() || st.nlink > 1 || st.size > limit)
      )
        throw Error("只支持 256 KB 内的普通文件");
    }
    return path;
  }
  const read = async (p: string) => {
    const buf = await readFile(p);
    if (buf.length > limit || buf.includes(0))
      throw Error("文件过大或不是文本");
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        buf,
      );
    } catch {
      throw Error("文件不是 UTF-8 文本");
    }
  };
  const string = (x: unknown) => {
    if (typeof x !== "string" || Buffer.byteLength(x) > limit)
      throw Error("文本超过限制");
    return x;
  };
  const handle = async (req: any) => {
    const envelope = { jsonrpc: "2.0", id: req.id };
    if (req.method === "initialize")
      return {
        ...envelope,
        result: {
          protocolVersion: [
            "2024-11-05",
            "2025-03-26",
            "2025-06-18",
            "2025-11-25",
          ].includes(req.params?.protocolVersion)
            ? req.params.protocolVersion
            : "2025-06-18",
          serverInfo: { name: "alcor-workspace", version: "1" },
          capabilities: { tools: {} },
        },
      };
    if (req.method === "ping") return { ...envelope, result: {} };
    if (req.method === "tools/list") return { ...envelope, result: { tools } };
    if (req.method !== "tools/call")
      return {
        ...envelope,
        error: { code: -32601, message: "Unsupported method" },
      };
    const name = req.params?.name,
      args = req.params?.arguments || {};
    const result = (text: string, isError = false) => ({
      ...envelope,
      result: { content: [{ type: "text", text }], isError },
    });
    try {
      if (!tools.some((t) => t.name === name))
        return result("当前任务不允许这个操作", true);
      if (research && name === "submit_research") return result(research(JSON.parse(string(args.value))));
      if (graph && (name === "suggest_branches" || name === "submit_delivery" ||
          name === "record_research_use" || name === "start_preview")) {
        if (typeof req.id !== "string" && typeof req.id !== "number")
          throw new Error("成果操作缺少请求编号");
        return result(graph(req.id, name, JSON.parse(string(args.value))));
      }
      const path = await target(
        args.path ?? "",
        name === "list_files",
        name === "write_file" || name === "create_directory",
      );
      const rel =
        paths && ["edit_file", "write_file", "create_directory"].includes(name)
          ? pathKey(
              relative(
                root,
                name === "edit_file"
                  ? await realpath(path)
                  : join(await realpath(dirname(path)), basename(path)),
              ),
            )
          : "";
      const journalPath = journal?.before
        ? relative(root, path).replaceAll("\\", "/")
        : rel;
      if (
        paths &&
        rel &&
        (protectedNames.has(rel) ||
          (only && !only.some((matches) => matches(rel))))
      )
        reject(rel, "受保护路径或不在允许写入的路径中");
      if (name === "create_directory") {
        journal?.directory?.(journalPath);
        journal?.ensureActive?.();
        await mkdir(path);
        journal?.directoryCreated?.(journalPath);
        return result("目录已创建");
      }
      if (name === "list_files") {
        const entries = (await readdir(path, { withFileTypes: true })).filter(
          (e) => component(e.name) && !sensitive(e.name) && !e.isSymbolicLink(),
        );
        return result(
          entries
            .slice(0, 300)
            .map((e) => e.name + (e.isDirectory() ? "/" : ""))
            .join("\n") + (entries.length > 300 ? "\n（清单已截断）" : ""),
        );
      }
      if (name === "read_file") return result(await read(path));
      if (name === "write_file") {
        const after = string(args.text);
        guardScripts(rel, after);
        await journal?.before?.(journalPath, null);
        journal?.ensureActive?.();
        await writeFile(path, after, { flag: "wx" });
        await journal?.after?.(journalPath, Buffer.from(after));
      } else {
        const before = await read(path),
          old = string(args.old_text),
          replacement = string(args.new_text);
        if (
          !old ||
          !before.includes(old) ||
          before.indexOf(old) !== before.lastIndexOf(old)
        )
          return result("原文不存在或不唯一，请重新读取", true);
        const after = string(before.replace(old, () => replacement));
        guardScripts(rel, after, before);
        await journal?.before?.(journalPath, Buffer.from(before));
        const temp = join(dirname(path), ".alcor-edit-" + randomUUID());
        try {
          await writeFile(temp, after, { flag: "wx" });
          if ((await read(await target(args.path, false, false))) !== before)
            return result("原文件已变化，未覆盖", true);
          journal?.ensureActive?.();
          await rename(temp, path);
          await journal?.after?.(journalPath, Buffer.from(after));
        } finally {
          await unlink(temp).catch(() => {});
        }
      }
      return result("文件已保存");
    } catch (e: any) {
      // Filesystem errors can contain absolute paths; expose only our own bounded messages.
      return result(
        e?.code
          ? "文件操作失败，请检查文件是否存在、是否可写"
          : String(e.message).slice(0, 160),
        true,
      );
    }
  };
  let writes: Promise<unknown> = Promise.resolve();
  return (req: any) => {
    if (
      !journal ||
      req.method !== "tools/call" ||
      !writeTools.some((tool) => tool.name === req.params?.name)
    )
      return handle(req);
    const current = writes.then(() => handle(req));
    writes = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };
}
