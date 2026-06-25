"""Medium-integrity Outlook email reader for the BBTCA stress test.

The Claude Code shell runs HIGH integrity; David's Outlook runs MEDIUM, so a
direct win32com Dispatch from the elevated shell fails with -2147221021
"Operation unavailable" (documented 2026-06-22). This script is meant to be
launched at MEDIUM integrity via:

    runas /trustlevel:0x20000 "<python.exe> <this file>"

It reads the subject substring to search for from test/_email_req.txt, polls
the default Outlook inbox (up to ~80s) for a matching message, renders the HTML
body to readable text, and writes the result to test/_email_out.txt. The
elevated shell writes the request file then polls the output file.
"""
import os
import re
import time

import win32com.client

HERE = os.path.dirname(os.path.abspath(__file__))
REQ = os.path.join(HERE, "_email_req.txt")
OUT = os.path.join(HERE, "_email_out.txt")


def render(html: str) -> str:
    b = html or ""
    b = re.sub(r"<style[\s\S]*?</style>", "", b, flags=re.I)
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


def write_out(text: str):
    with open(OUT, "w", encoding="utf-8", errors="replace") as f:
        f.write(text)


def main():
    try:
        with open(REQ, encoding="utf-8") as f:
            needle = f.read().strip()
    except Exception as e:
        write_out(f"ERROR reading request file: {e}")
        return
    if not needle:
        write_out("ERROR: empty needle")
        return
    try:
        ol = win32com.client.Dispatch("Outlook.Application").GetNamespace("MAPI")
        inbox = ol.GetDefaultFolder(6)
    except Exception as e:
        write_out(f"ERROR opening Outlook (integrity?): {e}")
        return
    for attempt in range(16):  # ~80s
        try:
            items = inbox.Items
            items.Sort("[ReceivedTime]", True)
        except Exception as e:
            write_out(f"ERROR reading inbox: {e}")
            return
        n = 0
        for m in items:
            n += 1
            if n > 30:
                break
            try:
                subj = m.Subject or ""
            except Exception:
                continue
            if needle in subj:
                try:
                    atts = [a.FileName for a in m.Attachments]
                except Exception:
                    atts = []
                out = []
                out.append("FOUND")
                out.append("SUBJECT: " + subj)
                try:
                    out.append("RECEIVED: " + str(m.ReceivedTime)[:19])
                except Exception:
                    out.append("RECEIVED: ?")
                try:
                    out.append("TO: " + (m.To or ""))
                except Exception:
                    pass
                out.append("ATTACHMENTS: " + str(atts))
                out.append("=" * 66)
                try:
                    out.append(render(m.HTMLBody))
                except Exception as e:
                    out.append("(body render failed: %s)" % e)
                write_out("\n".join(out))
                return
        time.sleep(5)
    write_out("NOT FOUND after ~80s: " + needle)


if __name__ == "__main__":
    main()
