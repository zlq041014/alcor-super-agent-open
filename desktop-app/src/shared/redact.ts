// Shared display redaction: the local echo must not briefly expose a value the ledger masks.
export function redact(text: string) {
  return text
    .replace(/\b(?:sk|ghp|gho|xoxb|xoxp)-[\w-]{8,}/g, "[凭据已隐藏]")
    .replace(
      /((?:["']?)(?:authorization|proxy-authorization|x-api-key|[\w-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret))(?:["']?)\s*[:=]\s*["']?)(?:Bearer\s+|Basic\s+)?[^"'\s,;}]+/gi,
      "$1[已隐藏]",
    )
    .replace(/(Bearer\s+)\S+/gi, "$1[已隐藏]");
}
