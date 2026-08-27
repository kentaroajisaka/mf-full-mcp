import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type OfficeToken = {
  label: string;
  clientId: string;
  accessToken: string;
  refreshToken: string | null;
  /** epoch ms */
  expiresAt: number;
  scopes: string;
  officeName: string | null;
  officeCode: string | null;
  authorizedAt: string;
};

type Store = {
  version: 1;
  active: string | null;
  offices: Record<string, OfficeToken>;
};

const DIR = join(homedir(), ".mf-full-mcp");
const FILE = join(DIR, "tokens.json");

// アクティブ事業者は「プロセス(=セッション)ごと」にメモリで保持する。
// 共有ファイル tokens.json の active は、setActive を一度も呼んでいない新規プロセスの
// 初期デフォルトとしてのみ使う。これにより、別ウィンドウ/別アプリが use_office で
// 事業者を切り替えても、このセッションのアクティブ事業者は影響を受けない
// （＝別法人のデータを誤って取得する事故を防ぐ）。
// MF_FULL_OFFICE 環境変数で起動時にセッションのアクティブを固定することもできる。
let sessionActive: string | null = process.env.MF_FULL_OFFICE ?? null;

function load(): Store {
  if (!existsSync(FILE)) {
    return { version: 1, active: null, offices: {} };
  }
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Store;
  } catch {
    return { version: 1, active: null, offices: {} };
  }
}

function save(store: Store): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodSync(FILE, 0o600);
}

export function putToken(token: OfficeToken, makeActive = true): void {
  const store = load();
  store.offices[token.label] = token;
  if (makeActive || !store.active) store.active = token.label; // 共有デフォルトの初期化
  save(store);
  if (makeActive) sessionActive = token.label; // 新規認証したセッションを即その事業者に向ける
}

export function updateToken(label: string, patch: Partial<OfficeToken>): void {
  const store = load();
  const cur = store.offices[label];
  if (!cur) return;
  store.offices[label] = { ...cur, ...patch };
  save(store);
}

export function getActiveToken(): OfficeToken | null {
  const store = load();
  const label = sessionActive ?? store.active; // セッション内の指定を最優先、なければ共有デフォルト
  if (!label) return null;
  return store.offices[label] ?? null;
}

export function setActive(label: string): OfficeToken {
  const store = load();
  const t = store.offices[label];
  if (!t) {
    throw new Error(
      `保存済みトークン "${label}" がありません。list_offices で確認するか authenticate で認証してください。`
    );
  }
  sessionActive = label; // プロセス内メモリのみ変更。共有ファイルの active は書き換えない
  return t;
}

export function listTokens(): { active: string | null; offices: Array<Pick<OfficeToken, "label" | "officeName" | "officeCode" | "authorizedAt" | "expiresAt" | "scopes">> } {
  const store = load();
  return {
    active: sessionActive ?? store.active, // このセッションが実際に使うアクティブを返す
    offices: Object.values(store.offices).map((t) => ({
      label: t.label,
      officeName: t.officeName,
      officeCode: t.officeCode,
      authorizedAt: t.authorizedAt,
      expiresAt: t.expiresAt,
      scopes: t.scopes,
    })),
  };
}

export function removeToken(label: string): boolean {
  const store = load();
  if (!store.offices[label]) return false;
  delete store.offices[label];
  if (store.active === label) {
    store.active = Object.keys(store.offices)[0] ?? null;
  }
  if (sessionActive === label) {
    sessionActive = Object.keys(store.offices)[0] ?? null; // セッションのアクティブも解除
  }
  save(store);
  return true;
}
