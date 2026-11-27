import { StringDecoder } from "node:string_decoder";
import type { DshUsage } from "../shared/contracts";

function number(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function total(text: string) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return;
  }
  const usage = parsed?.response?.usage ?? parsed?.usage;
  if (number(usage?.total_tokens)) return usage.total_tokens;
  const input = usage?.input_tokens ?? usage?.prompt_tokens;
  const output = usage?.output_tokens ?? usage?.completion_tokens;
  if (number(input) && number(output) && number(input + output))
    return input + output;
}

export function dshUsageReader(summary: DshUsage, contentType: string) {
  const sse = contentType.includes("text/event-stream");
  const decoder = new StringDecoder("utf8");
  let pending = "",
    previous: number | undefined;
  let oversized = false;
  let frame = "";
  let discardFrame = false;
  const update = (data: string) => {
    const count = total(data);
    if (count === undefined) return;
    if (previous === undefined) summary.knownRequests++;
    summary.tokensKnown += count - (previous ?? 0);
    previous = count;
  };
  const append = (value: string) => {
    if (!sse) {
      if (oversized) return;
      pending += value;
      if (pending.length > 2 * 1024 * 1024) {
        pending = "";
        oversized = true;
      }
      return;
    }
    const parts = value.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (!oversized) {
        pending += parts[i];
        if (pending.length > 1024 * 1024) {
          pending = "";
          oversized = true;
        }
      }
      if (i === parts.length - 1) break;
      if (oversized) discardFrame = true;
      else if (!pending.replace(/\r$/, "")) {
        if (!discardFrame && frame) update(frame);
        frame = "";
        discardFrame = false;
      } else if (!discardFrame && pending.startsWith("data:")) {
        frame += pending.slice(5).trimStart().replace(/\r$/, "") + "\n";
        if (frame.length > 1024 * 1024) {
          frame = "";
          discardFrame = true;
        }
      }
      pending = "";
      oversized = false;
    }
  };
  return {
    write(chunk: Buffer) {
      append(decoder.write(chunk));
    },
    end() {
      append(decoder.end());
      if (!oversized) {
        if (!sse) update(pending);
        else if (!discardFrame) {
          if (pending.startsWith("data:"))
            frame += pending.slice(5).trimStart();
          if (frame) update(frame);
        }
      }
    },
  };
}
