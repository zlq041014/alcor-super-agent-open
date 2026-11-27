import { OwnerClient } from "../src/adapter/owner";
async function main() {
  const client = new OwnerClient();
  try {
    await client.connect();
    const owner = await client.owner(process.argv[2]);
    console.log(JSON.stringify({ connected: true, ownerAvailable: !!owner }));
  } catch (e) {
    console.log(JSON.stringify({ error: (e as Error).message }));
  } finally {
    client.close();
  }
}
void main();
