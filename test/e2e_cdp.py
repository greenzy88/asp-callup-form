"""BBTCA Call-Up app — staged E2E driver over Edge CDP (port 9222).

Drives the LIVE app (delightful-bay...azurestaticapps.net) through the real
UI so the real notification emails fire. Staged subcommands so each step can
be verified before the next:

    python test/e2e_cdp.py open                 # open/focus app tab, report auth state
    python test/e2e_cdp.py login                # click Sign In, drive the MSAL popup
    python test/e2e_cdp.py state                # auth/app state + visible order count
    python test/e2e_cdp.py upload <pdf-path>    # file-input upload, dump extracted fields
    python test/e2e_cdp.py setfield <ef_id> <value>   # tweak an extracted-form field
    python test/e2e_cdp.py submit               # click Submit (create) and report new order
    python test/e2e_cdp.py select <orderId>     # open an order's detail panel
    python test/e2e_cdp.py revise <orderId> <pdf-path>  # upload revised PDF flow
    python test/e2e_cdp.py editfield <orderId> <edit_id> <value>  # manual field edit + submit
    python test/e2e_cdp.py status <orderId> <Scheduled|Completed> [note]
    python test/e2e_cdp.py delete <orderId>     # admin delete (cleanup)
    python test/e2e_cdp.py eval "<js>"          # escape hatch

CDP only (no Playwright). Each command attaches fresh; tab is found by URL.
"""
from __future__ import annotations

import base64
import json
import sys
import time
import urllib.request

import websocket  # websocket-client

# Force UTF-8 stdout — button labels carry a ✓ (U+2713) and extracted fields
# carry é / en-dash / curly quotes; the default cp1252 console raised
# UnicodeEncodeError mid-command (PO1 revise, stress test 2026-06-16).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

CDP = "http://127.0.0.1:9222"
APP_HOST = "delightful-bay-0e217b31e.7.azurestaticapps.net"
APP_URL = f"https://{APP_HOST}/"


def _http(path: str, method: str = "GET"):
    req = urllib.request.Request(CDP + path, method=method)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


class Tab:
    def __init__(self, ws_url: str):
        self.ws = websocket.create_connection(ws_url, timeout=30)
        self._id = 0

    def cmd(self, method: str, **params):
        self._id += 1
        self.ws.send(json.dumps({"id": self._id, "method": method, "params": params}))
        deadline = time.time() + 30
        while time.time() < deadline:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self._id:
                if "error" in msg:
                    raise RuntimeError(f"CDP {method}: {msg['error']}")
                return msg.get("result", {})
        raise TimeoutError(method)

    def js(self, expr: str, await_promise: bool = True, user_gesture: bool = False):
        r = self.cmd("Runtime.evaluate", expression=expr,
                     awaitPromise=await_promise, returnByValue=True,
                     userGesture=user_gesture)
        if r.get("exceptionDetails"):
            raise RuntimeError(json.dumps(r["exceptionDetails"])[:500])
        return r.get("result", {}).get("value")

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def find_tab(host_substr: str):
    for t in _http("/json"):
        if t.get("type") == "page" and host_substr in (t.get("url") or ""):
            return t
    return None


def app_tab() -> Tab:
    t = find_tab(APP_HOST)
    if not t:
        t = _http(f"/json/new?{APP_URL}", method="PUT")
        time.sleep(4)
    tab = Tab(t["webSocketDebuggerUrl"])
    tab.cmd("Page.enable")
    tab.cmd("Runtime.enable")
    return tab


STATE_JS = """(() => {
  const vis = id => { const e = document.getElementById(id);
    return !!e && getComputedStyle(e).display !== 'none'; };
  return {
    url: location.href,
    authVisible: vis('authSection'),
    appVisible: vis('appContent'),
    extractedVisible: vis('extractedCard'),
    orders: (typeof orders !== 'undefined' && Array.isArray(orders))
      ? orders.map(o => ({ id: o.OrderID, status: o.Status, event: o.Event, v: o.Version }))
      : null,
    user: (typeof currentUserUpn !== 'undefined') ? currentUserUpn : null,
  };
})()"""


