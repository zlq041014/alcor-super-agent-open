import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hub } from "../src/hub/service";
import { hash, redact } from "../src/hub/security";
import { defaults } from "../src/shared/contracts";
import type { FindingReference } from "../src/shared/loop-contracts";
import { checkWorkspace, copyTree, taskSet, tree } from "./loop-score";
import { pathKey } from "../src/core/glob";

// The fixture definitions and labels are never copied to the workspace or model materials.
const cases = {
  "clip-reserved-windows": [
    [
      "[Math.max(a,min),Math.min(b,max)]",
      "[a,b]",
      /裁[剪切]|统计范围|clip|Math\.(?:max|min)/i,
    ],
    [
      "a <= previous[1]",
      "a < previous[1]",
      /首尾|相接|相邻|adjacen|previous\[1\]/i,
    ],
    ["a[0]-b[0]", "b[0]-a[0]", /降序|排序|升序|sort|b\[0\]-a\[0\]/i],
  ],
  "label-usage-quantiles": [
    ["result[key]=n", 'if (key !== "p95") result[key]=n', /p95/i],
    ["value>=0", "value>0", /排除零|忽略零|零值|大于[\s]*0|value\s*>\s*0/i],
    [
      "Math.ceil(n*fraction)",
      "Math.floor(n*fraction)",
      /floor|ceil|最近秩|向下取整/i,
    ],
  ],
  "bucket-reminder-digest": [
    [
      "options.onlyUnread === true && row.unread !== true",
      "options.onlyUnread === true && row.unread === true",
      /onlyUnread|只读已读|已读过滤|未读过滤/i,
    ],
    [
      "row.channel ?? defaultChannel",
      'row.channel ?? ""',
      /缺失[^。]*频道|general|defaultChannel/i,
    ],
    [
      "a.channel < b.channel ? -1 : a.channel > b.channel ? 1",
      "a.channel < b.channel ? 1 : a.channel > b.channel ? -1",
      /同值|同时间|频道名|名称排序|a\.channel </i,
    ],
  ],
  "fit-print-window": [
    [
      'typeof raw === "string" && /^\\d+$/.test(raw) ? Number(raw) : raw',
      "raw",
      /数字字符串|字符串页码|Number\(raw\)|纯数字/i,
    ],
    [
      "if (!pages) return {...emptyWindow};",
      "if (!pages) return {first:1,last:1,count:1};",
      /空文档|零页|页数[^。]*为零|!pages/i,
    ],
    ["Math.abs(a-b)+1", "Math.abs(a-b)", /页数|少一|首尾|count|Math\.abs/i],
  ],
  "query-project-calendar": [
    [
      "weekdays.includes(new Date(day).getUTCDay())",
      "true",
      /星期|weekdays|工作日|指定日期/i,
    ],
    ["at>after", "at>=after", /严格晚于|等于|相同时间|at\s*>=/i],
    [":[0-5]\\d$", ":\\d{2}$", /分钟|非法时间|无效时间|时间格式|0-5/i],
  ],
} as const;

const source = "src/operation.mjs";
const lf = (text: string) => text.replace(/\r\n?/g, "\n");
type PlantedFault = {
  index: number;
  offset: number;
  end: number;
  pattern: RegExp;
};

function plant(
  sourceText: string,
  faults: readonly (readonly [string, string, RegExp])[],
) {
  const original = lf(sourceText);
  const targets = faults
    .map(([before, after, pattern], index) => {
      const offset = original.indexOf(before);
      assert.ok(
        offset >= 0 && original.indexOf(before, offset + before.length) === -1,
      );
      return { index, offset, before, after, pattern };
    })
    .sort((a, b) => a.offset - b.offset);
  let input = "",
    cursor = 0;
  const sites: PlantedFault[] = [];
  for (const target of targets) {
    assert.ok(target.offset >= cursor, "缺陷变异位置不能重叠");
    input += original.slice(cursor, target.offset);
    sites.push({
      index: target.index,
      offset: input.length,
      end: input.length + target.after.length,
      pattern: target.pattern,
    });
    input += target.after;
    cursor = target.offset + target.before.length;
  }
  return { input: input + original.slice(cursor), sites };
}

function overlapsPlant(input: string, quote: string, site: PlantedFault) {
  quote = lf(quote).trim();
  if (!quote) return false;
  for (
    let at = input.indexOf(quote);
    at >= 0;
    at = input.indexOf(quote, at + 1)
  )
    if (at < site.end && site.offset < at + quote.length) return true;
  return false;
}

