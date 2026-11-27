import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
const version = "45.3.3",
  name = `electron-v${version}-win32-x64.zip`,
  base = `https://github.com/electron/electron/releases/download/v${version}/`;
const sums = await (await fetch(base + "SHASUMS256.txt")).text();
const expected = sums
  .split("\n")
  .find((l) => l.endsWith(" " + name) || l.endsWith(" *" + name))
  ?.split(" ")[0];
if (!expected) throw Error("Official checksum missing");
await mkdir("D:/cache/electron", { recursive: true });
const file = "D:/cache/electron/" + name;
let valid = false;
try {
  valid =
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex") === expected;
} catch {}
if (!valid) {
  const sources = [
    base + name,
    `https://npmmirror.com/mirrors/electron/${version}/${name}`,
  ];
  for (const url of sources) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(180000),
      });
      console.log(
        JSON.stringify({
          source: new URL(url).hostname,
          status: response.status,
        }),
      );
      if (!response.ok) continue;
      await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
      valid =
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex") === expected;
      if (valid) break;
    } catch (e) {
      console.log(
        JSON.stringify({
          source: new URL(url).hostname,
          error: e.cause?.code || e.name,
        }),
      );
    }
  }
}
if (!valid) throw Error("Runtime download/checksum failed");
await writeFile(file + ".sha256", expected);
console.log(JSON.stringify({ file, sha256: expected, verified: true }));
