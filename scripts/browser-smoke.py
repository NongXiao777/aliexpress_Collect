#!/usr/bin/env python3
"""Check the collector on an existing product tab without managing Chrome.

Requires Python 3.9+ and Node.js 22+ on PATH. Example:
  python scripts/browser-smoke.py --endpoint http://127.0.0.1:9222 --item-id 1005013209445272

Exit codes: 0 passed, 2 pending (verification or product page unavailable), 1 failed.
The test attaches, reads, and disconnects. It never opens, navigates, or closes tabs.
"""

import argparse
import ipaddress
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit


CLIENT = r"""
import fs from 'node:fs';
const config = JSON.parse(fs.readFileSync(0, 'utf8'));
const timeout = config.timeout * 1000;
let socket;
let sessionId;
let sequence = 0;
const waiting = new Map();

function pending(reason) {
  return {status: 'pending', reason, source_product_id: config.itemId};
}

function address(target) {
  try { return new URL(target.url); } catch { return null; }
}

function ali(url) {
  return url?.protocol === 'https:' && /^(?:(?:www|m)\.)?aliexpress\.com$/i.test(url.hostname);
}

function item(url) {
  return ali(url) ? url.pathname.match(/^\/(?:item|i)\/(\d{10,24})\.html\/?$/i)?.[1] : null;
}

function challenge(url) {
  return ali(url) && url.pathname.includes('/_____tmd_____/punish');
}

function command(method, params = {}, attachedSession) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`CDP command timed out: ${method}`));
    }, timeout);
    waiting.set(id, {resolve, reject, timer});
    socket.send(JSON.stringify({id, method, params, ...(attachedSession ? {sessionId: attachedSession} : {})}));
  });
}

async function evaluate(expression) {
  const reply = await command('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout,
  }, sessionId);
  if (reply.exceptionDetails) throw new Error('Page evaluation failed');
  return reply.result.value;
}

async function run() {
  if (typeof WebSocket !== 'function') throw new Error('Node.js 22+ is required');
  const endpoint = new URL(config.endpoint);
  const response = await fetch(new URL('/json/version', endpoint), {
    redirect: 'error', signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`CDP endpoint returned HTTP ${response.status}`);
  const version = await response.json();
  const ws = new URL(version.webSocketDebuggerUrl);
  if (ws.protocol !== 'ws:' || ws.hostname !== endpoint.hostname || ws.port !== endpoint.port ||
      ws.username || ws.password || !ws.pathname.startsWith('/devtools/browser/')) {
    throw new Error('CDP WebSocket does not belong to the supplied loopback endpoint');
  }
  socket = new WebSocket(ws);
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = waiting.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    waiting.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of waiting.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('CDP connection closed'));
    }
    waiting.clear();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connection timed out')), timeout);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once: true});
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, {once: true});
  });

  const pages = (await command('Target.getTargets')).targetInfos.filter(target => target.type === 'page');
  const matches = pages.filter(target => item(address(target)) === config.itemId);
  if (matches.length === 0) {
    // A redirect can remove the item ID. Detect it from target metadata without inspecting another tab.
    return pending(pages.some(target => challenge(address(target))) ? 'verification_required' : 'matching_product_tab_missing');
  }
  if (matches.length !== 1) return pending('multiple_matching_product_tabs');
  const target = matches[0];
  sessionId = (await command('Target.attachToTarget', {targetId: target.targetId, flatten: true})).sessionId;
  const state = await evaluate(`(() => {
    const visible = selector => [...document.querySelectorAll(selector)].some(node =>
      node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
    return {
      url: location.href,
      verification: location.pathname.includes('/_____tmd_____/punish') ||
        /security verification|robot check|access denied|验证码拦截|安全验证/i.test(document.title) ||
        visible('#baxia-dialog-content, #captchacharacters, #nocaptcha, #nc_1_wrapper, .nc-container, form[action*="validateCaptcha"]'),
    };
  })()`);
  if (state.verification) return pending('verification_required');
  if (item(new URL(state.url)) !== config.itemId) return pending('product_tab_changed');

  const result = await evaluate(`(() => { ${config.collector}\n return collectAliExpressProduct(); })()`);
  if (!result?.ok) {
    if (['verification_required', 'login_required', 'product_not_loaded', 'unsupported_page'].includes(result?.error)) {
      return pending(result.error);
    }
    throw new Error('Collector returned an unexpected result');
  }
  const product = JSON.parse(JSON.stringify(result.product));
  if (product.source !== 'aliexpress' || product.source_product_id !== config.itemId ||
      product.source_url !== `https://www.aliexpress.com/item/${config.itemId}.html` ||
      typeof product.title !== 'string' || !product.title.trim() ||
      !Array.isArray(product.images) || !Array.isArray(product.variants)) {
    throw new Error('Collected product failed validation');
  }
  const after = (await command('Target.getTargets')).targetInfos.filter(page => page.type === 'page');
  const beforeTabs = new Map(pages.map(page => [page.targetId, page.url]));
  const unchanged = after.length === pages.length && after.every(page => beforeTabs.get(page.targetId) === page.url);
  return {
    status: 'passed', source_product_id: product.source_product_id,
    title: product.title, images: product.images.length, variants: product.variants.length,
    json_serialization: 'passed', tabs_unchanged: unchanged,
  };
}

let result;
try {
  result = await run();
} catch (error) {
  result = {status: 'failed', reason: error.message};
} finally {
  if (sessionId && socket?.readyState === WebSocket.OPEN) {
    try { await command('Target.detachFromTarget', {sessionId}); } catch {}
  }
  // Closing this client socket disconnects the debugger. Chrome belongs to its existing owner.
  if (socket) socket.close();
}
console.log(JSON.stringify(result));
process.exitCode = result.status === 'passed' ? 0 : result.status === 'pending' ? 2 : 1;
"""


