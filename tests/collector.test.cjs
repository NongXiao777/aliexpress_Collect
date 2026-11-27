const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const collect = require("../extension/collector.js");

const url = "https://www.aliexpress.com/item/1005013209445272.html?spm=tracking";
const doc = features => ({
  title: "Example item",
  querySelector: selectors => {
    const matches = features?.[selectors];
    return Array.isArray(matches) ? matches[0] || null : matches || null;
  },
  querySelectorAll: selectors => Array.isArray(features?.[selectors]) ? features[selectors] : [],
});

const productPage = id => ({
  runParams: {data: {result: {
    GLOBAL_DATA: {globalData: {productId: id, currencyCode: "USD", securityToken: "private-marker"}},
    PRODUCT_TITLE: {text: "Example packing kit"},
    PRICE: {targetSkuPriceInfo: {salePriceString: "$3.20"}},
    HEADER_IMAGE_PC: {imagePathList: [
      "//ae-pic-a1.aliexpress-media.com/kf/fixture.jpg?token=private-marker",
      "https://example.com/unrelated.jpg",
    ]},
    SKU: {
      skuProperties: [{
        skuPropertyId: 14,
        skuPropertyName: "Color",
        skuPropertyValues: [{propertyValueIdLong: 123, propertyValueDisplayName: "Blue"}],
      }],
      skuPaths: [
        {skuIdStr: "120000000000000001", path: "14:123", skuStock: 0},
        {skuIdStr: "120000000000000002", path: "14:123", skuStock: 5},
      ],
    },
  }}},
});

test("exports the matched item and safe image links while preserving source SKU precision", () => {
  const outcome = collect(doc(), productPage("1005013209445272"), url);
  assert.equal(outcome.product.title, "Example packing kit");
  assert.equal(outcome.product.source_url, "https://www.aliexpress.com/item/1005013209445272.html");
  assert.deepEqual(outcome.product.images, ["https://ae-pic-a1.aliexpress-media.com/kf/fixture.jpg"]);
  assert.deepEqual(outcome.product.variants.map(row => [row.source_sku_id, row.stock_shown]),
    [["120000000000000001", 0], ["120000000000000002", 5]]);
  assert.equal(outcome.product.variants[0].options[0].value, "Blue");
  assert.ok(!JSON.stringify(outcome).includes("private-marker"));
});

test("ignores state belonging to a different product and rejects unsupported pages", () => {
  assert.equal(collect(doc(), productPage("1000000000000"), url).error, "product_not_loaded");
  assert.equal(collect(doc(), {}, "https://aliexpress.com.evil.test/item/1005013209445272.html").error,
    "unsupported_page");
  assert.equal(collect({...doc(), title: "Security verification"}, {}, url).error, "verification_required");
  const redirect = "https://www.aliexpress.com//item/1005013209445272.html/_____tmd_____/punish";
  assert.equal(collect(doc(), {}, redirect).error, "verification_required");
});

test("uses the page heading when product state is not exposed", () => {
  const heading = {textContent: "  An item    visible here  "};
  const outcome = collect(doc({
    "[data-pl='product-title'] h1, h1[data-pl='product-title'], [class*='title--wrap--'] h1, h1": [heading],
    h1: [heading],
  }), {}, url);
  assert.equal(outcome.product.title, "An item visible here");
  assert.deepEqual(outcome.product.variants, []);
});

test("reads the visible product H1 after the hidden AliExpress logo, including serialized injection", () => {
  const logo = {textContent: "Aliexpress", getClientRects: () => []};
  const product = {textContent: "1020Pcs Black O-Ring Gasket Kit", getClientRects: () => [{}]};
  const page = doc({
    "[data-pl='product-title'] h1, h1[data-pl='product-title'], [class*='title--wrap--'] h1, h1": [logo, product],
    "[data-pl='product-title'] h1, h1[data-pl='product-title']": [product],
    h1: [logo, product],
  });
  const outcome = collect(page, {runParams: {}}, url);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.product.title, product.textContent);
  assert.equal(outcome.product.source_product_id, "1005013209445272");
  const injected = vm.runInNewContext(`(${collect.toString()})()`, {
    document: page, window: {runParams: {}}, location: {href: url}, URL,
  });
  assert.equal(injected.ok, true);
  assert.equal(injected.product.title, product.textContent);
});

test("prioritizes a product-specific H1 over an earlier unrelated visible heading", () => {
  const unrelated = {textContent: "Recommended items", getClientRects: () => [{}]};
  const product = {textContent: "Example packing kit", getClientRects: () => [{}]};
  const page = doc({
    "[data-pl='product-title'] h1, h1[data-pl='product-title'], [class*='title--wrap--'] h1, h1": [unrelated, product],
    "[data-pl='product-title'] h1, h1[data-pl='product-title']": [product],
    h1: [unrelated, product],
  });
  assert.equal(collect(page, {}, url).product.title, product.textContent);
});

