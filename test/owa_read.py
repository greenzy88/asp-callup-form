"""Read a BBTCA notification email from the already-authenticated OWA web tab
over CDP — avoids the High->Medium Outlook COM integrity wall entirely.

Usage: python test/owa_read.py "<subject substring>"

Strategy: navigate to the inbox, find the message-list span whose text contains
the subject substring, then click up the ancestor chain until the reading-pane
header actually shows that subject (click-and-verify — OWA list rows have no
single stable role, and its search box is React-controlled so synthetic Enter
does not fire). Only then is the body trusted and printed.
"""
import json
import sys
import time
import urllib.request

import websocket

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HTTP = "http://127.0.0.1:9222/json"


def tabs():
    return json.load(urllib.request.urlopen(HTTP, timeout=8))


def find(sub):
    for t in tabs():
        if t.get("type") == "page" and sub in (t.get("url") or ""):
            return t
    return None


class Conn:
    def __init__(s, url):
        s.ws = websocket.create_connection(url, timeout=30)
        s._i = 0

    def call(s, m, t=20, **p):
        s._i += 1
        mid = s._i
        s.ws.send(json.dumps({"id": mid, "method": m, "params": p}))
        end = time.time() + t
        while time.time() < end:
            s.ws.settimeout(max(0.1, end - time.time()))
            try:
                x = json.loads(s.ws.recv())
            except Exception:
                return None
            if x.get("id") == mid:
                return x.get("result", {})
        return None

    def js(s, e, t=12):
        return (s.call("Runtime.evaluate", t=t, expression=e,
                       returnByValue=True) or {}).get("result", {}).get("value")


HDR_JS = r"""(() => {
  const h=[...document.querySelectorAll('[role="heading"],h1,span')]
      .map(e=>e.textContent).find(t=>t&&t.includes('Call Up Request'));
  return h||'';
})()"""

BODY_JS = r"""(() => {
  let el = document.querySelector('div[role="document"]')
        || document.querySelector('[id^="UniqueMessageBody"]')
        || document.querySelector('[aria-label="Message body"]');
  if (!el) { const ifr=document.querySelector('iframe');
    if(ifr&&ifr.contentDocument&&ifr.contentDocument.body) el=ifr.contentDocument.body; }
  if (!el) return 'NO BODY ELEMENT';
  return (el.innerText||'').slice(0, 4000);
})()"""


def main():
    needle = sys.argv[1]
    ot = find("outlook")
    if not ot:
        print("NO OWA TAB"); return
    o = Conn(ot["webSocketDebuggerUrl"])
    o.call("Page.enable"); o.call("Runtime.enable")
    o.call("Page.navigate", url="https://outlook.cloud.microsoft/mail/0/")
    time.sleep(9)
    # wait for the subject to appear in the list (delivery/sync), up to ~90s
    present = False
    for _ in range(10):
        present = o.js(r"""(() => {
          const n=%s;
          return [...document.querySelectorAll('span,div')].some(
            e => (e.textContent||'').includes(n) && (e.textContent||'').length < 90);
        })()""" % json.dumps(needle), t=10)
        if present:
            break
        time.sleep(9)
    if not present:
        print("NOT IN INBOX after ~90s:", needle); return
    # click-and-verify: click span, then walk ancestors until header matches
    matched = False
    for depth in range(9):
        o.js(r"""(() => {
          const n=%s, depth=%d;
          const sp=[...document.querySelectorAll('span,div')].find(
            e => (e.textContent||'').includes(n) && (e.textContent||'').length < 90);
          if(!sp) return 'no span';
          let el=sp; for(let i=0;i<depth&&el.parentElement;i++) el=el.parentElement;
          el.scrollIntoView(); el.click();
          return 'clicked@'+depth;
        })()""" % (json.dumps(needle), depth), t=10)
        time.sleep(2.5)
        hdr = o.js(HDR_JS, t=8) or ""
        if needle in hdr:
            matched = True
            break
    hdr = o.js(HDR_JS, t=8) or ""
    body = o.js(BODY_JS, t=12)
    print("MATCH:", matched, "| depth used")
    print("HEADER:", hdr[:120])
    print("=" * 66)
    print(body)


if __name__ == "__main__":
    main()
