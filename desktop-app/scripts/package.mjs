import {
  cp,
  copyFile,
  mkdir,
  writeFile,
  rename,
  readFile,
  mkdtemp,
  rm,
  lstat,
  rmdir,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { createPackage } from "@electron/asar";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const version = JSON.parse(await readFile("package.json", "utf8")).version;
if (
  typeof version !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)
)
  throw new Error("应用版本无效");
const root = resolve(process.argv[2] ?? "release");
const name = `alcor-${version}-windows-x64`;
const out = join(root, name),
  archive = out + ".zip",
  checksum = archive + ".sha256";
await mkdir(root, { recursive: true });
const lock = out + ".packing";
try {
  await mkdir(lock);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  throw new Error("该版本正在此目录制包，请稍后重试或选用独立输出目录");
}
let scratch;
try {
  for (const path of [out, archive, checksum]) {
    const exists = await lstat(path).then(
      () => true,
      (error) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      },
    );
    if (exists)
      throw new Error("拒绝覆盖已有版本产物，请选择独立输出目录：" + path);
  }
  scratch = await mkdtemp(join(root, ".build-"));
  const stage = join(scratch, "app-stage"),
    privateOut = join(scratch, name);
  const privateArchive = join(scratch, name + ".zip");
  const files = [
    "main.cjs",
    "preload.cjs",
    "hub-entry.cjs",
    "hub-preview-job.cjs",
    "index.html",
    "ui.js",
    "ui.css",
    "credential.html",
    "credential.js",
    "alcor.png",
  ];
  await mkdir(join(stage, "dist"), { recursive: true });
  for (const f of files) {
    if (!(await lstat(join("dist", f))).isFile())
      throw new Error("构建产物不是普通文件：" + f);
    await cp(join("dist", f), join(stage, "dist", f));
  }
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify({
      name: "alcor-desktop",
      version,
      main: "dist/main.cjs",
      description: "星引 Alcor 智能体总管",
    }),
  );
  await cp("node_modules/electron/dist", privateOut, { recursive: true });
  await cp("tools/fd", join(privateOut, "resources", "fd"), { recursive: true });
  await createPackage(stage, join(privateOut, "resources", "app.asar"));
  await rename(join(privateOut, "electron.exe"), join(privateOut, "Alcor.exe"));
  const editor = resolve("node_modules/rcedit/bin/rcedit-x64.exe");
  await exec(
    editor,
    [
      join(privateOut, "Alcor.exe"),
      "--set-icon",
      resolve("assets/alcor.ico"),
      "--set-version-string",
      "ProductName",
      "星引 Alcor",
      "--set-version-string",
      "FileDescription",
      "Alcor Desktop",
      "--set-version-string",
      "CompanyName",
      "Alcor",
      "--set-file-version",
      version,
      "--set-product-version",
      version,
    ],
    { windowsHide: true },
  );
  const manual = (await readFile("README.md", "utf8")).replace(
    "[路线与验证状态](../docs/roadmap.md)",
    "随源码附带的 docs/roadmap.md（路线与验证状态）",
  );
  await writeFile(join(privateOut, "使用说明.md"), manual);
  await writeFile(
    join(privateOut, "启动星引.cmd"),
    '@echo off\r\nstart "" "%~dp0Alcor.exe"\r\n',
  );
  await writeFile(
    join(privateOut, "启动独立试用.cmd"),
    [
      "@echo off",
      "setlocal",
      'set "ALCOR_DATA_DIR=%~dp0trial-data\\state"',
      'set "ALCOR_BOOTSTRAP_DIR=%~dp0trial-data\\bootstrap"',
      'set "CODEX_HOME=%~dp0trial-data\\codex"',
      'if not exist "%CODEX_HOME%" (mkdir "%CODEX_HOME%" || exit /b 1)',
      'start "" "%~dp0Alcor.exe"',
      "",
    ].join("\r\n"),
  );
  for (const name of ["试用步骤.md", "样例甲/说明.md", "样例乙/说明.md"]) {
    const source = join("examples", "desktop-trial", name);
    if (!(await lstat(source)).isFile()) throw new Error("试用材料不是普通文件：" + name);
    const target = join(privateOut, "试用样例", name);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
  }
  // Electron cannot create its renderer sandbox when binaries inherit Low integrity.
  await exec(
    join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe"),
    [privateOut, "/setintegritylevel", "(OI)(CI)M", "/T", "/L", "/Q"],
    { windowsHide: true },
  );
  await exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Compress-Archive -LiteralPath '${privateOut.replaceAll("'", "''")}' -DestinationPath '${privateArchive.replaceAll("'", "''")}'`,
    ],
    { windowsHide: true, timeout: 180000 },
  );
  const digest = createHash("sha256")
    .update(await readFile(privateArchive))
    .digest("hex");
  await rename(privateOut, out);
  await copyFile(privateArchive, archive, constants.COPYFILE_EXCL);
  await writeFile(checksum, digest + "  " + name + ".zip\n", { flag: "wx" });
  console.log(JSON.stringify({ directory: out, archive, sha256: digest }));
} finally {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  await rmdir(lock);
}
