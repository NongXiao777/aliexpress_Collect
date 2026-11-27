const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const collector = require("../extension/collector.js");

const backgroundSource = readFileSync(path.join(__dirname, "../extension/background.js"), "utf8");
const manifest = JSON.parse(readFileSync(path.join(__dirname, "../extension/manifest.json"), "utf8"));
const id = "1005013209445272";
const otherId = "1005013209445000";
const canonical = `https://www.aliexpress.com/item/${id}.html`;
const patterns = ["https://www.aliexpress.com/*", "https://m.aliexpress.com/*", "https://aliexpress.com/*"];
const product = () => ({source: "aliexpress", source_product_id: id, source_url: canonical,
  title: "Packing kit", images: ["https://ae-pic-a1.aliexpress-media.com/kf/example.jpg"],
  specifications: [{name: "Material", value: "Rubber"}],
  variants: [{source_sku_id: "120000000000000001", options: [{name: "Color", value: "Blue"}], stock_shown: 0}],
  visible_price: "$1.09", currency: null, description: null});
const itemTab = (tabId = 19, extra = {}) => ({id: tabId, url: canonical + "?spm=tracking", active: true, ...extra});
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(options = {}) {
  const tabs = options.tabs ?? [itemTab()];
  const sourceProduct = options.product ?? product();
  const result = options.result ?? {ok: true, product: sourceProduct};
  const calls = {imports: [], queries: [], gets: [], scripts: []};
  const browser = {
    runtime: {id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", getManifest() {
      if (options.manifestError) throw new Error("Internal metadata error");
      return manifest;
    }},
    tabs: {
      async query(query) {
        calls.queries.push(clone(query));
        if (options.queryError) throw new Error("Must not expose other tab content");
        return tabs;
      },
      async get(selectedId) {
        calls.gets.push(selectedId);
        if (options.getErrorAt === calls.gets.length) throw new Error("Tab closed");
        const current = tabs.find(tab => tab.id === selectedId);
        if (options.get) return options.get(selectedId, calls.gets.length, current);
        if (!current) throw new Error("Tab absent");
        return {...current};
      },
    },
    scripting: {async executeScript(script) {
      calls.scripts.push(script);
      assert.equal(script.world, "MAIN");
      assert.equal(typeof script.func, "function");
      assert.equal(script.func.toString(), collector.toString());
      assert.deepEqual(Object.keys(script.target), ["tabId"]);
      if (options.injectionError) throw new Error("Permission denied");
      if (options.afterInjection) options.afterInjection(tabs);
      return options.frames ?? [{frameId: 0, result}];
    }},
  };
  const context = vm.createContext({URL, chrome: options.browser === undefined ? browser : options.browser,
    importScripts(filename) {
      calls.imports.push(filename);
      assert.equal(filename, "collector.js");
      context.collectAliExpressProduct = collector;
    }});
  vm.runInContext(backgroundSource, context);
  return {calls, browser, tabs, sourceProduct, context, collect: context.zyingAliExpressCollect};
}

test("worker uses scoped AliExpress permissions and retains the optional popup", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.2.0");
  assert.equal(manifest.background.service_worker, "background.js");
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting"]);
  assert.deepEqual(manifest.host_permissions, patterns);
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(Object.hasOwn(manifest, "externally_connectable"), false);
});

test("background returns the matched product directly with provenance and unchanged source arrays", async () => {
  const context = fixture();
  const before = clone(context.sourceProduct);
  const response = await context.collect({source_product_id: id, target_url: canonical});
  assert.equal(response.ok, true);
  assert.equal(response.collector_origin, "extension_service_worker");
  assert.deepEqual(clone(response.extension), {id: context.browser.runtime.id, name: manifest.name, version: "0.2.0"});
  assert.equal(response.product, context.sourceProduct);
  assert.equal(response.product.images, context.sourceProduct.images);
  assert.equal(response.product.variants, context.sourceProduct.variants);
  assert.deepEqual(context.sourceProduct, before);
  assert.deepEqual(context.calls.imports, ["collector.js"]);
  assert.deepEqual(context.calls.queries, [{url: patterns}]);
  assert.deepEqual(context.calls.gets, [19, 19]);
  assert.equal(context.calls.scripts.length, 1);
  assert.equal(context.calls.scripts[0].target.tabId, 19);
});

