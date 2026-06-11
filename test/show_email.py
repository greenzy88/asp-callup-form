"""Find a notification email in Outlook by subject substring and render its
HTML body to readable text (bullets preserved, highlighted rows marked).
Polls up to ~90s for it to arrive/sync.

Usage: python test/show_email.py "<subject substring>"
"""
import re
import sys
import time

import win32com.client


def render(html: str) -> str:
    b = html or ""
    b = re.sub(r"<style[\s\S]*?</style>", "", b, flags=re.I)
    # mark highlighted rows (bgcolor=#fff3cd) so we can see what's flagged changed
    b = re.sub(r'<tr[^>]*bgcolor="#fff3cd"[^>]*>', "\n[HILITE] ", b, flags=re.I)
    b = re.sub(r"<tr[^>]*>", "\n", b, flags=re.I)
    b = re.sub(r"<li[^>]*>", "\n    - ", b, flags=re.I)
    b = re.sub(r"</p>|<br\s*/?>|</h2>|</td>", "\n", b, flags=re.I)
    b = re.sub(r"<[^>]+>", "", b)
    b = (b.replace("&nbsp;", " ").replace("&amp;", "&").replace("&#39;", "'")
         .replace("&quot;", '"').replace("&ndash;", "-").replace("&mdash;", "-")
         .replace("&#10003;", "OK"))
    b = re.sub(r"[ \t]+", " ", b)
    b = re.sub(r"\n[ \t]+", "\n", b)
    b = re.sub(r"\n{2,}", "\n", b)
    return b.strip()


def main():
    needle = sys.argv[1]
    ol = win32com.client.Dispatch("Outlook.Application").GetNamespace("MAPI")
    inbox = ol.GetDefaultFolder(6)
    for attempt in range(18):
        items = inbox.Items
        items.Sort("[ReceivedTime]", True)
        n = 0
        for m in items:
            n += 1
            if n > 25:
                break
            try:
                subj = m.Subject or ""
            except Exception:
                continue
            if needle in subj:
                print("SUBJECT:", subj)
                print("RECEIVED:", str(m.ReceivedTime)[:19])
                print("ATTACHMENTS:", [a.FileName for a in m.Attachments])
                print("=" * 66)
                print(render(m.HTMLBody))
                return
        time.sleep(5)
    print(f"NOT FOUND after polling: {needle!r}")


if __name__ == "__main__":
    main()
