import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { api, encodePathId } from "./rest.js";
import { authStatus, startAuth, scopes } from "./auth.js";
import { listTokens, removeToken, setActive } from "./tokens.js";

function text(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload),
      },
    ],
  };
}

function errText(e: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
    isError: true,
  };
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "mf-full-mcp", version: "0.1.0" },
    {
      instructions: `マネーフォワード クラウド会計のフルスコープMCPサーバーです。公式beta MCPと同名のツール(mfc_ca_*)に加え、公式が提供しない証憑添付・添付解除・仕訳削除を提供します。

## 認証
- authenticate → 返ってきたURLをユーザーがブラウザで開いて事業者を選択・許可 → auth_status で完了確認
- トークンは事業者ごとにローカル保存され、use_office で切替できる（複数法人同時保持可）
- 既定スコープは mfc/accounting/* 全16個（voucher.write 込み）
- OAuthコールバックは空きポート自動割当（エフェメラル）。複数ウィンドウ/アプリで同時認証してもポート衝突しない（固定したい場合のみ MF_FULL_CALLBACK_PORT 環境変数）
- **アクティブ事業者はプロセス(セッション)ごとに独立**。use_office の切替は他セッションに影響しない。データ取得前に mfc_ca_currentOffice で対象法人を確認すると確実（MF_FULL_OFFICE で起動時固定も可）

## 注意
- ID は各 get 系ツールが返した URL エンコード済みの値をそのまま渡すこと
- 仕訳登録・更新・削除・証憑添付/解除・明細仕訳化は帳簿を書き換える。実行前にユーザーの承認を得ること
- putJournals は全置換 API。部分更新はできない
- invoice_kind は書き込み3値(QUALIFIED/NOT_TARGET/UNQUALIFIED_80)が公式仕様。それ以外の値は検証実験用`,
    }
  );

  // ---- 認証系 ----

  server.tool(
    "authenticate",
    "MFへのOAuth認証を開始する。返ってきたauthUrlをユーザーがブラウザで開き、事業者を選択して許可すると自動でトークンが保存される。完了確認はauth_status。",
    {
      label: z.string().optional().describe("トークンの保存名（事業者を区別するラベル。省略時 default）"),
      extra_scopes: z
        .string()
        .optional()
        .describe("既定の会計16スコープに追加で要求するスコープ（スペース区切り。例: 'mfc/payroll/payroll.read mfc/payroll/bonus.read'）"),
    },
    async ({ label, extra_scopes }) => {
      try {
        const r = await startAuth(label ?? "default", extra_scopes?.split(/\s+/).filter(Boolean));
        return text({
          authUrl: r.authUrl,
          scopes: r.scopes,
          next: "ユーザーにこのURLをブラウザで開いてもらい、事業者を選択して許可。その後 auth_status で完了確認。",
        });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool("auth_status", "進行中の認証フローの状態を確認する（waiting/exchanging/done/error）。", {}, async () => {
    return text(authStatus());
  });

  server.tool("list_offices", "保存済みトークン（事業者）の一覧とアクティブな接続先を表示する。", {}, async () => {
    return text(listTokens());
  });

  server.tool(
    "use_office",
    "このセッションのアクティブな接続先事業者を切り替える（プロセス内メモリのみ。他セッション/他ウィンドウには影響しない）。",
    { label: z.string().describe("list_offices で表示される保存名") },
    async ({ label }) => {
      try {
        const t = setActive(label);
        return text({ active: t.label, officeName: t.officeName });
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    "remove_office",
    "保存済みトークンを削除する。",
    { label: z.string() },
    async ({ label }) => {
      return text({ removed: removeToken(label) });
    }
  );

  // ---- 公式互換: 参照系 ----

  const availableParam = {
    available: z
      .boolean()
      .optional()
      .describe("省略/true=有効のみ、false=全件（有効+無効）。falseは『無効のみ』ではない点に注意"),
  };

  server.tool("mfc_ca_currentOffice", "事業者情報と会計期間を取得します。", {}, async () => {
    try {
      return text(await api("GET", "/offices"));
    } catch (e) {
      return errText(e);
    }
  });

  server.tool("mfc_ca_getTermSettings", "会計年度設定（税込/税抜・課税方式等）を取得します。", {}, async () => {
    try {
      return text(await api("GET", "/term_settings"));
    } catch (e) {
      return errText(e);
    }
  });

  for (const [tool, path, desc] of [
    ["mfc_ca_getAccounts", "/accounts", "勘定科目を取得します。"],
    ["mfc_ca_getSubAccounts", "/sub_accounts", "補助科目を取得します。"],
    ["mfc_ca_getDepartments", "/departments", "部門を取得します。"],
    ["mfc_ca_getTaxes", "/taxes", "税区分を取得します。"],
    ["mfc_ca_getTradePartners", "/trade_partners", "取引先を取得します。"],
  ] as const) {
    server.tool(tool, desc, availableParam, async ({ available }) => {
      try {
        return text(await api("GET", path, { query: { available } }));
      } catch (e) {
        return errText(e);
      }
    });
  }

  server.tool(
    "mfc_ca_postTradePartners",
    "取引先を作成します。",
    { trade_partner: z.record(z.any()).describe("取引先オブジェクト（code, name 等）") },
    async ({ trade_partner }) => {
      try {
        return text(await api("POST", "/trade_partners", { body: { trade_partner } }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool("mfc_ca_getConnectedAccounts", "連携サービス（自動連携・手動管理とも）を取得します。", {}, async () => {
    try {
      return text(await api("GET", "/connected_accounts"));
    } catch (e) {
      return errText(e);
    }
  });

  // ---- 公式互換: 仕訳 ----

  server.tool(
    "mfc_ca_getJournals",
    "仕訳一覧を取得します。start_date または end_date のいずれかが必要。",
    {
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      account_id: z.string().optional(),
      is_realized: z.boolean().optional(),
      transaction_ids: z.array(z.string()).optional(),
      page: z.number().int().optional(),
      per_page: z.number().int().optional().describe("最大10000"),
    },
    async (args) => {
      try {
        return text(await api("GET", "/journals", { query: args }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    "mfc_ca_getJournalById",
    "仕訳を1件取得します。",
    { id: z.string().describe("仕訳ID（URLエンコード済みのまま）") },
    async ({ id }) => {
      try {
        return text(await api("GET", `/journals/${encodePathId(id)}`));
      } catch (e) {
        return errText(e);
      }
    }
  );

  const journalParam = {
    journal: z
      .record(z.any())
      .describe(
        "仕訳オブジェクト { transaction_date, journal_type: 'journal_entry'|'adjusting_entry', branches: [{debitor?, creditor?, remark?}], tags?, memo? }。invoice_kind は自由値を許容（公式書込み3値以外は検証実験用）"
      ),
  };

  server.tool("mfc_ca_postJournals", "仕訳を作成します（帳簿書き込み。要ユーザー承認）。", journalParam, async ({ journal }) => {
    try {
      return text(await api("POST", "/journals", { body: { journal } }));
    } catch (e) {
      return errText(e);
    }
  });

  server.tool(
    "mfc_ca_putJournals",
    "仕訳を更新します（全置換API・帳簿書き込み。要ユーザー承認）。",
    { id: z.string(), ...journalParam },
    async ({ id, journal }) => {
      try {
        return text(await api("PUT", `/journals/${encodePathId(id)}`, { body: { journal } }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    "mfc_ca_deleteJournals",
    "仕訳を完全削除します（公式MCP未提供・帳簿書き込み。要ユーザー承認）。",
    { id: z.string() },
    async ({ id }) => {
      try {
        return text(await api("DELETE", `/journals/${encodePathId(id)}`));
      } catch (e) {
        return errText(e);
      }
    }
  );

  // ---- 公式互換: 帳票 ----

  const trialParams = {
    fiscal_year: z.number().int().optional(),
    start_month: z.number().int().optional().describe("カレンダー月"),
    end_month: z.number().int().optional().describe("カレンダー月"),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    with_sub_accounts: z.boolean().optional(),
    include_tax: z.boolean().optional(),
    journal_types: z.array(z.string()).optional(),
  };
  server.tool("mfc_ca_getReportsTrialBalanceBalanceSheet", "貸借対照表の試算表（累計）を取得します。", trialParams, async (args) => {
    try {
      return text(await api("GET", "/reports/trial_balance_bs", { query: args }));
    } catch (e) {
      return errText(e);
    }
  });
  server.tool("mfc_ca_getReportsTrialBalanceProfitLoss", "損益計算書の試算表（累計）を取得します。", trialParams, async (args) => {
    try {
      return text(await api("GET", "/reports/trial_balance_pl", { query: args }));
    } catch (e) {
      return errText(e);
    }
  });

  const transitionParams = {
    type: z.string().describe("推移表の種類（例: monthly）"),
    fiscal_year: z.number().int().optional(),
    start_month: z.number().int().optional(),
    end_month: z.number().int().optional(),
    with_sub_accounts: z.boolean().optional(),
    include_tax: z.boolean().optional(),
  };
  server.tool("mfc_ca_getReportsTransitionBalanceSheet", "貸借対照表の推移表（月別）を取得します。", transitionParams, async (args) => {
    try {
      return text(await api("GET", "/reports/transition_bs", { query: args }));
    } catch (e) {
      return errText(e);
    }
  });
  server.tool("mfc_ca_getReportsTransitionProfitLoss", "損益計算書の推移表（月別）を取得します。", transitionParams, async (args) => {
    try {
      return text(await api("GET", "/reports/transition_pl", { query: args }));
    } catch (e) {
      return errText(e);
    }
  });

  // ---- 公式互換: 明細 ----

  server.tool(
    "mfc_ca_getTransactions",
    "連携サービスで収集された明細一覧を取得します（自動連携・手動とも）。",
    {
      start_date: z.string().describe("YYYY-MM-DD。end_dateとの差366日以内"),
      end_date: z.string(),
      connected_account_id: z.string().optional(),
      connected_sub_account_id: z.string().optional(),
      journalizing_statuses: z
        .array(z.enum(["excluded", "none", "registered", "modified", "new_voucher_attached"]))
        .optional(),
      side: z.enum(["INCOME", "EXPENSE"]).optional(),
      value_min: z.number().int().optional(),
      value_max: z.number().int().optional(),
      content: z.string().optional(),
      content_match_type: z.enum(["exact", "partial", "forward", "backward"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
      page: z.number().int().optional(),
      per_page: z.number().int().optional().describe("10〜1000"),
    },
    async (args) => {
      try {
        return text(await api("GET", "/transactions", { query: args }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    "mfc_ca_postTransactions",
    "手動管理の連携サービスに明細を作成します（要ユーザー承認）。",
    {
      connected_account_id: z.string().describe("手動管理(is_manual: true)の連携サービスID"),
      transactions: z
        .array(
          z.object({
            date: z.string(),
            value: z.number().int(),
            side: z.enum(["INCOME", "EXPENSE"]),
            content: z.string(),
            memo: z.string().optional(),
          })
        )
        .min(1),
    },
    async ({ connected_account_id, transactions }) => {
      try {
        return text(await api("POST", "/transactions", { body: { connected_account_id, transactions } }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    "mfc_ca_postTransactionJournalize",
    "明細から仕訳を作成します（帳簿書き込み。要ユーザー承認）。相手科目account_idのみ必須。貸借方向・口座側科目・税区分・invoice_kindはMFが自動補完。",
    {
      transaction_id: z.string().describe("明細ID（URLエンコード済みのまま）"),
      account_id: z.string().describe("相手勘定科目ID"),
      sub_account_id: z.string().optional(),
      department_id: z.string().optional(),
      trade_partner_code: z.string().optional(),
      tax_id: z.string().optional(),
      invoice_kind: z.string().optional().describe("公式書込み3値以外も送信可（検証実験用）"),
      transaction_date: z.string().optional().describe("省略時は明細の取引日"),
      remark: z.string().optional(),
      memo: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    async (args) => {
      try {
        return text(await api("POST", "/transactions/journalize", { body: args }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  // ---- 公式未提供: 証憑 ----

  server.tool(
    "mfc_ca_postVouchers",
    "証憑をアップロードし仕訳に添付します（公式MCP未提供・要ユーザー承認）。file_paths を渡せばローカルファイルを自動でbase64化する。journal_id 省略時は孤立証憑になる（後から仕訳に紐づける手段はない）ので原則指定すること。",
    {
      journal_id: z.string().optional().describe("添付先の仕訳ID"),
      file_paths: z.array(z.string()).optional().describe("ローカルファイルの絶対パス（file_name/file_dataは自動生成）"),
      voucher_files: z
        .array(z.object({ file_name: z.string(), file_data: z.string().describe("base64") }))
        .optional()
        .describe("base64を直接渡す場合"),
    },
    async ({ journal_id, file_paths, voucher_files }) => {
      try {
        const files = [
          ...(voucher_files ?? []),
          ...(file_paths ?? []).map((p) => ({
            file_name: basename(p),
            file_data: readFileSync(p).toString("base64"),
          })),
        ];
        if (files.length === 0) {
          return errText(new Error("file_paths か voucher_files のどちらかを指定してください"));
        }
        return text(await api("POST", "/vouchers", { body: { journal_id, voucher_files: files } }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    "mfc_ca_deleteVouchers",
    "仕訳と証憑の紐付けを解除します（証憑自体は孤立して残る。公式MCP未提供・要ユーザー承認）。",
    {
      journal_id: z.string(),
      voucher_file_id: z.string(),
    },
    async (args) => {
      try {
        return text(await api("DELETE", "/vouchers", { body: args }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  // ---- 情報 ----

  server.tool("mf_full_info", "このサーバーの設定情報（要求スコープ・コールバックポート等）を表示する。", {}, async () => {
    return text({
      requestedScopes: scopes(),
      callbackPort: process.env.MF_FULL_CALLBACK_PORT
        ? Number(process.env.MF_FULL_CALLBACK_PORT)
        : "ephemeral (認証ごとに空きポートを自動割当)",
      tokensFile: "~/.mf-full-mcp/tokens.json",
    });
  });

  return server;
}
