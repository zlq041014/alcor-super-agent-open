import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathKey } from "../core/glob";
import type { Project, Run, Task } from "../shared/contracts";
import type { GraphPlan } from "../shared/native-graph";
import { previewTerminal, type PreviewReceipt, type PreviewStop } from "../shared/preview-job";
import { GraphLedger } from "./graph-ledger";
import { checkGraphFiles, sealPreviewFrames } from "./graph-workspace";
import type { PreviewJob } from "./preview-job-ledger";
import { launchPreviewMonitor, readPreviewReceipt, requestPreviewStop } from "./preview-job-process";
import { hash, within } from "./security";
import type { Hub } from "./service";

const ffmpeg = "D:/dev/ffmpeg/package/ffmpeg.exe";
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export class GraphPreview {
  private pending = new Map<string, Promise<boolean>>();
  launch = launchPreviewMonitor;
  constructor(private hub: Hub, private changed: (taskId: string) => void) {}
  private get ledger() { return new GraphLedger(this.hub.store, this.hub.dir); }
  private get jobs() { return this.ledger.previewJobs; }

  async prepare(project: Project, value: { video: string; frames: number }): Promise<NonNullable<GraphPlan["preview"]>> {
    checkGraphFiles([value.video]);
    const named = join(project.path, value.video);
    const [file, executable] = await Promise.all([
      within(project.path, named),
      realpath(ffmpeg).catch((error) => {
        if (!missing(error)) throw error;
        throw new Error("预览作业需要本机 FFmpeg：" + ffmpeg);
      }),
    ]);
    const st = await lstat(named);
    if (pathKey(file) !== pathKey(named) || st.isSymbolicLink() || !st.isFile() || st.nlink !== 1 ||
        st.size > 20 * 1024 * 1024)
      throw new Error("请选择项目内不超过 20 MB 的普通 MP4 视频，不能使用链接");
    const data = await readFile(file);
    if (data.length > 20 * 1024 * 1024 || data.subarray(4, 8).toString() !== "ftyp")
      throw new Error("视频不是支持的 MP4 文件");
    const blob = basename(await this.hub.storeBlob(file, data, hash(data)));
    return { ...value, ffmpeg: executable, blob };
  }

  private owner(job: PreviewJob) {
    const task = this.hub.getTask(job.taskId);
    const node = this.ledger.node(job.nodeId);
    const run = this.hub.store.get<Run>("run", job.runId)!;
    const project = this.hub.store.get<Project>("project", task.projectId);
    const current = !!project && !project.removed && !task.archived &&
      task.revision === job.taskRevision && node.revision === job.nodeRevision && node.previewJobId === job.id;
    return { task, run, current, paused: ["paused", "cancelled"].includes(task.state) };
  }

  private async checkDirectory(job: PreviewJob) {
    const expected = join(this.hub.dir, "graph-previews", job.id);
    if (pathKey(job.workPath) !== pathKey(expected) ||
        pathKey(await realpath(job.workPath)) !== pathKey(expected))
      throw new Error("预览作业目录不在账本工作区内");
  }

  private async dispatch(job: PreviewJob) {
    const preview = this.ledger.get(job.loopId).preview!;
    const config = join(job.workPath, "definition.json");
    try {
      const blobRoot = join(this.hub.dir, "blobs");
      const source = await within(blobRoot, join(blobRoot, preview.blob));
      const data = await readFile(source);
      if (hash(data) !== job.definition.sourceHash) throw new Error("冻结的视频版本已变化");
      const parent = dirname(job.workPath);
      await mkdir(parent, { recursive: true });
      if (pathKey(await realpath(parent)) !== pathKey(parent)) throw new Error("预览工作区已重定向");
      await mkdir(job.workPath);
      await this.checkDirectory(job);
      await writeFile(join(job.workPath, "source.mp4"), data, { flag: "wx" });
      await writeFile(config, JSON.stringify(job.definition), { flag: "wx", flush: true });
      const owner = this.owner(job);
      if (this.hub.shuttingDown || !owner.current || owner.paused ||
          this.jobs.get(job.id)!.stop || Date.now() >= job.definition.hardAt) {
        this.jobs.request(job.id, Date.now() >= job.definition.hardAt ? "hard" : "user");
        this.jobs.notDispatched(job.id);
        return;
      }
      // A successful spawn is only an intent in flight. All release decisions wait for receipts.
      await this.launch(config);
    } catch {
      // The launcher rejects only when Windows did not create a monitor process.
      this.jobs.notDispatched(job.id);
    }
  }

  private async step(id: string, reconcileOnly: boolean) {
    const job = this.jobs.get(id)!;
    if (job.applied) return false;
    const owner = this.owner(job);
    if (previewTerminal(job.state)) {
      if (owner.run.state !== "ended") return false;
      let files, failure: string | undefined;
      if (job.state === "completed" && owner.current && !job.stop && !owner.paused) {
        try {
          await this.checkDirectory(job);
          files = await sealPreviewFrames(job.workPath, job.definition.frames, this.hub.storeBlob.bind(this.hub));
        } catch {
          failure = "预览帧缺失、损坏或已变化，未通过核对";
        }
      }
      return this.ledger.finishPreview(id, files, failure);
    }
    const reason = reconcileOnly ? undefined : job.stop ?? (!owner.current || owner.paused || this.hub.shuttingDown ? "user" :
      Date.now() >= job.definition.hardAt ? "hard" : undefined);
    if (reason && !job.stop) this.jobs.request(id, reason);
    if (job.state === "queued") {
      if (reconcileOnly) return false;
      if (reason) return true;
      const claim = this.jobs.claim(id);
      if (!claim) return this.jobs.get(id)!.state !== "queued";
      await this.dispatch(claim);
      return true;
    }
    let receipt: PreviewReceipt | undefined;
    try {
      await this.checkDirectory(job);
      receipt = await readPreviewReceipt(job.workPath, job.definition);
      if (reason && !(receipt && previewTerminal(receipt.phase)))
        await requestPreviewStop(job.workPath, job.definition, reason);
    } catch (error) {
      if (!missing(error)) {
        this.jobs.unknown(id);
        return job.state !== "unknown";
      }
    }
    if (receipt && this.jobs.observe(id, receipt)) {
      this.ledger.progress.frames(job.runId, receipt.frames, receipt.at);
      if (previewTerminal(receipt.phase)) return true;
    }
    const current = this.jobs.get(id)!;
    if (Date.now() - (current.receipt?.at ?? Date.parse(current.updatedAt)) > 8000)
      this.jobs.unknown(id);
    return this.jobs.get(id)!.state !== job.state ||
      this.jobs.get(id)!.receipt?.frames !== job.receipt?.frames;
  }

  private advance(job: PreviewJob, reconcileOnly = false) {
    const existing = this.pending.get(job.id);
    if (existing) return existing;
    const work = this.step(job.id, reconcileOnly).finally(() => this.pending.delete(job.id));
    this.pending.set(job.id, work);
    return work;
  }
  tick() {
    for (const job of this.jobs.pending()) {
      if (this.pending.has(job.id) ||
          (job.state === "queued" && !job.handoff && !job.stop && Date.now() < job.definition.hardAt)) continue;
      void this.advance(job).then((changed) => {
        if (changed) this.changed(job.taskId);
      }).catch(() => this.hub.fault("预览作业账本写入失败"));
    }
  }
  async stop(task: Task, runs?: ReadonlySet<string>, reason: PreviewStop["reason"] = "user") {
    for (const job of this.jobs.open(task.id)) {
      if (runs && !runs.has(job.runId)) continue;
      this.jobs.request(job.id, reason);
      await this.advance(job);
      const live = this.jobs.get(job.id)!;
      if (live.state !== "queued" && !previewTerminal(live.state)) {
        // A monitor can appear while the first stop request is being persisted.
        await this.advance(live);
      }
    }
  }
  async control(task: Task, id: string, action: "stop" | "reconcile") {
    const job = this.jobs.get(id);
    if (!job || job.taskId !== task.id || job.applied) throw new Error("没有属于此工作的待处理预览作业");
    if (action === "stop") await this.stop(task, new Set([job.runId]));
    await this.advance(this.jobs.get(id)!, action === "reconcile");
    this.changed(task.id);
    if (action === "reconcile" && this.jobs.get(id)!.state === "unknown")
      throw new Error("尚未核对到有效的预览作业终态，设备和目录仍保留占用");
    return true;
  }
  async drain() { await Promise.all([...this.pending.values()]); }
}