async function main() {
  const verify = process.argv.includes("--verify");
  if (!verify && !process.argv.includes("--authorized"))
    throw new Error("真实改进验收需要开工授权");
  const key = process.env.ALCOR_DEEPSEEK_API_KEY;
  if (!verify && !key) throw new Error("未提供验证网关凭据");
  const base = resolve("../.dev/advance-loop/L2");
  await mkdir(base, { recursive: true });
  const out = await mkdtemp(join(base, verify ? "fixture-" : "real-"));
  const { tasks } = await taskSet(
    resolve("experiments/advance-loop/l1-followup"),
  );
  const sampleNames = Object.keys(cases) as (keyof typeof cases)[];
  async function item(id: keyof typeof cases) {
    const task = tasks.find((entry) => entry.id === id)!;
    const dir = join(out, id),
      work = join(dir, "workspace"),
      state = join(dir, "state");
    await copyTree(join(task.dir, "workspace"), work);
    await copyTree(join(task.dir, "reference"), work);
    if (verify) {
      const reference = await checkWorkspace(
        task,
        work,
        join(dir, "reference-scored"),
      );
      assert.equal(reference.visiblePassed && reference.hiddenPassed, true, id);
    }
    const target = join(work, source);
    const start = await readFile(target, "utf8");
    if (verify) {
      for (const [index, [before, after]] of cases[id].entries()) {
        assert.equal(start.split(before).length, 2, id);
        const one = join(dir, "single-" + index);
        await copyTree(work, one);
        await writeFile(join(one, source), start.replace(before, after));
        const score = await checkWorkspace(
          task,
          one,
          join(dir, "single-scored-" + index),
        );
        assert.equal(
          score.hiddenPassed,
          false,
          `${id} 缺陷 ${index + 1} 未单独触发隐藏检查`,
        );
      }
    }
    const planted = plant(start, cases[id]);
    await writeFile(target, planted.input);
    const files = await tree(work);
    const content = new Map(
      await Promise.all(
        files.map(
          async (name) =>
            [pathKey(name), await readFile(join(work, name), "utf8")] as const,
        ),
      ),
    );
    const unchanged = async () =>
      JSON.stringify(await tree(work)) === JSON.stringify(files) &&
      (
        await Promise.all(
          files
            .filter((name) => name !== source)
            .map(
              async (name) =>
                hash(await readFile(join(work, name))) ===
                hash(content.get(pathKey(name))!),
            ),
        )
      ).every(Boolean);
    if (verify) {
      const mutant = await checkWorkspace(
        task,
        work,
        join(dir, "mutant-scored"),
      );
      assert.equal(mutant.hiddenPassed, false, id);
      for (const site of planted.sites) {
        assert.ok(
          overlapsPlant(
            planted.input,
            planted.input.slice(site.offset, site.end),
            site,
          ),
        );
        const away = planted.input
          .slice(0, site.offset)
          .split("\n")
          .find((line) => line.trim().length > 12);
        if (away && !planted.input.slice(site.offset).includes(away.trim()))
          assert.equal(overlapsPlant(planted.input, away, site), false);
      }
      return {
        id,
        known: cases[id].length,
        fixtureChecked: true,
        individualFaultsChecked: cases[id].length,
      };
    }
    const hub = new Hub(state);
    try {
      const settings = {
        ...defaults,
        maxOutputTokens: 8000,
        checkPath: [dirname(process.execPath)],
        loopBudget: {
          ...defaults.loopBudget,
          improveRounds: 1,
          findingsPerRound: 3,
          executorRuns: 8,
          roleCalls: 75,
          wallMinutes: 25,
          checkTimeoutSec: 60,
        },
      };
      await hub.brain.vaultFor(settings).save(settings.endpoint, key!);
      await hub.request({ op: "settings", value: settings });
      const project = await hub.request({
        op: "project.add",
        name: "找问题隔离验收",
        path: work,
      });
      const result = await hub.request({
        op: "task.create",
        requestId: id,
        value: {
          projectId: project.id,
          mode: "write",
          advance: "loop-improve",
          goal: task.prompt,
          constraints:
            "只修改 src/operation.mjs。保留所有其他文件及测试，不新增文件。",
          criteria: [
            {
              title: "确认项目已有验收入口",
              method: "file",
              checks: ["已有验收入口"],
            },
          ],
          loopChecks: [
            {
              kind: "file",
              name: "已有验收入口",
              path: "package.json",
              contains: "node --test",
            },
          ],
          protect: files.filter((name) => name !== source),
        },
      });
      const until = Date.now() + 26 * 60_000;
      while (Date.now() < until) {
        await hub.tick();
        const phase = hub.loop.forTask(hub.getTask(result.id))?.phase;
        if (phase === "closed" || phase === "halted") break;
        await delay(250);
      }
      const view = hub.loop.view(hub.getTask(result.id));
      const queued = view.findings.filter(
        (f) => f.status === "queued" || f.status === "fixed",
      );
      const normalized = (text: string) => lf(text).trim();
      const verifyReference = async (reference: FindingReference) => {
        if (reference.kind === "criterion")
          return view.criteria.some((entry) => entry.id === reference.id);
        if (reference.kind === "file") {
          const original = content.get(pathKey(reference.path));
          return (
            !!original &&
            normalized(original).includes(normalized(reference.quote))
          );
        }
        if (reference.kind === "check-run")
          return (
            view.checkRuns.some((r) => r.id === reference.id) &&
            normalized(await hub.loop.output(reference.id)).includes(
              normalized(reference.excerpt),
            )
          );
        return false;
      };
      const evidenceValid =
        queued.every((row) => row.evidence.length > 0) &&
        (
          await Promise.all(
            queued.flatMap((row) => row.evidence.map(verifyReference)),
          )
        ).every(Boolean);
      const candidates = queued
        .map((row) => {
          const claim = row.title + "\n" + row.claim;
          return planted.sites.filter(
            (site) =>
              site.pattern.test(claim) &&
              row.evidence.some((ref) =>
                ref.kind === "file"
                  ? pathKey(ref.path) === pathKey(source) &&
                    overlapsPlant(planted.input, ref.quote, site)
                  : ref.kind === "check-run" &&
                    site.pattern.test(ref.excerpt) &&
                    view.checkRuns.some(
                      (run) => run.id === ref.id && run.outcome === "failed",
                    ),
              ),
          );
        })
        .sort((a, b) => a.length - b.length);
      const covered = new Set<number>();
      for (const matches of candidates) {
        const next = matches.find(({ index }) => !covered.has(index));
        if (next) covered.add(next.index);
      }
      const unclassified = candidates.filter(
        (matches) => !matches.length,
      ).length;
      const scopeClean =
        unclassified === 0 &&
        queued.every(
          (row) => row.scope !== "beyond-goal" && !!row.criterionId,
        ) &&
        (await unchanged());
      const data = {
        id,
        known: cases[id].length,
        covered: covered.size,
        queued: queued.length,
        fixed: queued.filter((row) => row.status === "fixed").length,
        evidenceValid,
        scopeClean,
        unclassified,
        phase: view.loop.phase,
        completed: view.loop.report?.outcome === "completed",
        reviewRounds: view.loop.reviewedRounds ?? 0,
        userRequests:
          hub.launches.pending().length + hub.store.all("approval").length,
        dsh: hub.dsh.status.version,
        model: settings.model,
      };
      await writeFile(join(dir, "result.json"), JSON.stringify(data, null, 2));
      return data;
    } finally {
      await hub.shutdown();
      hub.store.close();
      await rm(join(state, hub.brain.vaultFor(defaults).filename), {
        force: true,
      });
    }
  }
  const samples: Awaited<ReturnType<typeof item>>[] = [];
  for (let i = 0; i < sampleNames.length; i += 2) {
    const batch = await Promise.allSettled(
      sampleNames.slice(i, i + 2).map(item),
    );
    for (const result of batch) {
      if (result.status === "rejected") throw result.reason;
      samples.push(result.value);
    }
  }
  const covered = samples.reduce(
    (total, row) => total + ("covered" in row ? row.covered! : 0),
    0,
  );
  const known = samples.reduce((total, row) => total + row.known, 0);
  const passed =
    verify ||
    (covered >= Math.ceil(known / 2) &&
      samples.every(
        (row) =>
          "reviewRounds" in row &&
          row.reviewRounds === 1 &&
          row.evidenceValid &&
          row.scopeClean &&
          row.userRequests === 0,
      ));
  await writeFile(
    join(out, "summary.json"),
    JSON.stringify({ verify, passed, known, covered, samples }, null, 2),
  );
  console.log(JSON.stringify({ out, passed, known, covered }));
  if (!passed) process.exitCode = 1;
}
void main().catch((e) => {
  console.error(redact((e as Error).message).slice(0, 400));
  process.exitCode = 1;
});
