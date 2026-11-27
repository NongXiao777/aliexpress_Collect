const assert = require("node:assert/strict");
const test = require("node:test");
const collect = require("../extension/collector.js");

const url = "https://www.aliexpress.com/item/1005013209445272.html?spm=tracking";
const doc = features => ({
  title: "Example item",
  querySelector: selectors => features?.[selectors] || null,
  querySelectorAll: () => [],
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
  const heading = "[data-pl='product-title'] h1, h1[data-pl='product-title'], [class*='title--wrap--'] h1, h1";
  const outcome = collect(doc({[heading]: {textContent: "  An item    visible here  "}}), {}, url);
  assert.equal(outcome.product.title, "An item visible here");
  assert.deepEqual(outcome.product.variants, []);
});