test("skips hidden, empty, and generic H1 candidates before using the visible fallback", () => {
  const headings = [
    {textContent: "Aliexpress"},
    {textContent: "Hidden item", hidden: true},
    {textContent: "Collapsed item", getClientRects: () => []},
    {textContent: "Invisible item", visibility: "hidden", getClientRects: () => [{}]},
    {textContent: "   "},
    {textContent: "Error"},
    {textContent: " Visible   packing kit "},
  ];
  const page = doc({
    "[data-pl='product-title'] h1, h1[data-pl='product-title'], [class*='title--wrap--'] h1, h1": headings,
    h1: headings,
  });
  const window = {getComputedStyle: node => ({visibility: node.visibility || "visible"})};
  assert.equal(collect(page, window, url).product.title, "Visible packing kit");
  assert.equal(collect(doc({h1: headings.slice(0, -1)}), window, url).error, "product_not_loaded");
});

test("reads the visible current product price when page state is absent", () => {
  const title = {textContent: "Example packing kit", getClientRects: () => [{}]};
  const cartPrice = {textContent: "$9.99", getClientRects: () => [{}]};
  const hiddenPrice = {textContent: "$8.99", getClientRects: () => []};
  const currentPrice = {textContent: " $1.09 ", getClientRects: () => [{}]};
  const page = doc({
    "[data-pl='product-title'] h1, h1[data-pl='product-title'], [class*='title--wrap--'] h1, h1": [title],
    "[data-pl='product-title'] h1, h1[data-pl='product-title']": [title],
    "[class*='cart-product-price-text']": [cartPrice],
    ["[data-pl='product-price'] [class*='price'], [class*='price--currentPriceText--'], " +
      "[class*='price-default--currentWrap--'] [class*='price-default--current--']"]: [hiddenPrice, currentPrice],
  });
  const outcome = collect(page, {runParams: {}}, url);
  assert.equal(outcome.product.visible_price, "$1.09");
  assert.equal(outcome.product.currency, null);
  assert.deepEqual(outcome.product.variants, []);
});

test("reports repeated slider failures while retaining no verification URL or token", () => {
  const page = doc({".errloading, #nc_1__scale_text, #nocaptcha": {textContent: "验证失败，点击框体重试(error:r1VVt)"}});
  page.title = "验证码拦截";
  page.querySelectorAll = selector => selector === "a[href]" ? [{href:
    "https://www.aliexpress.com/_____tmd_____/page/feedback?rand=private-marker&x5secdata=private-marker&errorcode=r1VVt,r1VVt,r1VVt,r1VVt",
  }] : [];
  const outcome = collect(page, productPage("1005013209445272"),
    "https://www.aliexpress.com///_____tmd_____/punish?x5secdata=private-marker");
  assert.deepEqual(outcome, {ok: false, error: "verification_required", diagnostics: {
    state: "verification_failed", error_code: "r1VVt", retry_count: 4,
  }});
  assert.ok(!JSON.stringify(outcome).includes("private-marker"));
  assert.equal(outcome.product, undefined);
});

test("recognizes a visible challenge overlay before accepting loaded product state", () => {
  const selector = "#captchacharacters, #baxia-dialog-content, #nocaptcha, form[action*='validateCaptcha']";
  const outcome = collect(doc({[selector]: {hidden: false, getClientRects: () => [{}]}}),
    productPage("1005013209445272"), url);
  assert.equal(outcome.error, "verification_required");
  assert.equal(outcome.diagnostics.state, "verification_pending");
  assert.equal(outcome.diagnostics.error_code, null);
});

test("ignores a hidden leftover challenge on an accessible item page", () => {
  const selector = "#captchacharacters, #baxia-dialog-content, #nocaptcha, form[action*='validateCaptcha']";
  const outcome = collect(doc({[selector]: {hidden: false, getClientRects: () => []}}),
    productPage("1005013209445272"), url);
  assert.equal(outcome.ok, true);
});

test("does not confuse login with a CAPTCHA failure", () => {
  assert.equal(collect({...doc(), title: "Sign in - AliExpress"}, {}, url).error, "login_required");
});

test("ignores failure counters from unrelated feedback origins", () => {
  const page = {...doc(), title: "验证码拦截"};
  page.querySelectorAll = selector => selector === "a[href]" ? [{href:
    "https://example.com/_____tmd_____/page/feedback?errorcode=r1VVt,r1VVt",
  }] : [];
  assert.equal(collect(page, {}, url).diagnostics.retry_count, null);
});