def cmd_open():
    tab = app_tab()
    print(json.dumps(tab.js(STATE_JS), indent=2))
    tab.close()


def cmd_state():
    cmd_open()


def cmd_login():
    tab = app_tab()
    st = tab.js(STATE_JS)
    if st["appVisible"]:
        print("already signed in as", st["user"])
        tab.close()
        return
    tab.js("loginPopup()", await_promise=False, user_gesture=True)
    print("clicked Sign In; waiting for MSAL popup target...")
    popup = None
    for _ in range(20):
        time.sleep(1.5)
        popup = find_tab("login.microsoftonline.com")
        if popup:
            break
    if popup:
        p = Tab(popup["webSocketDebuggerUrl"])
        p.cmd("Runtime.enable")
        # Account picker: the dramlagan tile is <div role=button
        # data-test-id="dramlagan@security-asp.com">. A JS .click() does NOT
        # trigger MSAL's handler — it needs a TRUSTED mouse event, so we
        # dispatch a real Input.dispatchMouseEvent at the tile's center.
        for _ in range(20):
            time.sleep(1.5)
            box = p.js("""(() => {
              const el = document.querySelector('[data-test-id="dramlagan@security-asp.com"]')
                      || [...document.querySelectorAll('[data-test-id]')].find(e =>
                           /security-asp\\.com/i.test(e.getAttribute('data-test-id')||''));
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return {x: r.left + r.width/2, y: r.top + r.height/2};
            })()""", await_promise=False)
            if box:
                for typ in ("mousePressed", "mouseReleased"):
                    p.cmd("Input.dispatchMouseEvent", type=typ, x=box["x"],
                          y=box["y"], button="left", clickCount=1, buttons=1)
                print("  popup: trusted-clicked dramlagan tile")
                break
            txt = p.js("document.body ? document.body.innerText.slice(0,160) : ''",
                       await_promise=False)
            print("  popup waiting:", (txt or "").replace("\n", " | ")[:120])
        p.close()
    # wait for app to land signed-in
    for _ in range(30):
        time.sleep(2)
        st = tab.js(STATE_JS)
        if st["appVisible"]:
            print("SIGNED IN as", st["user"], "| orders:",
                  len(st["orders"] or []))
            tab.close()
            return
    print("login did not complete; state:", json.dumps(st))
    tab.close()


def cmd_upload(pdf_path: str):
    tab = app_tab()
    # find the file input node and set files on it
    doc = tab.cmd("DOM.getDocument")
    node = tab.cmd("DOM.querySelector", nodeId=doc["root"]["nodeId"],
                   selector="#pdfInput")
    tab.cmd("DOM.setFileInputFiles", files=[pdf_path], nodeId=node["nodeId"])
    print("file set; waiting for extraction...")
    for _ in range(30):
        time.sleep(1)
        st = tab.js(STATE_JS)
        if st["extractedVisible"]:
            break
    fields = tab.js("""(() => {
      const ids = ['ef_event','ef_startDate','ef_endDate','ef_startTime','ef_endTime',
                   'ef_numGuards','ef_meetingLocation','ef_siteContact','ef_contactNumber',
                   'ef_days','ef_coverage','ef_ppe','ef_duties'];
      const out = {};
      for (const id of ids) { const e = document.getElementById(id); out[id] = e ? e.value : null; }
      return out;
    })()""")
    print(json.dumps(fields, indent=2))
    tab.close()


def cmd_setfield(field_id: str, value: str):
    tab = app_tab()
    ok = tab.js(f"""(() => {{
      const e = document.getElementById({json.dumps(field_id)});
      if (!e) return 'NO SUCH FIELD';
      e.value = {json.dumps(value)};
      return 'set ' + {json.dumps(field_id)} + ' = ' + e.value;
    }})()""")
    print(ok)
    tab.close()


