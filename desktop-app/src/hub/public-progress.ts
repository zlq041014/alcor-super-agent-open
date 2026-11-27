export type PublicProgress = (
  key: string,
  kind: "summary" | "finding",
  text: string,
  done: boolean,
) => void;
// Only published reasoning summaries and public commentary; never raw reasoning, tool arguments or structured final JSON.
export async function readResponseStream(
  response: Response,
  report: PublicProgress,
) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("模型未返回可读取的响应");
  const decoder = new TextDecoder(),
    phases = new Map<string, string>(),
    blocks = new Map<string, string>(),
    output = new Map<string, any>();
  let buffer = "",
    size = 0,
    completed: any;
  const handle = (packet: string) => {
    const body = packet
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!body || body === "[DONE]") return;
    let e: any;
    try {
      e = JSON.parse(body);
    } catch {
      throw new Error("模型流响应格式无效");
    }
    const id = String(e.item_id ?? e.item?.id ?? e.output_index ?? "0");
    if (
      e.type === "response.output_item.added" ||
      e.type === "response.output_item.done"
    ) {
      if (e.item?.type === "message")
        phases.set(id, String(e.item.phase || ""));
      if (
        e.type === "response.output_item.done" &&
        ["message", "reasoning"].includes(e.item?.type)
      ) {
        // Retain only output fields used by the public response parser.
        if (e.item.type === "reasoning")
          output.set(id, {
            id,
            type: "reasoning",
            summary: (e.item.summary || [])
              .filter((x: any) => x.type === "summary_text")
              .map((x: any) => ({ type: "summary_text", text: x.text })),
          });
        else
          output.set(id, {
            id,
            type: "message",
            phase: e.item.phase,
            content: (e.item.content || [])
              .filter((x: any) => x.type === "output_text")
              .map((x: any) => ({ type: "output_text", text: x.text })),
          });
      }
    }
    const kind =
      e.type === "response.reasoning_summary_text.delta" ||
      e.type === "response.reasoning_summary_text.done"
        ? "summary"
        : phases.get(id) === "commentary" &&
            (e.type === "response.output_text.delta" ||
              e.type === "response.output_text.done")
          ? "finding"
          : undefined;
    if (kind) {
      const key =
          kind + ":" + id + ":" + (e.summary_index ?? e.content_index ?? 0),
        done = e.type.endsWith(".done");
      const value = String(
        done
          ? (e.text ?? blocks.get(key) ?? "")
          : (blocks.get(key) || "") +
              (typeof e.delta === "string" ? e.delta : ""),
      ).slice(0, 16000);
      blocks.set(key, value);
      if (value) report(key, kind, value, done);
    }
    if (e.type === "response.completed") completed = e.response;
    if (
      e.type === "error" ||
      e.type === "response.failed" ||
      e.type === "response.incomplete"
    )
      throw new Error("模型未完成本次响应，未自动重试");
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      size += value.byteLength;
      if (size > 8_000_000) throw new Error("模型流响应超过大小限制");
      buffer += decoder.decode(value, { stream: true });
      let m: RegExpExecArray | null;
      while ((m = /\r?\n\r?\n/.exec(buffer))) {
        handle(buffer.slice(0, m.index));
        buffer = buffer.slice(m.index + m[0].length);
      }
    }
    if (buffer.trim()) handle(buffer);
    if (!completed) throw new Error("模型响应中断，缺少结束回执，未自动重试");
    return {
      ...completed,
      output: completed.output?.length
        ? completed.output
        : [...output.values()],
    };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
