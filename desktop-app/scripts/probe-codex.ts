import { Codex } from "../src/adapter/codex";
const adapter = new Codex();
async function main() {
  try {
    await adapter.connect(process.argv[2]);
    const account = await adapter.call("account/read", { refreshToken: false });
    const models = await adapter.call("model/list", {});
    console.log(
      JSON.stringify({
        version: adapter.version,
        authenticated: !!account.account,
        accountType: account.account?.type,
        models: models.data?.map((m: any) => m.id),
      }),
    );
  } catch (e) {
    console.log(JSON.stringify({ error: (e as Error).message }));
    process.exitCode = 1;
  } finally {
    await adapter.stop();
  }
}
void main();