test("explicit Chrome tab ID avoids querying and validates its item before injection", async () => {
  const context = fixture({tabs: [itemTab(71), itemTab(72)]});
  const response = await context.collect({source_product_id: id, tab_id: 72});
  assert.equal(response.ok, true);
  assert.deepEqual(context.calls.queries, []);
  assert.deepEqual(context.calls.gets, [72, 72]);
  assert.equal(context.calls.scripts[0].target.tabId, 72);
});

test("a unique active item wins among duplicate matches and unrelated tabs are not exposed", async () => {
  const context = fixture({tabs: [itemTab(19, {active: false}), itemTab(20),
    {id: 21, active: true, url: `https://www.aliexpress.com/item/${otherId}.html`, title: "private other item"},
    {id: 22, active: true, url: "https://example.com/private", title: "private other site"}]});
  const response = await context.collect({source_product_id: id});
  assert.equal(response.ok, true);
  assert.deepEqual(context.calls.gets, [20, 20]);
  assert.ok(!JSON.stringify(response).includes("private"));
});

test("a unique inactive matching tab can be read without activating or creating tabs", async () => {
  const context = fixture({tabs: [itemTab(19, {active: false})]});
  assert.equal((await context.collect({source_product_id: id})).ok, true);
  assert.equal(context.calls.scripts[0].target.tabId, 19);
});

test("multiple inactive or multiple active matches fail without inspecting candidate contents", async () => {
  for (const active of [true, false]) {
    const context = fixture({tabs: [itemTab(19, {active, title: "private first"}), itemTab(20, {active, title: "private second"})]});
    const response = await context.collect({source_product_id: id});
    assert.equal(response.error, "ambiguous_source_tabs");
    assert.deepEqual(context.calls.gets, []);
    assert.deepEqual(context.calls.scripts, []);
    assert.ok(!JSON.stringify(response).includes("private"));
  }
});

test("absent source tabs fail without returning other URLs or titles", async () => {
  const context = fixture({tabs: [itemTab(19, {url: `https://www.aliexpress.com/item/${otherId}.html`, title: "private"})]});
  const response = await context.collect({source_product_id: id});
  assert.equal(response.error, "source_tab_not_found");
  assert.deepEqual(context.calls.gets, []);
  assert.ok(!JSON.stringify(response).includes(otherId));
});

test("invalid request identities and target URLs fail before any Chrome call", async () => {
  const requests = [null, [], {}, {source_product_id: Number(id)}, {source_product_id: "1"},
    {source_product_id: "1".repeat(25)}, {source_product_id: id, tab_id: "19"},
    {source_product_id: id, tab_id: 0}, {source_product_id: id, unexpected: true},
    {source_product_id: id, target_url: `https://www.aliexpress.com/item/${otherId}.html`},
    {source_product_id: id, target_url: canonical + "?spm=tracking"},
    {source_product_id: id, target_url: canonical + "#fragment"},
    {source_product_id: id, target_url: "http://www.aliexpress.com/item/" + id + ".html"},
    {source_product_id: id, target_url: "https://user:password@www.aliexpress.com/item/" + id + ".html"},
    {source_product_id: id, target_url: "https://www.aliexpress.com:444/item/" + id + ".html"},
    {source_product_id: id, target_url: "https://www.aliexpress.com.evil.example/item/" + id + ".html"}];
  for (const request of requests) {
    const context = fixture();
    const response = await context.collect(request);
    assert.equal(response.ok, false, JSON.stringify(request));
    assert.deepEqual(context.calls.queries, []);
    assert.deepEqual(context.calls.gets, []);
    assert.deepEqual(context.calls.scripts, []);
  }
});

test("supported aliases and item/i paths accept page tracking parameters", async () => {
  for (const hostname of ["www.aliexpress.com", "m.aliexpress.com", "aliexpress.com"]) {
    for (const segment of ["item", "i"]) {
      const context = fixture({tabs: [itemTab(19, {url: `https://${hostname}/${segment}/${id}.html?tracking=1`})]});
      assert.equal((await context.collect({source_product_id: id})).ok, true);
    }
  }
});

