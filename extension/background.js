importScripts("collector.js");

// Called from this extension's service worker through the existing Chrome
// debugging connection. This entry point only reads one matched product tab.
(() => {
  const hosts = [
    "https://www.aliexpress.com/*",
    "https://m.aliexpress.com/*",
    "https://aliexpress.com/*",
  ];
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const fail = (error, diagnostics) => ({ok: false, error,
    ...(diagnostics && object(diagnostics) ? {diagnostics} : {})});
  const item = address => {
    if (typeof address !== "string" || address.length > 4000) return null;
    let url;
    try { url = new URL(address); } catch { return null; }
    const id = url.pathname.match(/^\/(?:item|i)\/(\d{10,24})\.html\/?$/i)?.[1];
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !/^(?:(?:www|m)\.)?aliexpress\.com$/i.test(url.hostname) || !id) return null;
    return {id, url};
  };
  const tabId = value => Number.isSafeInteger(value) && value > 0;

  globalThis.zyingAliExpressCollect = async request => {
    if (!object(request) || Object.keys(request).some(key =>
      !["source_product_id", "target_url", "tab_id"].includes(key))) return fail("invalid_request");
    const id = request.source_product_id;
    if (typeof id !== "string" || !/^\d{10,24}$/.test(id)) return fail("invalid_source_product_id");
    if (own(request, "target_url")) {
      const target = item(request.target_url);
      if (!target || target.url.search || target.url.hash) return fail("invalid_target_url");
      if (target.id !== id) return fail("source_item_mismatch");
    }
    if (own(request, "tab_id") && !tabId(request.tab_id)) return fail("invalid_tab_id");
    const browser = globalThis.chrome;
    if (typeof browser?.tabs?.get !== "function" ||
      typeof browser?.scripting?.executeScript !== "function") return fail("browser_api_unavailable");
    if (typeof collectAliExpressProduct !== "function") return fail("collector_unavailable");

    let selectedId = request.tab_id;
    if (!own(request, "tab_id")) {
      if (typeof browser.tabs.query !== "function") return fail("browser_tabs_unavailable");
      let tabs;
      try { tabs = await browser.tabs.query({url: hosts}); }
      catch { return fail("browser_tabs_unavailable"); }
      if (!Array.isArray(tabs)) return fail("browser_tabs_unavailable");
      const matched = tabs.filter(tab => tabId(tab?.id) && item(tab.url)?.id === id);
      const active = matched.filter(tab => tab.active === true);
      if (active.length === 1) selectedId = active[0].id;
      else if (matched.length === 1) selectedId = matched[0].id;
      else return fail(matched.length ? "ambiguous_source_tabs" : "source_tab_not_found");
    }

    let before;
    try { before = await browser.tabs.get(selectedId); }
    catch { return fail("source_tab_unavailable"); }
    const beforeItem = item(before?.url);
    if (before?.id !== selectedId || beforeItem?.id !== id) return fail("source_tab_mismatch");

    let frames;
    try {
      frames = await browser.scripting.executeScript({
        target: {tabId: selectedId}, world: "MAIN", func: collectAliExpressProduct,
      });
    } catch { return fail("browser_injection_failed"); }

    let after;
    try { after = await browser.tabs.get(selectedId); }
    catch { return fail("source_tab_unavailable"); }
    const afterItem = item(after?.url);
    if (after?.id !== selectedId || afterItem?.id !== id ||
      afterItem.url.href !== beforeItem.url.href) return fail("page_navigation_during_collection");
    if (!Array.isArray(frames) || frames.length !== 1 || !object(frames[0]?.result)) {
      return fail("collector_result_unavailable");
    }
    const result = frames[0].result;
    if (result.ok !== true) {
      const error = typeof result.error === "string" && /^[a-z0-9_]{1,80}$/.test(result.error) ?
        result.error : "collector_failed";
      return fail(error, result.diagnostics);
    }
    const product = result.product, source = item(product?.source_url);
    if (!object(product) || product.source !== "aliexpress" || product.source_product_id !== id ||
      source?.id !== id || source.url.search || source.url.hash) return fail("collector_source_mismatch");

    let manifest;
    try { manifest = browser.runtime.getManifest(); }
    catch { return fail("extension_metadata_unavailable"); }
    if (typeof browser.runtime?.id !== "string" || !browser.runtime.id ||
      typeof manifest?.name !== "string" || typeof manifest?.version !== "string") {
      return fail("extension_metadata_unavailable");
    }
    return {ok: true, product, collector_origin: "extension_service_worker",
      extension: {id: browser.runtime.id, name: manifest.name, version: manifest.version}};
  };
})();
