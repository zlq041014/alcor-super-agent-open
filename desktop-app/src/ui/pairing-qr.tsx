import React, { useMemo } from "react";
import qr from "qrcode-generator";

const quiet = 4;

/** Draw the exact short-lived invitation locally, including the QR quiet zone. */
export function PairingQr({ code }: { code: string }) {
  const { size, path } = useMemo(() => {
    const matrix = qr(0, "M");
    matrix.addData(code);
    matrix.make();
    const count = matrix.getModuleCount();
    const runs: string[] = [];
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count;) {
        if (!matrix.isDark(row, col)) { col++; continue; }
        const start = col++;
        while (col < count && matrix.isDark(row, col)) col++;
        const width = col - start;
        runs.push(`M${start + quiet} ${row + quiet}h${width}v1h-${width}z`);
      }
    }
    return { size: count + 2 * quiet, path: runs.join("") };
  }, [code]);
  return <svg role="img" aria-label="配对二维码" width="232" height="232" style={{ maxWidth: "100%", height: "auto" }}
    viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges">
    <rect width={size} height={size} fill="#fff"/><path d={path} fill="#000"/>
  </svg>;
}
