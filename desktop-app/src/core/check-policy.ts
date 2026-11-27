import {
  CommandCheckInput,
  type CheckInput as Input,
} from "../shared/loop-contracts";

export type CommandCheck = Extract<Input, { kind: "command" }>;
export type Decision = { allowed: boolean; rule: string };
const commandArg = /^[A-Za-z0-9_@+=:,./\\-]+$/;
const programName = /^[a-z0-9][a-z0-9_.+-]*$/i;
const allowedName =
  /^(test|typecheck|type-check|lint|check|build|verify)(:|$)/i;
const deniedName =
  /deploy|publish|release|start|dev|serve|watch|package|install|clean|fix|format|write/i;
const deniedCode =
  /publish|deploy|\bgit\s+push\b|\brm\s+-rf\b|\brmdir\s+\/s\b|\bdel\s+\/s\b|\bshutdown\b|\bnpx\b|\b(?:npm|pnpm|yarn|pip|pip3|uv|cargo|dotnet)(?:\.cmd|\.exe)?\s+(?:install|ci|add|exec|dlx|restore|fetch)\b|\bpython(?:\.exe)?\s+-m\s+pip\s+install\b/i;
const fixedCommands = new Set([
  "node --test",
  "python -m pytest",
  "cargo check",
  "cargo test",
  "go vet ./...",
  "go test ./...",
  "dotnet build",
  "dotnet test",
]);
const yes = (rule: string): Decision => ({ allowed: true, rule });
const no = (rule: string): Decision => ({ allowed: false, rule });

export function safeArgv(command: CommandCheck) {
  return (
    programName.test(command.program) &&
    command.args.every((arg) => commandArg.test(arg))
  );
}

export function userCommand(name: string, raw: string): CommandCheck {
  const [program, ...args] = raw.trim().split(/\s+/);
  const command = CommandCheckInput.parse({
    kind: "command",
    name,
    program,
    args,
  });
  if (!safeArgv(command))
    throw new Error("命令只能使用程序名和不含空格或特殊字符的参数");
  return command;
}

export function authorizeCommand(
  command: CommandCheck,
  origin: "existing" | "model" | "user",
  script?: { name: string; bodies: string[] },
): Decision {
  if (!safeArgv(command)) return no("参数或程序名含不允许的字符");
  const line = [command.program, ...command.args].join(" ");
  if (deniedCode.test(line)) return no("命令命中发布或破坏性操作规则");
  if (script) {
    if (deniedName.test(script.name)) return no("脚本名称命中拒绝规则");
    if (script.bodies.some((body) => deniedCode.test(body)))
      return no("脚本或生命周期钩子命中拒绝规则");
    if (origin === "user") return yes("用户填写");
    return allowedName.test(script.name)
      ? yes("已发现的检查脚本")
      : no("脚本名称不在检查名单");
  }
  if (origin === "user") return yes("用户填写");
  return fixedCommands.has(line)
    ? yes("内置检查命令")
    : no("命令与已发现入口或内置形态不一致");
}
