import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { defaultProtected, glob, pathKey } from "../core/glob";

export async function protectedPaths(root: string, extra: string[]) {
  const matches = [...defaultProtected, ...extra].map(glob);
  const paths = new Set<string>();
  let count = 0;
  async function visit(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++count > 50000)
        throw new Error(
          "项目条目过多，无法完整建立受保护文件清单，请选择更小的项目目录",
        );
      if (
        entry.isSymbolicLink() ||
        /^(?:\.|node_modules$|dist$|build$|vendor$)/i.test(entry.name)
      )
        continue;
      const path = join(dir, entry.name);
      const rel = pathKey(relative(root, path));
      if (
        matches.some(
          (match) => match(rel) || (entry.isDirectory() && match(rel + "/")),
        )
      )
        paths.add(rel);
      if (entry.isDirectory()) await visit(path);
    }
  }
  await visit(root);
  return [...paths].sort();
}
