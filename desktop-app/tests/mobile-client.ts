import { createHash } from "node:crypto";
import { request } from "node:https";
import type { TLSSocket } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import type { MobileDesk } from "../src/hub/mobile";

export type Pair = { url: string; id: string; pin: string; token: string };

export async function mobileInvite(desk: MobileDesk, ...projects: string[]): Promise<Pair> {
  const invite = await desk.local({ action: "invite", address: "127.0.0.1", projects, name: "隔离测试手机" }) as { code: string };
  return JSON.parse(Buffer.from(invite.code.slice(7), "base64url").toString());
}

export function call(pair: Pair, route: string, body: object): Promise<any> {
  return exchange(pair, route, "POST", Buffer.from(JSON.stringify(body)));
}

export function upload(pair: Pair, info: object, body: Buffer, incomplete = false): Promise<any> {
  return exchange(pair, "material", "PUT", body, {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(body.length + Number(incomplete)),
    "X-Alcor-Material": Buffer.from(JSON.stringify(info)).toString("base64url"),
  }, incomplete);
}

function exchange(pair: Pair, route: string, method: string, body: Buffer,
    headers: Record<string, string> = {}, incomplete = false): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request(pair.url + "/mobile/v1/" + route, {
      method, agent: false, rejectUnauthorized: false,
      headers: { Authorization: "Bearer " + pair.token, Connection: "close", ...headers },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (part) => { data += part; });
      res.on("error", reject);
      res.on("end", () => {
        try { resolve({ code: res.statusCode, ...JSON.parse(data) }); }
        catch (error) { reject(error); }
      });
    });
    req.on("socket", (socket) => {
      socket.once("secureConnect", () => {
        const cert = (socket as TLSSocket).getPeerCertificate();
        if (!cert.raw || createHash("sha256").update(cert.raw).digest("base64url") !== pair.pin)
          req.destroy(new Error("pair pin mismatch"));
      });
    });
    req.on("error", reject);
    if (incomplete) req.write(body, () => setTimeout(() => req.destroy(new Error("fixture upload interrupted")), 100));
    else req.end(body);
  });
}

export async function until<T>(read: () => Promise<T | undefined>) {
  for (let i = 0; i < 45; i++) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(200);
  }
  throw new Error("没有等到预期回执");
}
