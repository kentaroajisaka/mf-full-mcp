import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { putToken, updateToken, type OfficeToken } from "./tokens.js";

const AUTH_BASE = "https://api.biz.moneyforward.com";
// 既定は 0 = OS が空きポートを自動割当（エフェメラルポート / RFC 8252 loopback）。
// これで複数アプリ・複数VSCodeウィンドウが同時に mf-full を使ってもポート衝突しない。
// MF_FULL_CALLBACK_PORT を明示指定したときだけ固定ポートを使う（後方互換）。
const FIXED_CALLBACK_PORT = process.env.MF_FULL_CALLBACK_PORT ? Number(process.env.MF_FULL_CALLBACK_PORT) : 0;
const CLIENT_NAME = process.env.MF_FULL_CLIENT_NAME ?? "mf-full-mcp";

/**
 * 既定はクラウド会計の全16スコープ。MF_FULL_SCOPES で上書き可能。
 * 一部のスコープは MF 側の仕様変更により将来利用できなくなる可能性がある。
 */
export const DEFAULT_SCOPES = [
  "mfc/accounting/offices.read",
  "mfc/accounting/accounts.read",
  "mfc/accounting/departments.read",
  "mfc/accounting/journal.read",
  "mfc/accounting/journal.write",
  "mfc/accounting/report.read",
  "mfc/accounting/taxes.read",
  "mfc/accounting/trade_partners.read",
  "mfc/accounting/trade_partners.write",
  "mfc/accounting/connected_account.read",
  "mfc/accounting/transaction.read",
  "mfc/accounting/transaction.write",
  "mfc/accounting/voucher.read",
  "mfc/accounting/voucher.write",
  "mfc/accounting/master.read",
  "mfc/accounting/tatsuzin.read",
].join(" ");

export function scopes(): string {
  return process.env.MF_FULL_SCOPES?.trim() || DEFAULT_SCOPES;
}

type PendingAuth = {
  label: string;
  clientId: string;
  codeVerifier: string;
  state: string;
  scopes: string;
  server: Server;
  redirectUri: string;
  startedAt: number;
  status: "waiting" | "exchanging" | "done" | "error";
  error?: string;
};

let pending: PendingAuth | null = null;

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function registerClient(scopeString: string, redirectUri: string): Promise<string> {
  const res = await fetch(`${AUTH_BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [redirectUri],
      response_types: ["code"],
      scope: scopeString,
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) {
    throw new Error(`動的クライアント登録に失敗: HTTP ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { client_id?: string };
  if (!json.client_id) throw new Error("登録レスポンスに client_id がありません");
  return json.client_id;
}

async function exchangeToken(p: PendingAuth, code: string): Promise<void> {
  const body = new URLSearchParams({
    client_id: p.clientId,
    code,
    code_verifier: p.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: p.redirectUri,
  });
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`トークン交換に失敗: HTTP ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!json.access_token) throw new Error("トークンレスポンスに access_token がありません");

  const token: OfficeToken = {
    label: p.label,
    clientId: p.clientId,
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    scopes: json.scope ?? p.scopes,
    officeName: null,
    officeCode: null,
    authorizedAt: new Date().toISOString(),
  };
  putToken(token, true);

  // 事業者名を取得して保存（失敗しても認証自体は成立）
  try {
    const officeRes = await fetch("https://api-accounting.moneyforward.com/api/v3/offices", {
      headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" },
    });
    if (officeRes.ok) {
      const office = (await officeRes.json()) as { name?: string; code?: string };
      updateToken(p.label, { officeName: office.name ?? null, officeCode: office.code ?? null });
    }
  } catch {
    /* noop */
  }
}

/**
 * 認証フロー開始。コールバックサーバーを立てて認可 URL を返す。
 * ユーザーがブラウザで許可するとバックグラウンドで自動的にトークン交換・保存される。
 */
export async function startAuth(label: string, extraScopes?: string[]): Promise<{ authUrl: string; scopes: string }> {
  if (pending) {
    try {
      pending.server.close();
    } catch {
      /* noop */
    }
    pending = null;
  }

  const scopeString = [...new Set([...scopes().split(" "), ...(extraScopes ?? [])])].join(" ");
  const codeVerifier = b64url(randomBytes(48));
  const codeChallenge = b64url(createHash("sha256").update(codeVerifier).digest());
  const state = b64url(randomBytes(24));

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost"); // ポートは pathname/searchParams 解析に不要
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const p = pending;
    if (!p || p.status !== "waiting") {
      res.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" }).end("認証セッションが無効です。authenticate をやり直してください。");
      return;
    }
    const gotState = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const err = url.searchParams.get("error");
    if (err) {
      p.status = "error";
      p.error = `認可が拒否されました: ${err}`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<h2>認可が拒否されました。ターミナルに戻ってください。</h2>");
      p.server.close();
      return;
    }
    if (!code || gotState !== p.state) {
      p.status = "error";
      p.error = "state 不一致または code 欠落";
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end("<h2>認証パラメータが不正です。</h2>");
      p.server.close();
      return;
    }
    p.status = "exchanging";
    res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end("<h2>認証を受け付けました。このタブは閉じて構いません。</h2>");
    exchangeToken(p, code)
      .then(() => {
        p.status = "done";
      })
      .catch((e) => {
        p.status = "error";
        p.error = String(e);
      })
      .finally(() => {
        try {
          p.server.close();
        } catch {
          /* noop */
        }
      });
  });

  // 先にリスナーを立て、実際に割り当てられたポートを確定させる（エフェメラルポート対応）
  await new Promise<void>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") {
        reject(new Error(`固定ポート ${FIXED_CALLBACK_PORT} が使用中です。MF_FULL_CALLBACK_PORT の指定を外せば空きポートを自動割当します。`));
      } else {
        reject(e);
      }
    });
    server.listen(FIXED_CALLBACK_PORT, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : FIXED_CALLBACK_PORT;
  const redirectUri = `http://localhost:${actualPort}/callback`;

  // リスナー確定後に、そのポートの redirect_uri でクライアント登録する
  let clientId: string;
  try {
    clientId = await registerClient(scopeString, redirectUri);
  } catch (e) {
    try {
      server.close();
    } catch {
      /* noop */
    }
    throw e;
  }

  pending = {
    label,
    clientId,
    codeVerifier,
    state,
    scopes: scopeString,
    server,
    redirectUri,
    startedAt: Date.now(),
    status: "waiting",
  };

  const authUrl = new URL(`${AUTH_BASE}/authorize`);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scopeString);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return { authUrl: authUrl.toString(), scopes: scopeString };
}

export function authStatus(): { status: string; label?: string; error?: string } {
  if (!pending) return { status: "no_pending" };
  return { status: pending.status, label: pending.label, error: pending.error };
}

/** アクセストークンの refresh。成功時は新しい accessToken を返す。 */
export async function refreshAccessToken(token: OfficeToken): Promise<string> {
  if (!token.refreshToken) {
    throw new Error(`トークン "${token.label}" は期限切れで refresh_token がありません。authenticate し直してください。`);
  }
  const body = new URLSearchParams({
    client_id: token.clientId,
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
  });
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`トークン更新に失敗 (HTTP ${res.status})。authenticate し直してください。`);
  }
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("refresh レスポンスに access_token がありません");
  updateToken(token.label, {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? token.refreshToken,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  });
  return json.access_token;
}
