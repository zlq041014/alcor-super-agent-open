import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  authorizeCommand,
  type CommandCheck,
  type Decision,
} from "../core/check-policy";
import type { CheckInput } from "../shared/loop-contracts";
import { sensitive } from "./native-work";
import { hash, within } from "./security";

export type DiscoveredCheck = {
  input: CheckInput;
  policy: Decision;
  bindingHash: string;
  origin: "existing" | "user";
};
const skip =
  /^(?:\.|node_modules$|vendor$|dist$|build$|release$|target$|coverage$)/i;
const missing = (e: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code || "");
async function children(path: string) {
  return readdir(path, { withFileTypes: true }).catch((e) => {
    if (missing(e)) return [];
    throw e;
  });
}
async function fileText(root: string, path: string) {
  const st = await lstat(path).catch((e) => {
    if (missing(e)) return undefined;
    throw e;
  });
  if (!st?.isFile() || st.size > 1024 * 1024) return undefined;
  return readFile(await within(root, path), "utf8");
}
async function scripts(
  root: string,
  dir: string,
): Promise<Record<string, string> | undefined> {
  const source = await fileText(root, join(dir, "package.json"));
  if (source === undefined) return undefined;
  try {
    const value = JSON.parse(source.replace(/^\uFEFF/, ""))?.scripts;
    return Object.fromEntries(
      Object.entries(value || {}).filter(
        (x): x is [string, string] => typeof x[1] === "string",
      ),
    );
  } catch (e) {
    if (e instanceof SyntaxError) return undefined; // The invalid manifest cannot authorize a command.
    throw e;
  }
}

export async function bindCheck(
  root: string,
  input: CheckInput,
  origin: DiscoveredCheck["origin"] | "model",
): Promise<DiscoveredCheck> {
  let policy: Decision;
  let binding: unknown;
  if (input.kind === "file") {
    policy =
      sensitive(input.path) ||
      input.path
        .split(/[\\/]/)
        .some((part) => part !== "." && part.startsWith("."))
        ? { allowed: false, rule: "不能读取隐藏或凭据文件" }
        : {
            allowed: origin !== "model",
            rule: origin === "model" ? "模型不能扩大检查范围" : "用户填写",
          };
  } else {
    const dir = resolve(root, input.cwd);
    const full = await within(root, dir).catch((e) => {
      if (missing(e)) return undefined;
      throw e;
    });
    const manager = /^(?:npm|pnpm|yarn)(?:\.cmd|\.exe)?$/i.test(input.program);
    const scriptName =
      manager && input.args[0] === "run" ? input.args[1] : undefined;
    if (scriptName) {
      const entries = full ? await scripts(root, full) : undefined;
      const canonical =
        full && origin === "model"
          ? managerFor(
              new Set(
                (await children(full))
                  .filter((x) => x.isFile())
                  .map((x) => x.name),
              ),
            )
          : undefined;
      if (
        origin === "model" &&
        (input.args.length !== 2 || input.program !== canonical)
      ) {
        policy = {
          allowed: false,
          rule: "模型命令必须与发现的检查入口完全一致",
        };
      } else if (!entries || !Object.hasOwn(entries, scriptName)) {
        policy = { allowed: false, rule: "找不到声明的项目脚本" };
      } else {
        const bodies = [scriptName, "pre" + scriptName, "post" + scriptName]
          .filter((name) => Object.hasOwn(entries, name))
          .map((name) => entries[name]);
        policy = authorizeCommand(input, origin, { name: scriptName, bodies });
        binding = bodies;
      }
    } else if (manager) {
      policy = { allowed: false, rule: "包管理器只运行已声明的检查脚本" };
    } else {
      policy = authorizeCommand(input, origin);
    }
    if (full && policy.allowed) {
      const config = (await children(full)).filter(
        (entry) =>
          entry.isFile() &&
          /^(?:(?:vitest|jest|playwright|eslint)\.config\..+|(?:pytest|tox|setup)\.(?:ini|cfg)|conftest\.py|pyproject\.toml|Cargo\.toml|go\.mod|tsconfig[^/]*\.json|.+\.(?:sln|csproj))$/i.test(
            entry.name,
          ),
      );
      const texts = await Promise.all(
        config
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(async ({ name }) => [
            name,
            await fileText(root, join(full, name)),
          ]),
      );
      binding = [binding, texts];
    }
  }
  return {
    input,
    origin: origin === "user" ? "user" : "existing",
    policy,
    bindingHash: hash(JSON.stringify([input, binding])),
  };
}

export async function discoverChecks(root: string) {
  async function at(cwd: string) {
    const dir = join(root, cwd),
      entries = await children(dir);
    const names = new Set(entries.filter((x) => x.isFile()).map((x) => x.name));
    const checks: CommandCheck[] = [];
    const push = (name: string, program: string, args: string[]) => {
      const label = cwd === "." ? name : cwd + ":" + name;
      if (label.length <= 80 && checks.length < 100)
        checks.push({ kind: "command", name: label, program, args, cwd });
    };
    if (names.has("package.json")) {
      const packageScripts = await scripts(root, dir);
      if (packageScripts) {
        const manager = managerFor(names);
        for (const name of Object.keys(packageScripts))
          push(name, manager, ["run", name]);
      }
    }
    if (
      names.has("pyproject.toml") ||
      names.has("pytest.ini") ||
      (entries.some(
        (d) => d.name === "tests" && d.isDirectory() && !d.isSymbolicLink(),
      ) &&
        (await children(join(dir, "tests"))).some(
          (x) => x.isFile() && /^test_.*\.py$/.test(x.name),
        ))
    )
      push("pytest", "python", ["-m", "pytest"]);
    if (names.has("Cargo.toml")) {
      push("cargo-check", "cargo", ["check"]);
      push("cargo-test", "cargo", ["test"]);
    }
    if (names.has("go.mod")) {
      push("go-vet", "go", ["vet", "./..."]);
      push("go-test", "go", ["test", "./..."]);
    }
    if ([...names].some((name) => /\.(?:sln|csproj)$/i.test(name))) {
      push("dotnet-build", "dotnet", ["build"]);
      push("dotnet-test", "dotnet", ["test"]);
    }
    return {
      checks,
      manifest: checks.length > 0 || names.has("package.json"),
      entries,
    };
  }
  const top = await at(".");
  const candidates = top.manifest
    ? top.checks
    : (
        await Promise.all(
          top.entries
            .filter(
              (d) =>
                d.isDirectory() && !d.isSymbolicLink() && !skip.test(d.name),
            )
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, 8)
            .map((d) => at(d.name)),
        )
      ).flatMap((d) => d.checks);
  return Promise.all(
    candidates.slice(0, 100).map((check) => bindCheck(root, check, "existing")),
  );
}

function managerFor(names: Set<string>) {
  return names.has("pnpm-lock.yaml")
    ? "pnpm"
    : names.has("yarn.lock")
      ? "yarn"
      : "npm";
}