def loopback_endpoint(value):
    url = urlsplit(value)
    host = url.hostname
    if host == "localhost":
        host = "127.0.0.1"
    try:
        local = ipaddress.ip_address(host).is_loopback
        port = url.port
    except (ValueError, TypeError):
        local, port = False, None
    if (url.scheme != "http" or not local or not port or url.username or url.password
            or url.path not in ("", "/") or url.query or url.fragment):
        raise argparse.ArgumentTypeError("Use an explicit HTTP loopback CDP address such as http://127.0.0.1:9222")
    authority = f"[{host}]" if ":" in host else host
    return f"http://{authority}:{port}"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--endpoint", required=True, type=loopback_endpoint)
    parser.add_argument("--item-id", required=True, help="Exact AliExpress source item ID already open in Chrome")
    parser.add_argument("--node", default="node", help="Node.js 22+ executable (default: node on PATH)")
    parser.add_argument("--timeout", type=int, default=8, help="CDP request timeout in seconds, 1-15 (default: 8)")
    args = parser.parse_args()
    if not re.fullmatch(r"\d{10,24}", args.item_id):
        parser.error("--item-id must contain 10-24 digits")
    if not 1 <= args.timeout <= 15:
        parser.error("--timeout must be between 1 and 15 seconds")
    config = {
        "endpoint": args.endpoint, "itemId": args.item_id, "timeout": args.timeout,
        "collector": (Path(__file__).resolve().parents[1] / "extension" / "collector.js").read_text(encoding="utf-8"),
    }
    try:
        # This child is a CDP client only. It has no browser executable or launch command.
        completed = subprocess.run([args.node, "--input-type=module", "-e", CLIENT],
                                   input=json.dumps(config), text=True, encoding="utf-8",
                                   capture_output=True, timeout=args.timeout * 9 + 5)
        result = json.loads(completed.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError) as error:
        result = {"status": "failed", "reason": f"CDP client failed: {type(error).__name__}"}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] == "passed" else 2 if result["status"] == "pending" else 1


if __name__ == "__main__":
    raise SystemExit(main())
