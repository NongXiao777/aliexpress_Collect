const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const popupSource = readFileSync(path.join(__dirname, "../extension/popup.js"), "utf8");
const product = {
  source_platform: "aliexpress",
  source_product_id: "1005013209445272",
  source_url: "https://www.aliexpress.com/item/1005013209445272.html",
  title: "Example packing kit",
  visible_price: "$3.20",
  images: ["https://ae-pic-a1.aliexpress-media.com/kf/fixture.jpg"],
  variants: [{source_sku_id: "120000000000000001", stock_shown: 0, options: []}],
};
const itemTab = {id: 19, url: product.source_url};

function element(hidden = false) {
  const listeners = new Map();
  return {
    hidden,
    textContent: "",
    addEventListener(type, listener) {
      const registered = listeners.get(type) || [];
      registered.push(listener);
      listeners.set(type, registered);
    },
    async dispatch(type) {
      for (const listener of listeners.get(type) || []) await listener({type});
    },
  };
}

async function openPopup({tabs = [itemTab], results = [{ok: true, product}], scriptingError} = {}) {
  const nodes = new Map([
    ...["status", "product-title", "product-id", "price", "images", "variants",
      "copy-link", "export", "diagnostics-message"].map(id => [id, element()]),
    ...["product", "retry", "diagnostics"].map(id => [id, element(true)]),
  ]);
  const calls = {queries: [], scripts: [], copied: [], downloads: [], blobs: [], revoked: []};
  const timers = [];
  const queuedResults = [...results];
  const document = {
    querySelector(selector) { return nodes.get(selector.replace(/^#/, "")) || null; },
    createElement(tag) {
      assert.equal(tag, "a");
      return {
        href: "",
        download: "",
        click() { calls.downloads.push({href: this.href, filename: this.download}); },
      };
    },
  };
  class PopupURL extends URL {
    static createObjectURL(blob) {
      calls.blobs.push(blob);
      return `blob:popup-test-${calls.blobs.length}`;
    }
    static revokeObjectURL(url) { calls.revoked.push(url); }
  }
  const collectAliExpressProduct = function collectAliExpressProduct() {};
  const context = vm.createContext({
    document,
    Blob,
    URL: PopupURL,
    navigator: {clipboard: {async writeText(text) { calls.copied.push(text); }}},
    chrome: {
      tabs: {async query(query) { calls.queries.push(query); return tabs; }},
      scripting: {
        async executeScript(request) {
          calls.scripts.push(request);
          if (scriptingError) throw scriptingError;
          return [{result: queuedResults.shift()}];
        },
      },
    },
    collectAliExpressProduct,
    setTimeout(callback, delay) { timers.push({callback, delay}); return timers.length; },
  });
  vm.runInContext(popupSource, context, {filename: "popup.js"});
  // inspectPage starts immediately; allow its already-resolved Chrome API promises to settle.
  await new Promise(resolve => setImmediate(resolve));
  return {
    calls,
    timers,
    node: id => nodes.get(id),
    click: id => nodes.get(id).dispatch("click"),
    collectAliExpressProduct,
  };
}

test("popup displays the collected item and invokes scripting in the active tab", async () => {
  const popup = await openPopup();
  assert.equal(popup.node("status").textContent, "已读取当前商品");
  assert.equal(popup.node("product").hidden, false);
  assert.equal(popup.node("retry").hidden, true);
  assert.equal(popup.node("diagnostics").hidden, true);
  assert.equal(popup.node("product-title").textContent, product.title);
  assert.equal(popup.node("product-id").textContent, product.source_product_id);
  assert.equal(popup.node("price").textContent, "$3.20");
  assert.equal(popup.node("images").textContent, "1");
  assert.equal(popup.node("variants").textContent, "1");
  assert.equal(popup.calls.queries.length, 1);
  assert.equal(popup.calls.queries[0].active, true);
  assert.equal(popup.calls.queries[0].currentWindow, true);
  assert.equal(popup.calls.scripts.length, 1);
  assert.equal(popup.calls.scripts[0].target.tabId, itemTab.id);
  assert.equal(popup.calls.scripts[0].world, "MAIN");
  assert.equal(popup.calls.scripts[0].func, popup.collectAliExpressProduct);
});

test("export downloads the complete product JSON with its source ID filename", async () => {
  const popup = await openPopup();
  await popup.click("export");
  assert.deepEqual(popup.calls.downloads, [{
    href: "blob:popup-test-1",
    filename: "aliexpress-1005013209445272.json",
  }]);
  assert.equal(popup.calls.blobs[0].type, "application/json");
  const exported = await popup.calls.blobs[0].text();
  assert.deepEqual(JSON.parse(exported), product);
  assert.ok(exported.endsWith("\n"));
  assert.equal(JSON.parse(exported).variants[0].source_sku_id, "120000000000000001");
  assert.equal(popup.node("status").textContent, "已发起 JSON 下载");
  assert.deepEqual(popup.calls.revoked, []);
  assert.equal(popup.timers.length, 1);
  popup.timers[0].callback();
  assert.deepEqual(popup.calls.revoked, ["blob:popup-test-1"]);
});

test("copy link writes only the collected canonical source URL", async () => {
  const popup = await openPopup();
  await popup.click("copy-link");
  assert.deepEqual(popup.calls.copied, [product.source_url]);
  assert.equal(popup.node("status").textContent, "已复制商品链接");
  assert.deepEqual(popup.calls.downloads, []);
});

test("retry on verification clears the previous product and disables its export and copy", async () => {
  const popup = await openPopup({results: [{ok: true, product}, {ok: false, error: "verification_required"}]});
  assert.equal(popup.node("product").hidden, false);
  await popup.click("retry");
  assert.equal(popup.node("product").hidden, true);
  assert.equal(popup.node("retry").hidden, false);
  assert.match(popup.node("status").textContent, /验证/);
  assert.equal(popup.node("diagnostics").hidden, false);
  assert.ok(popup.node("diagnostics-message").textContent.trim());
  const verificationStatus = popup.node("status").textContent;
  await popup.click("export");
  await popup.click("copy-link");
  assert.deepEqual(popup.calls.downloads, []);
  assert.deepEqual(popup.calls.copied, []);
  assert.equal(popup.node("status").textContent, verificationStatus);
  assert.equal(popup.calls.scripts.length, 2);
});

test("unsupported host never injects a collector and leaves a retry action", async () => {
  const popup = await openPopup({tabs: [{id: 19, url: "https://aliexpress.com.evil.test/item/1005013209445272.html"}]});
  assert.equal(popup.node("status").textContent, "请打开一个速卖通商品详情页。");
  assert.equal(popup.node("product").hidden, true);
  assert.equal(popup.node("retry").hidden, false);
  assert.deepEqual(popup.calls.scripts, []);
  await popup.click("export");
  await popup.click("copy-link");
  assert.deepEqual(popup.calls.downloads, []);
  assert.deepEqual(popup.calls.copied, []);
});

test("unsupported AliExpress page reports the collector result without showing an item", async () => {
  const popup = await openPopup({results: [{ok: false, error: "unsupported_page"}]});
  assert.equal(popup.node("status").textContent, "请打开一个速卖通商品详情页。");
  assert.equal(popup.node("product").hidden, true);
  assert.equal(popup.node("retry").hidden, false);
  assert.equal(popup.calls.scripts.length, 1);
});

test("scripting failure produces a retryable error without exposing a product", async () => {
  const popup = await openPopup({scriptingError: new Error("Cannot access the page")});
  assert.equal(popup.node("status").textContent, "Chrome 未能读取当前标签页，请切回商品页后重试。");
  assert.equal(popup.node("product").hidden, true);
  assert.equal(popup.node("retry").hidden, false);
  await popup.click("export");
  await popup.click("copy-link");
  assert.deepEqual(popup.calls.downloads, []);
  assert.deepEqual(popup.calls.copied, []);
});