def cmd_submit():
    tab = app_tab()
    before = tab.js("(typeof orders!=='undefined' && orders) ? orders.map(o=>o.OrderID) : []")
    tab.js("confirmExtracted()", await_promise=False)
    print("submitted; waiting for order list to grow + emails to send...")
    for _ in range(45):
        time.sleep(2)
        st = tab.js(STATE_JS)
        ids = [o["id"] for o in (st["orders"] or [])]
        new = [i for i in ids if i not in (before or [])]
        if new:
            print("NEW ORDER:", new, "| total:", len(ids))
            tab.close()
            return
    print("no new order detected; state:", json.dumps(tab.js(STATE_JS)))
    tab.close()


def cmd_select(order_id: str):
    tab = app_tab()
    tab.js(f"selectOrder({json.dumps(order_id)})", await_promise=False)
    time.sleep(2)
    detail = tab.js("""(() => {
      const d = document.getElementById('detailFields');
      return d ? d.innerText.slice(0, 1500) : 'no detail panel';
    })()""")
    print(detail)
    tab.close()


def cmd_revise(order_id: str, pdf_path: str):
    tab = app_tab()
    tab.js(f"selectOrder({json.dumps(order_id)})", await_promise=False)
    time.sleep(2)
    tab.js("startReviseUpload()", await_promise=False)
    time.sleep(1)
    doc = tab.cmd("DOM.getDocument")
    node = tab.cmd("DOM.querySelector", nodeId=doc["root"]["nodeId"],
                   selector="#pdfInput")
    tab.cmd("DOM.setFileInputFiles", files=[pdf_path], nodeId=node["nodeId"])
    print("revision file set; waiting for extraction card...")
    for _ in range(30):
        time.sleep(1)
        if tab.js(STATE_JS)["extractedVisible"]:
            break
    btn = tab.js("document.getElementById('confirmExtractedBtn').innerText")
    print("button label:", btn)
    tab.close()


def cmd_editfield(order_id: str, edit_id: str, value: str):
    tab = app_tab()
    tab.js(f"selectOrder({json.dumps(order_id)})", await_promise=False)
    time.sleep(2)
    tab.js("editFields()", await_promise=False)  # was toggleEditFields() — never existed
    time.sleep(1)
    r = tab.js(f"""(() => {{
      const e = document.getElementById({json.dumps(edit_id)});
      if (!e) return 'NO SUCH EDIT FIELD';
      e.value = {json.dumps(value)};
      return 'set';
    }})()""")
    print(r)
    if r == "set":
        tab.js("saveFieldChanges()", await_promise=False)
        print("saving + emailing...")
        time.sleep(12)
    tab.close()


def cmd_status(order_id: str, new_status: str, note: str = ""):
    tab = app_tab()
    tab.js(f"selectOrder({json.dumps(order_id)})", await_promise=False)
    time.sleep(2)
    tab.js(f"""(() => {{
      document.getElementById('newStatus').value = {json.dumps(new_status)};
      document.getElementById('newNote').value = {json.dumps(note)};
    }})()""")
    tab.js("updateStatus()", await_promise=False)
    print(f"status -> {new_status}; waiting for save + email...")
    time.sleep(14)
    st = tab.js(STATE_JS)
    me = [o for o in (st["orders"] or []) if o["id"] == order_id]
    print("order now:", me)
    tab.close()


def cmd_delete(order_id: str):
    tab = app_tab()
    tab.js(f"""apiJson('/orders/' + encodeURIComponent({json.dumps(order_id)}), {{ method: 'DELETE' }})
      .then(r => window._delResult = JSON.stringify(r))
      .catch(e => window._delResult = 'ERR ' + e.message)""", await_promise=False)
    time.sleep(5)
    print(tab.js("window._delResult || 'pending'"))
    tab.js("loadDataFromExcel()", await_promise=False)
    tab.close()


def cmd_eval(expr: str):
    tab = app_tab()
    print(json.dumps(tab.js(expr), indent=2, default=str))
    tab.close()


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "state"
    args = sys.argv[2:]
    {
        "open": cmd_open, "state": cmd_state, "login": cmd_login,
        "upload": cmd_upload, "setfield": cmd_setfield, "submit": cmd_submit,
        "select": cmd_select, "revise": cmd_revise, "editfield": cmd_editfield,
        "status": cmd_status, "delete": cmd_delete, "eval": cmd_eval,
    }[cmd](*args)
