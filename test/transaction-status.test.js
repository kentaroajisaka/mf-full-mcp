import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

test("連携明細ツールのMCPとOAuth HTTP契約", async (t) => {
  const homeDir = mkdtempSync(join(os.tmpdir(), "mf-full-test-"));
  const homeMock = t.mock.method(os, "homedir", () => homeDir);
  syncBuiltinESMExports();
  t.after(() => {
    homeMock.mock.restore();
    syncBuiltinESMExports();
    rmSync(homeDir, { recursive: true, force: true });
  });

  const { createServer } = await import("../dist/server.js");
  const { putToken, setActive } = await import("../dist/tokens.js");
  for (const label of ["first", "second"]) {
    putToken({
      label, clientId: "mock-client", accessToken: label, refreshToken: `refresh-${label}`,
      expiresAt: Date.now() + 3600_000, scopes: "mfc/accounting/transaction.write",
    });
  }
  setActive("first");

  const ids = ["example%2Fid%3D", "other%2Bid%3D"];
  const journalizingStatuses = new Map(ids.map((id) => [id, "none"]));
  const accounts = { connected_accounts: [
    { id: "bank", last_synced_time: "2026/11/24 10:00", retrieval_status: "succeeded", service_category_code: "bank" },
    { id: "manual", last_synced_time: null, retrieval_status: null, service_category_code: "other" },
    { id: "legacy" },
  ] };
  const requests = [];
  let updateError;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    requests.push({ url, ...init });
    if (url.href === "https://api.biz.moneyforward.com/token") {
      assert.equal(new URLSearchParams(init.body).get("refresh_token"), "refresh-first");
      return Response.json({ access_token: "renewed-first" });
    }
    assert.equal(url.origin, "https://api-accounting.moneyforward.com");
    assert.equal(url.searchParams.has("office_code"), false);
    switch (`${init.method} ${url.pathname}`) {
      case "GET /api/v3/transactions":
        return Response.json({ transactions: [...journalizingStatuses]
          .map(([id, journalizing_status]) => ({ id, journalizing_status })) });
      case "GET /api/v3/connected_accounts":
        return Response.json(accounts);
      case "PUT /api/v3/transactions/statuses": {
        if (updateError) {
          if (updateError === 401 && init.headers.Authorization === "Bearer first") setActive("second");
          return Response.json({ error: "mock rejection" }, { status: updateError });
        }
        const { transaction_ids } = JSON.parse(init.body);
        for (const id of transaction_ids) journalizingStatuses.set(id, url.searchParams.get("to"));
        return Response.json({ transaction_ids });
      }
      default:
        assert.fail(`Unexpected HTTP request: ${init.method} ${url.href}`);
    }
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "mock-test", version: "1" });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name, args = {}) => client.callTool({ name: `mfc_ca_${name}`, arguments: args });
  const payload = (result) => {
    assert.equal(result.isError, undefined, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };

  const { tools } = await client.listTools();
  const statusTool = tools.find(({ name }) => name === "mfc_ca_putTransactionStatuses");
  assert.deepEqual(statusTool.inputSchema.required, ["to", "transaction_ids"]);
  assert.match(statusTool.description, /承認/);

  payload(await call("getTransactions", { start_date: "2026-11-01", end_date: "2026-11-24", per_page: 100 }));
  assert.equal(requests.at(-1).url.search, "?start_date=2026-11-01&end_date=2026-11-24&per_page=100");
  assert.deepEqual(payload(await call("getConnectedAccounts")), accounts);

  let count = requests.length;
  for (const args of [{}, { start_date: "2026-11-01" }, { end_date: "2026-11-24" },
    { ids, start_date: "2026-11-01" }, { ids, end_date: "2026-11-24" }, { ids: [] },
    { ids: Array(51).fill("id") }]) {
    assert.equal((await call("getTransactions", args)).isError, true);
  }
  for (const args of [{ to: "registered" }, { transaction_ids: [] }, { transaction_ids: ["id", "id"] },
    { transaction_ids: Array.from({ length: 1001 }, (_, i) => `id-${i}`) }]) {
    assert.equal((await call("putTransactionStatuses", { to: "excluded", transaction_ids: ids, ...args })).isError, true);
  }
  assert.equal(requests.length, count);

  for (const to of ["excluded", "none"]) {
    assert.deepEqual(payload(await call("putTransactionStatuses", { to, transaction_ids: ids })), { transaction_ids: ids });
    const request = requests.at(-1);
    assert.equal(request.url.search, `?to=${to}`);
    assert.equal(request.headers.Authorization, "Bearer first");
    assert.equal(request.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(request.body), { transaction_ids: ids });

    const { transactions } = payload(await call("getTransactions", { ids }));
    assert.equal(requests.at(-1).url.search, "?ids=example%2Fid%3D&ids=other%2Bid%3D");
    assert.deepEqual(transactions, ids.map((id) => ({ id, journalizing_status: to })));
  }

  for (const status of [400, 504]) {
    updateError = status;
    count = requests.length;
    const result = await call("putTransactionStatuses", { to: "excluded", transaction_ids: ids });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, new RegExp(`HTTP ${status}`));
    assert.deepEqual(payload(await call("getTransactions", { ids })).transactions,
      ids.map((id) => ({ id, journalizing_status: "none" })));
    assert.deepEqual(requests.slice(count).map(({ method }) => method), ["PUT", "GET"]);
  }

  updateError = 401;
  count = requests.length;
  const unauthorized = await call("putTransactionStatuses", { to: "excluded", transaction_ids: ids });
  assert.equal(unauthorized.isError, true);
  assert.deepEqual(requests.slice(count).map(({ method, headers }) => [method, headers.Authorization]), [
    ["PUT", "Bearer first"], ["POST", undefined], ["PUT", "Bearer renewed-first"],
  ]);
  payload(await call("getTransactions", { ids }));
  assert.equal(requests.at(-1).headers.Authorization, "Bearer second");

  updateError = undefined;
  const maxIds = Array.from({ length: 1000 }, (_, i) => `id-${i}`);
  assert.deepEqual(payload(await call("putTransactionStatuses", { to: "none", transaction_ids: maxIds })),
    { transaction_ids: maxIds });
});
