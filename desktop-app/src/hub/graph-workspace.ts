import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { workspaceFile } from "../adapter/dsh-files";
import { assertDisjointOutputs } from "../core/native-graph";
import { pathKey } from "../core/glob";
import { GraphPath, type GraphFile } from "../shared/native-graph";
import { hash } from "./security";
import { isCompletePreviewFrame, previewFrameName } from "./preview-job-process";

export function checkGraphFiles(paths: string[]) {
  for (const path of paths)
    if (!GraphPath.safeParse(path).success || !workspaceFile(path) ||
        pathKey(path).split("/").includes("target"))
      throw new Error("只允许项目内普通文本文件：" + path);
  assertDisjointOutputs(paths);
}

async function workspaceBytes(root: string, file: string, media?: "png") {
  let at = root;
  for (const component of file.split("/")) {
    at = join(at, component);
    if ((await lstat(at)).isSymbolicLink())
      throw new Error("成果输入和输出不得经过目录链接");
  }
  if (pathKey(await realpath(at)) !== pathKey(resolve(at)))
    throw new Error("成果目录的实际位置已变化");
  const st = await lstat(at);
  if (!st.isFile() || st.nlink !== 1 || st.size > (media ? 2 * 1024 * 1024 : 256 * 1024))
    throw new Error("成果文件格式或大小超出范围");
  const bytes = await readFile(at);
  if (media) {
    if (!isCompletePreviewFrame(bytes)) throw new Error("预览帧尚未写完或不是 PNG 文件");
  } else {
    if (bytes.length > 256 * 1024 || bytes.includes(0))
      throw new Error("成果仅支持 256 KiB 内的 UTF-8 文本");
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  return bytes;
}

export async function sealGraphFiles(
  root: string, paths: string[],
  save: (file: string, data: Buffer, digest: string) => Promise<string>,
): Promise<GraphFile[]> {
  checkGraphFiles(paths);
  const files: GraphFile[] = [];
  for (const path of paths) {
    const bytes = await workspaceBytes(root, path);
    files.push({ path, blob: basename(await save(path, bytes, hash(bytes))) });
  }
  return files;
}

export async function sealPreviewFrames(
  root: string, count: number,
  save: (file: string, data: Buffer, digest: string) => Promise<string>,
): Promise<GraphFile[]> {
  const files: GraphFile[] = [];
  for (let index = 1; index <= count; index++) {
    const name = previewFrameName(index);
    const path = "preview-frames/" + name;
    const data = await workspaceBytes(root, name, "png");
    files.push({ path, blob: basename(await save(path, data, hash(data))), media: "png" });
  }
  const note = Buffer.from("已核对 FFmpeg 生成的 " + count + " 张连续 PNG 预览帧。\n" +
    files.map((file) => file.path).join("\n") + "\n");
  const manifest = "preview-frames/index.txt";
  files.push({ path: manifest, blob: basename(await save(manifest, note, hash(note))) });
  return files;
}

export async function buildGraphWorkspace(
  root: string, blobs: string, files: GraphFile[], outputs: string[] = [],
) {
  checkGraphFiles([...files.map((file) => file.path), ...outputs]);
  await mkdir(dirname(root), { recursive: true });
  if (pathKey(await realpath(dirname(root))) !== pathKey(resolve(dirname(root))))
    throw new Error("成果工作区已重定向，未创建交付目录");
  await mkdir(root);
  for (const file of files) {
    const data = await readFile(join(blobs, file.blob));
    if (hash(data) !== file.blob.slice(0, 64))
      throw new Error("成果副本的内容已变化：" + file.path);
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { flag: "wx" });
  }
  for (const path of outputs) await mkdir(dirname(join(root, path)), { recursive: true });
}

export async function verifyGraphWorkspace(root: string, files: GraphFile[]) {
  checkGraphFiles(files.map((file) => file.path));
  if (pathKey(await realpath(root)) !== pathKey(resolve(root)))
    throw new Error("组合目录已重定向");
  const expected = new Set(files.map((file) => pathKey(file.path)));
  async function visit(dir: string, prefix: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink() &&
          [...expected].some((file) => file.startsWith(pathKey(path) + "/")))
        await visit(join(dir, entry.name), path + "/");
      else if (!entry.isFile() || !expected.has(pathKey(path)))
        throw new Error("组合目录含有未验收的文件或目录");
    }
  }
  await visit(root, "");
  await verifyGraphFiles(root, files);
}

export async function verifyGraphFiles(root: string, files: GraphFile[]) {
  for (const file of files)
    if (hash(await workspaceBytes(root, file.path, file.media)) !== file.blob.slice(0, 64))
      throw new Error("工作区文件与冻结版本不一致：" + file.path);
}
