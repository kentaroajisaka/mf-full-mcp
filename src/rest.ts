import { refreshAccessToken } from "./auth.js";
import { getActiveToken, getToken } from "./tokens.js";

const API_BASE = "https://api-accounting.moneyforward.com/api/v3";

/**
 * MF の ID は Base64 の URL エンコード済み文字列（%2F 等を含む）。
 * URL パスに埋める際は全体を再エンコードしないと %2F がスラッシュに
 * デコードされてパスが壊れ 403 になる（mf-official-mcp スキル既知の罠）。
 */
export function encodePathId(id: string): string {
  return encodeURIComponent(id);
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

  // リクエスト中に use_office が呼ばれても、別事業者のトークンで再送しない。
  const token = getActiveToken();
  if (!token) {
    throw new Error("認証がありません。authenticate ツールで MF に認証してください。");
  }
  const needsRefresh = Date.now() > token.expiresAt - 60_000;
  const accessToken = needsRefresh ? await refreshAccessToken(token) : token.accessToken;
  let res = await doFetch(accessToken);

  if (res.status === 401) {
    const current = getToken(token.label);
    if (current) {
      // 別のリクエストが先に更新したトークンがあれば、その値を使う。
      const refreshed = current.accessToken === accessToken
        ? await refreshAccessToken(current)
        : current.accessToken;
      res = await doFetch(refreshed);
    }
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MF API error: HTTP ${res.status} ${method} ${path}\n${text}`);
  }
  return text || JSON.stringify({ status: res.status, ok: true });
}
