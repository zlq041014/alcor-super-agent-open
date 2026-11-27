import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await import("./icon.mjs");
await mkdir("dist", { recursive: true });
await Promise.all([
  ...["main", "preload", "hub/entry", "hub/preview-job"].map((name) =>
    build({
      entryPoints: [`src/${name}.ts`],
      bundle: true,
      platform: "node",
      target: "node24",
      format: "cjs",
      outfile: `dist/${name.replace("/", "-")}.cjs`,
      external: ["electron"],
      sourcemap: true,
    }),
  ),
  build({
    entryPoints: ["src/ui/app.tsx"],
    bundle: true,
    platform: "browser",
    target: "chrome140",
    outfile: "dist/ui.js",
    minify: true,
    sourcemap: true,
    define: { "process.env.NODE_ENV": '"production"' },
  }),
  build({
    entryPoints: ["src/ui/credential.ts"],
    bundle: true,
    platform: "browser",
    outfile: "dist/credential.js",
  }),
  copyFile("src/ui/index.html", "dist/index.html"),
  copyFile("src/ui/credential.html", "dist/credential.html"),
  copyFile("assets/alcor.png", "dist/alcor.png"),
]);
console.log("Alcor build complete");
