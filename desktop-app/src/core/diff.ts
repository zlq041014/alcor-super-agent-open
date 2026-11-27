import type { WorkFile } from "../shared/contracts";
import { redact } from "../shared/redact";

const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

export function fileDiff(
  path: string,
  previous: string | null,
  next: string,
): WorkFile | undefined {
  if (previous === next) return;
  const old = lines(previous ?? ""),
    fresh = lines(next);
  let start = 0,
    tail = 0;
  while (
    start < old.length &&
    start < fresh.length &&
    old[start] === fresh[start]
  )
    start++;
  while (
    tail < old.length - start &&
    tail < fresh.length - start &&
    old[old.length - 1 - tail] === fresh[fresh.length - 1 - tail]
  )
    tail++;
  const a = old.slice(start, old.length - tail);
  const b = fresh.slice(start, fresh.length - tail);
  const rows: [string, string][] = [];
  let removed = 0,
    added = 0;
  const change = (sign: "+" | "-", value: string) => {
    if (sign === "+") added++;
    else removed++;
    rows.push([sign, value]);
  };
  if (a.length && b.length && a.length * b.length <= 250000) {
    const width = b.length + 1;
    const cells = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        cells[i * width + j] =
          a[i] === b[j]
            ? 1 + cells[(i + 1) * width + j + 1]
            : Math.max(cells[(i + 1) * width + j], cells[i * width + j + 1]);
    for (let i = 0, j = 0; i < a.length || j < b.length; ) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        rows.push([" ", a[i++]]);
        j++;
      } else if (
        j === b.length ||
        (i < a.length && cells[(i + 1) * width + j] >= cells[i * width + j + 1])
      )
        change("-", a[i++]);
      else change("+", b[j++]);
    }
  } else {
    for (const line of a) change("-", line);
    for (const line of b) change("+", line);
  }
  const leading = old.slice(Math.max(0, start - 3), start);
  const trailing = tail
    ? old.slice(old.length - tail, old.length - tail + Math.min(3, tail))
    : [];
  const context = leading.length + trailing.length;
  const startLine = start - leading.length;
  const format = (sign: string, value: string) =>
    sign +
    value +
    (value.endsWith("\n") ? "" : "\n\\ No newline at end of file\n");
  const patch = [
    "diff --git a/" + path + " b/" + path + "\n",
    ...(previous === null ? ["new file mode 100644\n"] : []),
    "--- " + (previous === null ? "/dev/null" : "a/" + path) + "\n",
    "+++ b/" + path + "\n",
    ...(rows.length
      ? [
          "@@ -" +
            (a.length + context ? startLine + 1 : startLine) +
            "," +
            (a.length + context) +
            " +" +
            (b.length + context ? startLine + 1 : startLine) +
            "," +
            (b.length + context) +
            " @@\n",
        ]
      : []),
    ...leading.map((value) => format(" ", value)),
    ...rows.map(([sign, value]) => format(sign, value)),
    ...trailing.map((value) => format(" ", value)),
  ].join("");
  return {
    path,
    action: previous === null ? "新增" : "修改",
    added,
    removed,
    ...(patch.length <= 22000
      ? { patch: redact(patch) }
      : { note: "完整补丁超过展示容量；以下增删行数来自写入前后的版本。" }),
  };
}
