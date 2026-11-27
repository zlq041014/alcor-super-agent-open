import { readPreviewDefinition, runPreviewMonitor } from "./preview-job-process";

void readPreviewDefinition(process.argv[2]).then(
  ({ dir, definition }) => runPreviewMonitor(dir, definition),
).catch(() => {
  // The ledger keeps the writer occupied when no valid terminal receipt exists.
  process.exitCode = 1;
});