test("an explicit mismatched or unsafe tab is rejected before script injection", async () => {
  const addresses = [`https://www.aliexpress.com/item/${otherId}.html`,
    `http://www.aliexpress.com/item/${id}.html`, `https://www.aliexpress.com.evil.example/item/${id}.html`,
    `https://user:password@www.aliexpress.com/item/${id}.html`, `https://www.aliexpress.com:444/item/${id}.html`];
  for (const url of addresses) {
    const context = fixture({tabs: [itemTab(19, {url})]});
    assert.equal((await context.collect({source_product_id: id, tab_id: 19})).error, "source_tab_mismatch");
    assert.deepEqual(context.calls.scripts, []);
  }
});

test("navigation before injection and during injection cannot return stale product data", async () => {
  const before = fixture({get: (selected, count, tab) => count === 1 ? {...tab,
    url: `https://www.aliexpress.com/item/${otherId}.html`} : tab});
  assert.equal((await before.collect({source_product_id: id})).error, "source_tab_mismatch");
  assert.deepEqual(before.calls.scripts, []);
  for (const url of [`https://www.aliexpress.com/item/${otherId}.html`, "https://example.com/redirect", canonical + "?changed=1"]) {
    const context = fixture({afterInjection: tabs => { tabs[0].url = url; }});
    const response = await context.collect({source_product_id: id});
    assert.equal(response.error, "page_navigation_during_collection");
    assert.equal(Object.hasOwn(response, "product"), false);
    assert.deepEqual(context.calls.gets, [19, 19]);
  }
});

test("mismatched collector identity or unsafe source URLs cannot return success", async () => {
  const mutations = [value => {value.source_product_id = otherId;}, value => {value.source = "other";},
    value => {value.source_url = `https://www.aliexpress.com/item/${otherId}.html`;},
    value => {value.source_url = canonical + "?private=1";},
    value => {value.source_url = `https://www.aliexpress.com.evil.example/item/${id}.html`;}];
  for (const change of mutations) {
    const data = product(); change(data);
    const context = fixture({product: data});
    const response = await context.collect({source_product_id: id});
    assert.equal(response.error, "collector_source_mismatch");
    assert.equal(Object.hasOwn(response, "product"), false);
  }
});

test("collector loading/login/verification failures remain concrete and preserve safe diagnostics", async () => {
  for (const error of ["product_not_loaded", "login_required", "verification_required"]) {
    const diagnostics = {state: "verification_pending", error_code: "network_error", retry_count: 2};
    const context = fixture({result: {ok: false, error, diagnostics}});
    const response = await context.collect({source_product_id: id});
    assert.equal(response.error, error);
    assert.deepEqual(response.diagnostics, diagnostics);
    assert.equal(Object.hasOwn(response, "product"), false);
  }
});

test("Chrome API failures are sanitized and never retried", async () => {
  const cases = [[{queryError: true}, "browser_tabs_unavailable"],
    [{getErrorAt: 1}, "source_tab_unavailable"], [{getErrorAt: 2}, "source_tab_unavailable"],
    [{injectionError: true}, "browser_injection_failed"], [{manifestError: true}, "extension_metadata_unavailable"],
    [{browser: null}, "browser_api_unavailable"]];
  for (const [options, expected] of cases) {
    const context = fixture(options);
    const response = await context.collect({source_product_id: id});
    assert.equal(response.error, expected);
    assert.ok(context.calls.queries.length <= 1 && context.calls.scripts.length <= 1 && context.calls.gets.length <= 2);
    assert.ok(!JSON.stringify(response).includes("private"));
  }
});

test("malformed script frame responses never return a product", async () => {
  for (const frames of [[], [{frameId: 0, result: null}], [{result: {ok: true}}], [{result: {}}, {result: {}}]]) {
    const context = fixture({frames});
    const response = await context.collect({source_product_id: id});
    assert.equal(response.ok, false);
    assert.equal(Object.hasOwn(response, "product"), false);
  }
});
