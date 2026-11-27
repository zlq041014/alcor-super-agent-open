import {terminal} from "./settings.mjs";
export function stopSummary(requested, receipt) {
  if (receipt === "interrupted") return {state:"stopped",hold:false};
  if (terminal.includes(receipt)) return {state:"finished",hold:false};
  if (receipt === "lost") return {state:"unknown",hold:true};
  return {state:requested ? "requested" : "active",hold:true};
}
