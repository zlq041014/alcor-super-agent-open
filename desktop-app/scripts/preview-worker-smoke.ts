import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { childEnv, hash } from "../src/hub/security";
import { previewTerminal, type PreviewJobDefinition } from "../src/shared/preview-job";
import { launchPreviewMonitor, previewFrameCount, readPreviewReceipt } from "../src/hub/preview-job-process";
import { buildGraphWorkspace, sealPreviewFrames, verifyGraphWorkspace } from "../src/hub/graph-workspace";

const exec = promisify(execFile);
async function main() {
  const ffmpeg = await realpath(process.argv[2] ?? "D:/dev/ffmpeg/package/ffmpeg.exe");
  const entry = resolve(process.argv[3] ?? "dist/hub-preview-job.cjs");
  const base = resolve("../.dev/advance-loop/P3");
  await mkdir(base, { recursive: true });
  const folder = await mkdtemp(join(base, "preview-"));
  const id = randomUUID(), dir = join(folder, id);
  await mkdir(dir);
  const source = join(dir, "source.mp4");
  await exec(ffmpeg, [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    "testsrc=size=128x96:rate=16:duration=4", "-pix_fmt", "yuv420p", "-c:v", "mpeg4", source,
  ], { windowsHide: true, env: childEnv(), timeout: 12_000 });
  const definition: PreviewJobDefinition = {
    id, receiptKey: randomUUID(), sourceHash: hash(await readFile(source)),
    ffmpeg, frames: 6, hardAt: Date.now() + 15_000,
  };
  const config = join(dir, "definition.json");
  await writeFile(config, JSON.stringify(definition), { flag: "wx" });
  const launcher = join(folder, "launcher.cjs");
  await writeFile(launcher, [
    "const {launchPreviewMonitor}=require(process.argv[2]);",
    "launchPreviewMonitor(process.argv[3],process.argv[4]).then(pid=>console.log(pid));",
  ].join("\n"));
  const launched = await exec(process.execPath, [
    "--import", "tsx", launcher, resolve("src/hub/preview-job-process.ts"), config, entry,
  ], { windowsHide: true, env: childEnv(), timeout: 8000 });
  const pid = Number(launched.stdout.trim());
  assert.ok(pid > 0);
  let result;
  do {
    result = await readPreviewReceipt(dir, definition);
    if (result && (previewTerminal(result.phase) || result.phase === "unknown")) break;
    await delay(100);
  } while (Date.now() < definition.hardAt + 3000);
  assert.equal(result?.phase, "completed", "监护器未确认完成：" + result?.phase + " / " + result?.reason);
  assert.equal(await previewFrameCount(dir, definition.frames), 6);
  const duplicate = await launchPreviewMonitor(config, entry);
  const outside = Date.now() + 5000;
  while (Date.now() < outside) {
    try { process.kill(duplicate, 0); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") break; throw e; }
    await delay(45);
  }
  assert.deepEqual(await readPreviewReceipt(dir, definition), result);
  const blobs = join(folder, "blobs");
  await mkdir(blobs);
  const frozen = await sealPreviewFrames(dir, definition.frames, async (_path, data, digest) => {
    const target = join(blobs, digest);
    await writeFile(target, data);
    return target;
  });
  await buildGraphWorkspace(join(folder, "combined"), blobs, frozen);
  await verifyGraphWorkspace(join(folder, "combined"), frozen);
  const proof = { passed: true, folder, realFfmpeg: true, frames: 6,
    launcherExitedBeforeObservation: true, duplicatePreservedReceipt: true, frozenVerifiedFrames: true };
  await writeFile(join(folder, "result.json"), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
}
void main().catch((e: Error) => { console.error(e.message); process.exitCode = 1; });
