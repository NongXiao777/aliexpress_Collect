function collectAliExpressProduct(doc = document, page = window, address = location.href) {
  const fail = (error, diagnostics) => ({ok: false, error, ...(diagnostics ? {diagnostics} : {})});
  let source;
  try {
    source = new URL(address);
  } catch {
    return fail("unsupported_page");
  }
  const domain = /^(?:(?:www|m)\.)?aliexpress\.com$/i.test(source.hostname);
  const itemId = source.pathname.match(/^\/(?:item|i)\/(\d{10,24})\.html\/?$/i)?.[1];
  if (source.protocol !== "https:" || !domain) return fail("unsupported_page");

  const clean = (value, limit = 1000) => typeof value === "string" ?
    value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
  const children = value => Array.isArray(value) ? value : [];
  const element = selectors => doc.querySelector(selectors);
  const meta = name => clean(element(`meta[property="${name}"]`)?.content, 2000);
  const challenge = element("#captchacharacters, #baxia-dialog-content, #nocaptcha, form[action*='validateCaptcha']");
  const challengeVisible = challenge && !challenge.hidden &&
    (typeof challenge.getClientRects !== "function" || challenge.getClientRects().length > 0);
  if (source.pathname.includes("/_____tmd_____/punish") || challengeVisible ||
      /^(security verification|robot check|access denied)\b|验证码拦截|安全验证/i.test(doc.title || "")) {
    const message = clean(element(".errloading, #nc_1__scale_text, #nocaptcha")?.textContent, 500);
    const errorCode = message.match(/error\s*:\s*([a-z0-9_-]{1,32})(?=[\s)]|$)/i)?.[1] || null;
    let retryCount = null;
    for (const link of Array.from(doc.querySelectorAll("a[href]")).slice(0, 100)) {
      try {
        const feedback = new URL(link.href, source);
        if (feedback.origin !== source.origin || !feedback.pathname.includes("/_____tmd_____/page/feedback")) continue;
        const codes = (feedback.searchParams.get("errorcode") || "").split(",")
          .filter(code => /^[a-z0-9_-]{1,32}$/i.test(code));
        if (codes.length) retryCount = Math.min(codes.length, 100);
      } catch {
        // Feedback links are optional; only their public failure count is retained.
      }
    }
    return fail("verification_required", {
      state: errorCode || /验证失败|verification failed|请点我重试/i.test(message) ?
        "verification_failed" : "verification_pending",
      error_code: errorCode,
      retry_count: retryCount,
    });
  }
  if (/^sign in\b/i.test(doc.title || "")) return fail("login_required");
  if (!itemId) return fail("unsupported_page");

  const imageLink = value => {
    if (typeof value !== "string" || !value) return null;
    try {
      const url = new URL(value, source);
      if (url.protocol !== "https:" || url.username || url.password ||
          ![".alicdn.com", ".aliexpress-media.com"].some(suffix => url.hostname.endsWith(suffix))) {
        return null;
      }
      return url.origin + url.pathname;
    } catch {
      return null;
    }
  };

  const getProduct = input => {
    const candidates = [input?.data?.result, input?.result, input?.data, input];
    return candidates.find(item => String(item?.GLOBAL_DATA?.globalData?.productId ?? "") === itemId &&
      clean(item?.PRODUCT_TITLE?.text));
  };
  const structured = [page.runParams, page.__INIT_DATA__, page.__INITIAL_STATE__]
    .map(getProduct).find(Boolean);

  let schema = null;
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    if (script.textContent.length > 500_000) continue;
    try {
      const value = JSON.parse(script.textContent);
      const candidates = [value, ...children(value), ...children(value?.["@graph"])];
      schema = candidates.find(item => {
        const types = Array.isArray(item?.["@type"]) ? item["@type"] : [item?.["@type"]];
        if (!types.includes("Product") || !clean(item.name)) return false;
        if (typeof item.url === "string") {
          const url = new URL(item.url, source);
          return (url.hostname === "aliexpress.com" || url.hostname.endsWith(".aliexpress.com")) &&
            url.pathname.includes(`/${itemId}.html`);
        }
        return String(item.sku ?? item.productID ?? "") === itemId;
      });
      if (schema) break;
    } catch {
      // A malformed metadata block does not prevent DOM collection.
    }
  }

  const genericTitle = /^(aliexpress|oops!?|page not found|sorry|error|sign in)$/i;
  const visible = node => {
    if (node.hidden || (typeof node.getClientRects === "function" && !node.getClientRects().length)) return false;
    const style = typeof page.getComputedStyle === "function" ? page.getComputedStyle(node) : null;
    return style?.display !== "none" && style?.visibility !== "hidden" && style?.visibility !== "collapse";
  };
  let elementTitle = "";
  for (const selector of [
    "[data-pl='product-title'] h1, h1[data-pl='product-title']",
    "[class*='title--wrap--'] h1",
    "h1",
  ]) {
    elementTitle = Array.from(doc.querySelectorAll(selector)).filter(visible)
      .map(node => clean(node.textContent)).find(text => text && !genericTitle.test(text)) || "";
    if (elementTitle) break;
  }
  const title = clean(structured?.PRODUCT_TITLE?.text) || clean(schema?.name) || elementTitle;
  if (!title || genericTitle.test(title)) {
    return fail("product_not_loaded");
  }

  const rawImages = [
    ...children(structured?.HEADER_IMAGE_PC?.imagePathList),
    ...children(schema?.image),
    ...(typeof schema?.image === "string" ? [schema.image] : []),
    meta("og:image"),
    ...Array.from(doc.querySelectorAll(
      "#image-viewer img, [data-pl='product-image'] img, [class*='slider--img--'] img, img[class*='magnifier--image--']",
    )).slice(0, 40).map(image => image.currentSrc || image.src),
  ];
  const images = [...new Set(rawImages.map(imageLink).filter(Boolean))].slice(0, 40);

  const specs = new Map();
  const addSpec = (name, value) => {
    const field = clean(name, 120);
    const contents = clean(value, 400);
    if (field && contents && specs.size < 40 && !specs.has(field)) specs.set(field, contents);
  };
  for (const prop of children(structured?.PRODUCT_PROP_PC?.showedProps)) {
    addSpec(prop?.attrName, prop?.attrValue);
  }
  for (const prop of Array.from(doc.querySelectorAll("[class*='specification--prop--'], #nav-specification tr")).slice(0, 60)) {
    const nodes = prop.querySelectorAll("th,td,span");
    if (nodes.length === 2) addSpec(nodes[0].textContent, nodes[1].textContent);
  }

  const options = new Map();
  for (const group of children(structured?.SKU?.skuProperties)) {
    for (const option of children(group?.skuPropertyValues)) {
      const key = `${group.skuPropertyId}:${option.propertyValueIdLong}`;
      options.set(key, {
        name: clean(group.skuPropertyName),
        value: clean(option.propertyValueDisplayName) || clean(option.propertyValueName),
        image: imageLink(option.skuPropertyImagePath),
      });
    }
  }

  const market = structured?.GLOBAL_DATA?.globalData;
  const currency = clean(market?.currencyCode || schema?.offers?.priceCurrency, 8);
  const priceMap = structured?.PRICE?.skuIdStrPriceInfoMap || structured?.PRICE?.skuPriceInfoMap || {};
  const variants = [];
  const variantIds = new Set();
  for (const variant of children(structured?.SKU?.skuPaths).slice(0, 500)) {
    const sku = String(variant?.skuIdStr || variant?.skuId || "");
    if (!/^\d{1,24}$/.test(sku) || variantIds.has(sku)) continue;
    variantIds.add(sku);
    const path = clean(variant.path || variant.skuAttr);
    const offer = priceMap[sku];
    variants.push({
      source_sku_id: sku,
      options: path.split(";").map(part => options.get(part.split("#")[0])).filter(Boolean),
      visible_price: clean(offer?.salePriceString, 100) || null,
      currency: clean(offer?.originalPrice?.currency, 8) || currency || null,
      stock_shown: Number.isInteger(variant.skuStock) && variant.skuStock >= 0 ? variant.skuStock : null,
    });
  }

  const visiblePrice = Array.from(doc.querySelectorAll(
    "[data-pl='product-price'] [class*='price'], [class*='price--currentPriceText--'], " +
      "[class*='price-default--currentWrap--'] [class*='price-default--current--']",
  )).find(node => visible(node) && clean(node.textContent, 100));
  const description = element("#product-description, [data-pl='product-description']");
  return {ok: true, product: {
    source: "aliexpress",
    source_product_id: itemId,
    source_url: `https://www.aliexpress.com/item/${itemId}.html`,
    captured_at: new Date().toISOString(),
    title,
    store: clean(structured?.SHOP_CARD_PC?.storeName || market?.storeName, 300) || null,
    images,
    specifications: [...specs].map(([name, value]) => ({name, value})),
    variants,
    visible_price: clean(structured?.PRICE?.targetSkuPriceInfo?.salePriceString || visiblePrice?.textContent, 100) || null,
    currency: currency || null,
    description: clean(schema?.description || description?.innerText, 8000) || null,
  }};
}

if (typeof module === "object") module.exports = collectAliExpressProduct;
