import { refreshAccessToken } from "./auth.js";
import { getActiveToken } from "./tokens.js";

const API_BASE = "https://api-accounting.moneyforward.com/api/v3";

/**
 * MF の ID は Base64 の URL エンコード済み文字列（%2F 等を含む）。
 * URL パスに埋める際は全体を再エンコードしないと %2F がスラッシュに
 * デコードされてパスが壊れ 403 になる（mf-official-mcp スキル既知の罠）。
 */
export function encodePathId(id: string): string {
  return encodeURIComponent(id);
}

async function bearer(): Promise<string> {
  const token = getActiveToken();
  if (!token) {
    throw new Error("認証がありません。authenticate ツールで MF に認証してください。");
  }
  if (Date.now() > token.expiresAt - 60_000) {
    return refreshAccessToken(token);
  }
  return token.accessToken;
}

/**
 * MF の ID はエンコード済み(%3D等)で渡ってくるため、URLSearchParams に通すと
 * 二重エンコードになる。%XX を含む値はそのまま、それ以外だけエンコードする。
 * 配列パラメータは `k=v1&k=v2` 形式（`[]` 付きは unsupported_query_parameter になる）。
 */
function encodeQueryValue(v: string): string {
  return /%[0-9A-Fa-f]{2}/.test(v) ? v : encodeURIComponent(v);
}

export async function api(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: { query?: Record<string, unknown>; body?: unknown } = {}
): Promise<string> {
  const qs: string[] = [];
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined || v === null) continue;
    const vals = Array.isArray(v) ? v : [v];
    for (const item of vals) qs.push(`${k}=${encodeQueryValue(String(item))}`);
  }
  const url = `${API_BASE}${path}${qs.length ? `?${qs.join("&")}` : ""}`;

  const doFetch = async (accessToken: string) =>
    fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  let res = await doFetch(await bearer());

  // 401 は一度だけ refresh してリトライ
  if (res.status === 401) {
    const token = getActiveToken();
    if (token) {
      const refreshed = await refreshAccessToken(token);
      res = await doFetch(refreshed);
    }
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MF API error: HTTP ${res.status} ${method} ${path}\n${text}`);
  }
  return text || JSON.stringify({ status: res.status, ok: true });
}
