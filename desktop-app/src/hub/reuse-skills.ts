import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import type { ExecutorBackend, SkillCatalog, SkillChoice } from "../shared/contracts";
import { pathKey, samePath } from "./local-projects";
import { hash, redact } from "./security";
import type { Hub } from "./service";

const Catalog = z.object({ data: z.array(z.object({
  cwd: z.string(),
  skills: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    path: z.string(),
    scope: z.enum(["repo", "user", "system", "admin"]),
    enabled: z.boolean(),
    dependencies: z.object({ tools: z.array(z.unknown()) }).nullish(),
  })),
  errors: z.array(z.unknown()),
})) });

export async function skillCatalog(hub: Hub, projectId: string, backend: ExecutorBackend): Promise<SkillCatalog> {
  const project = hub.project(projectId);
  if (backend !== "codex") return { state: "unsupported", skills: [] };
  const host = hub.settings().codexPath;
  await hub.ensureCodex();
  let result: unknown;
  try {
    result = await hub.codex.call("skills/list", { cwds: [project.path], forceReload: true });
  } catch {
    throw new Error("Codex 未能读取此项目的 Skill 目录");
  }
  if (hub.settings().codexPath !== host || !samePath(project.path, hub.project(projectId).path))
    throw new Error("Skill 宿主或项目目录已变化，请重新读取");
  const parsed = Catalog.safeParse(result);
  if (!parsed.success) throw new Error("Codex 返回了无法核对的 Skill 目录");
  const rows = parsed.data.data.filter(row => samePath(row.cwd, project.path));
  if (rows.length !== 1) throw new Error("Codex 未返回此项目唯一的 Skill 目录");
  const [row] = rows;
  const skills = new Map<string, SkillChoice>();
  for (const { enabled, name, path, scope, dependencies } of row.skills) {
    if (!enabled || !isAbsolute(path) || basename(path).toLowerCase() !== "skill.md") continue;
    const id = hash(JSON.stringify([pathKey(path), scope, name]));
    skills.set(id, { id, host: backend, name: redact(name), scope, toolRequirements: dependencies?.tools.length ?? 0 });
  }
  return { state: row.errors.length ? "partial" : "available", skills: [...skills.values()] };
}
