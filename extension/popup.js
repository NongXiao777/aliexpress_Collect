const statusNode = document.querySelector("#status");
const panel = document.querySelector("#product");
const retry = document.querySelector("#retry");
const messages = {
  unsupported_page: "请打开一个速卖通商品详情页。",
  verification_required: "请先在速卖通页面完成验证，再重新读取。",
  product_not_loaded: "商品详情还没有加载，请稍后重新读取。",
};
let current = null;

async function inspectPage() {
  current = null;
  panel.hidden = true;
  retry.hidden = true;
  statusNode.textContent = "正在读取当前页面…";
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.id || !/^https:\/\/(?:(?:www|m)\.)?aliexpress\.com\//i.test(tab.url || "")) {
      statusNode.textContent = messages.unsupported_page;
      return;
    }
    const [{result}] = await chrome.scripting.executeScript({
      target: {tabId: tab.id},
      world: "MAIN",
      func: collectAliExpressProduct,
    });
    if (!result?.ok) {
      statusNode.textContent = messages[result?.error] || "当前标签页无法读取。";
      return;
    }
    current = result.product;
    document.querySelector("#product-title").textContent = current.title;
    document.querySelector("#product-id").textContent = current.source_product_id;
    document.querySelector("#price").textContent = current.visible_price || "未读取";
    document.querySelector("#images").textContent = String(current.images.length);
    document.querySelector("#variants").textContent = current.variants.length ? String(current.variants.length) : "未读取";
    panel.hidden = false;
    statusNode.textContent = "已读取当前商品";
  } catch {
    statusNode.textContent = "Chrome 未能读取当前标签页，请切回商品页后重试。";
  } finally {
    retry.hidden = current !== null;
  }
}

document.querySelector("#copy-link").addEventListener("click", async () => {
  if (!current) return;
  try {
    await navigator.clipboard.writeText(current.source_url);
    statusNode.textContent = "已复制商品链接";
  } catch {
    statusNode.textContent = "复制失败，可先导出 JSON 获取商品链接。";
  }
});

document.querySelector("#export").addEventListener("click", () => {
  if (!current) return;
  const contents = JSON.stringify(current, null, 2) + "\n";
  const url = URL.createObjectURL(new Blob([contents], {type: "application/json"}));
  const download = document.createElement("a");
  download.href = url;
  download.download = `aliexpress-${current.source_product_id}.json`;
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  statusNode.textContent = "已发起 JSON 下载";
});

retry.addEventListener("click", inspectPage);
inspectPage();
