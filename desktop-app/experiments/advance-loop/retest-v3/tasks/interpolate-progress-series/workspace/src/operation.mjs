export function execute(v) {
  return v.samples.at(-1)?.value ?? null;
}
