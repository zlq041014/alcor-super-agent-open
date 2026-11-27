import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { childEnv } from "./hub/security";

// Official stable x64 portable build. Do not run an arbitrary executable from PATH.
const executable = "D:\\apps\\portable\\everything\\Everything.exe";
const verifiedHash =
  "f191f756996a14a11e5445fa7103d302efd510cf2fbf920e6c0c8ed51d512e36";
export async function everythingAvailable() {
  try {
    if ((await stat(executable)).size > 8_000_000) return false;
    return (
      createHash("sha256")
        .update(await readFile(executable))
        .digest("hex") === verifiedHash
    );
  } catch {
    return false;
  }
}
export function projectFileList(projects: { path: string }[]) {
  const paths = projects
    .filter((p) => /^[a-z]:[\\/]/i.test(p.path) && !/["\r\n]/.test(p.path))
    .map((p) => '"' + p.path.replace(/[\\/]+$/, "") + '\\",,,,16');
  return {
    text:
      "\uFEFFFilename,Size,Date Modified,Date Created,Attributes\r\n" +
      paths.join("\r\n") +
      "\r\n",
    count: paths.length,
  };
}
export async function browseProjects(
  dataDir: string,
  projects: { path: string }[],
) {
  if (!(await everythingAvailable()))
    throw new Error(
      "未找到已验证的 Everything 1.4.1.1032 x64 便携版，仍可在项目页查找",
    );
  const dir = join(dataDir, "everything"),
    list = join(dir, "projects.efu"),
    ini = join(dir, "Everything.ini");
  const exportData = projectFileList(projects);
  if (!exportData.count) throw new Error("当前没有可供浏览的本机项目");
  await mkdir(dir, { recursive: true });
  const temp = join(dir, randomUUID() + ".tmp");
  await writeFile(temp, exportData.text, { flag: "wx" });
  await rename(temp, list);
  // This dedicated instance browses a snapshot of known folders, not the machine's volume index.
  await writeFile(
    ini,
    [
      "[Everything]",
      "app_data=0",
      "run_as_admin=0",
      "run_in_background=0",
      "auto_include_fixed_volumes=0",
      "auto_include_removable_volumes=0",
      "auto_include_fixed_refs_volumes=0",
      "auto_include_removable_refs_volumes=0",
      "http_server_enabled=0",
      "etp_server_enabled=0",
      "search_history_enabled=0",
      "run_history_enabled=0",
      "db_location=" + dir,
      "",
    ].join("\r\n"),
  );
  const instance =
    "Alcor-" +
    createHash("sha256")
      .update(dataDir.toLowerCase())
      .digest("hex")
      .slice(0, 12);
  await new Promise<void>((ok, fail) => {
    const child = spawn(
      executable,
      ["-instance", instance, "-config", ini, "-no-db", "-filelist", list],
      {
        cwd: dir,
        env: childEnv(),
        windowsHide: false, // The user explicitly chose to open this GUI.
        detached: true,
        stdio: "ignore",
        shell: false,
      },
    );
    child.once("error", fail);
    child.once("spawn", () => {
      child.unref();
      ok();
    });
  });
  return { count: exportData.count };
}
