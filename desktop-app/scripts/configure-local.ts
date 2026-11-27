import { readFile } from "node:fs/promises";
import { Hub } from "../src/hub/service";
import { endpointUrl } from "../src/core/policy";
import { Vault } from "../src/hub/security";
import { CHIEF_MODEL, MEMBER_MODEL } from "../src/shared/contracts";

// Explicit one-time import. The key never appears in arguments, stdout, logs or source.
async function main() {
  const file = process.argv[2];
  const dir = process.argv[3];
  const codexPath = process.argv[4] || "";
  if (!file || !dir)
    throw new Error(
      "Usage: configure-local <credential-file> <data-dir> [codex-path]",
    );
  const content = await readFile(file, "utf8");
  const endpoint =
    (content.match(/Gateway URL:\s*(https:\/\/\S+)/)?.[1] || "").replace(
      /\/+$/,
      "",
    ) + "/v1";
  endpointUrl(endpoint, "models");
  const keys = [
    ...new Set([...content.matchAll(/Virtual key:\s*(\S+)/g)].map((m) => m[1])),
  ];
  let selected: string | undefined;
  let models: string[] = [];
  for (const key of keys) {
    const res = await fetch(endpointUrl(endpoint, "models"), {
      headers: { Authorization: `Bearer ${key}` },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) continue;
    const body = (await res.json()) as any;
    const ids = body.data?.map((x: any) => x.id) || [];
    if (ids.includes(CHIEF_MODEL)) {
      selected = key;
      models = ids;
      break;
    }
  }
  if (!selected)
    throw new Error("No credential profile exposes the requested model");
  const hub = new Hub(dir);
  try {
    await hub.brain
      .vaultFor({ ...hub.settings(), apiSource: "custom" })
      .save(endpoint, selected);
    const nativeName = process.env.ALCOR_NATIVE_API_KEY ? "ALCOR_NATIVE_API_KEY" : "";
    if (nativeName)
      await new Vault(dir, "codex-native.dpapi").save(
        `codex:${nativeName}`,
        process.env[nativeName]!,
      );
    await hub.request({
      op: "settings",
      value: {
        ...hub.settings(),
        endpoint,
        protocol: "chat",
        apiSource: "custom",
        model: CHIEF_MODEL,
        reasoningEffort: "max",
        codexModel: MEMBER_MODEL,
        memberEffort: "max",
        codexPath,
        codexCredentialEnv: nativeName,
      },
    });
    hub.store.put("models", {
      id: "global",
      ids: models,
      checkedAt: new Date().toISOString(),
    });
    const result = await hub.request({ op: "model.test" });
    console.log(
      JSON.stringify({
        configured: true,
        protocol: "chat",
        requestedModel: CHIEF_MODEL,
        actualModel: result.model,
        usage: result.usage,
        credentialStorage: "Windows DPAPI",
        dataDir: dir,
      }),
    );
  } finally {
    hub.store.close();
  }
}
main().catch(() => {
  console.error(
    "配置或连接验证失败，未输出服务响应或凭据；请检查端点与数据目录。",
  );
  process.exitCode = 1;
});
