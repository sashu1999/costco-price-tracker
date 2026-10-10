"""Per-person price alerts for everyone with an account.

Reads every account's items and store from Supabase (service key, so it
sees all rows), checks today's in-store prices once per store, saves them to
price_history, and emails each person the items they can claim money back on.
Each drop is emailed once per price (private_alerts_sent).

Environment (GitHub Actions secrets):
  SUPABASE_URL, SUPABASE_SERVICE_KEY   - the project's URL and secret/service_role key
  GMAIL_USER, GMAIL_APP_PASSWORD       - sender account and its Google app password
  APP_URL                              - link put in the emails (optional)
"""

import datetime as dt
import json
import os
import smtplib
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from email.message import EmailMessage
from html import escape

from costco import apply_coupon, check_items, warehouse_coupons

ADJUST_DAYS = 30
APP_URL = os.environ.get("APP_URL", "https://sashu1999.github.io/costco-price-tracker/")


class Supabase:
    def __init__(self, url, key):
        self.url, self.key = url.rstrip("/"), key

    def _call(self, method, path, body=None, headers=None):
        req = urllib.request.Request(
            f"{self.url}{path}", method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"apikey": self.key, "Authorization": f"Bearer {self.key}",
                     "Content-Type": "application/json", **(headers or {})})
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return json.loads(raw) if raw else None

    def select(self, table, query="select=*"):
        return self._call("GET", f"/rest/v1/{table}?{query}")

    def upsert(self, table, rows, on_conflict):
        if rows:
            self._call("POST", f"/rest/v1/{table}?on_conflict={on_conflict}", rows,
                       {"Prefer": "resolution=merge-duplicates,return=minimal"})

    def user_emails(self):
        emails, page = {}, 1
        while True:
            data = self._call("GET", f"/auth/v1/admin/users?page={page}&per_page=200")
            users = data.get("users", []) if isinstance(data, dict) else data
            for u in users:
                if u.get("email") and u.get("email_confirmed_at"):
                    emails[u["id"]] = u["email"]
            if len(users) < 200:
                return emails
            page += 1


def claims_for(items, prices, today, already_sent):
    """Items a person can claim money back on, skipping drops they were already told about."""
    out = []
    for it in items:
        r = prices.get(it["item"])
        if not r or r["price"] is None or it.get("paid") is None:
            continue
        paid, price = float(it["paid"]), float(r["price"])
        if price >= paid:
            continue
        bought = dt.date.fromisoformat(it["bought_on"]) if it.get("bought_on") else None
        left = None if bought is None else ADJUST_DAYS - (today - bought).days
        if left is not None and left < 0:
            continue
        if (it["item"], round(price, 2)) in already_sent:
            continue
        out.append({"item": it["item"], "name": r["name"] or it.get("name") or f"Item {it['item']}",
                    "paid": paid, "price": price, "back": round(paid - price, 2), "left": left,
                    "by": bought + dt.timedelta(days=ADJUST_DAYS) if bought else None})
    return sorted(out, key=lambda c: (c["left"] is None, c["left"]))


def email_body(claims, store):
    total = sum(c["back"] for c in claims)
    lines = [f"You can claim ${total:.2f} back at Costco.", ""]
    rows = []
    for c in claims:
        left = "" if c["left"] is None else f" (claim by {c['by']:%b %-d}, {c['left']} day{'s' if c['left'] != 1 else ''} left)"
        lines.append(f"- {c['name']} #{c['item']}: paid ${c['paid']:.2f}, now ${c['price']:.2f}. "
                     f"Ask for ${c['back']:.2f}{left}.")
        rows.append(f"<tr><td style='padding:6px 12px 6px 0'>{escape(c['name'])} <span style='color:#666'>#{c['item']}</span></td>"
                    f"<td style='padding:6px 12px 6px 0'>${c['paid']:.2f} → ${c['price']:.2f}</td>"
                    f"<td style='padding:6px 0;font-weight:600;color:#17703f'>${c['back']:.2f}{escape(left)}</td></tr>")
    lines += ["", f"Prices at Costco #{store}. Show your receipt or membership card at the membership counter.", APP_URL]
    html = (f"<div style='font-family:system-ui,sans-serif;font-size:15px;color:#1b1f23'>"
            f"<p style='font-size:20px;font-weight:700;color:#17703f;margin:0 0 12px'>You can claim ${total:.2f} back</p>"
            f"<table style='border-collapse:collapse'>{''.join(rows)}</table>"
            f"<p style='color:#555'>Prices at Costco #{escape(store)}. Show your receipt or membership card at the membership counter.</p>"
            f"<p><a href='{APP_URL}'>Open Price Adjust</a></p></div>")
    return f"Costco price drop: claim ${total:.2f} back", "\n".join(lines), html


def send_email(smtp, sender, to, subject, text, html):
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = f"Price Adjust <{sender}>", to, subject
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    smtp.send_message(msg)


def main():
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        print("SUPABASE_URL / SUPABASE_SERVICE_KEY not set; skipping account alerts.")
        return
    gmail_user, gmail_pw = os.environ.get("GMAIL_USER"), os.environ.get("GMAIL_APP_PASSWORD")
    db = Supabase(url, key)
    today = dt.date.today()

    items = db.select("items", "select=user_id,item,name,paid,bought_on")
    profiles = {p["user_id"]: p for p in db.select("profiles", "select=user_id,warehouse,email_alerts")}
    by_user = defaultdict(list)
    for it in items:
        by_user[it["user_id"]].append(it)
    store_of = {u: str(profiles.get(u, {}).get("warehouse") or "233") for u in by_user}

    coupons = warehouse_coupons()
    prices = {}                      # warehouse -> item -> result
    for store in sorted(set(store_of.values())):
        numbers = sorted({it["item"] for u, its in by_user.items() if store_of[u] == store for it in its})
        prices[store] = {}
        for start in range(0, len(numbers), 20):
            for r in check_items(numbers[start:start + 20], store):
                prices[store][r["item"]] = apply_coupon(r, coupons)
            time.sleep(1)
        db.upsert("price_history", [{"warehouse": store, "item": n, "checked_on": today.isoformat(), "price": r["price"]}
                                    for n, r in prices[store].items() if r["price"] is not None],
                  "warehouse,item,checked_on")
    print(f"Checked {sum(len(p) for p in prices.values())} items at {len(prices)} store(s) for {len(by_user)} account(s).")

    sent = {(a["user_id"], a["item"], round(float(a["price"]), 2))
            for a in db.select("private_alerts_sent", "select=user_id,item,price")}
    emails = db.user_emails()
    outbox = []
    for user, its in by_user.items():
        if profiles.get(user, {}).get("email_alerts") is False or user not in emails:
            continue
        already = {(i, p) for (u, i, p) in sent if u == user}
        claims = claims_for(its, prices[store_of[user]], today, already)
        if claims:
            outbox.append((user, emails[user], claims, store_of[user]))

    if not outbox:
        print("No new drops to email.")
        return
    if not gmail_user or not gmail_pw:
        print(f"{len(outbox)} alert email(s) due, but GMAIL_USER / GMAIL_APP_PASSWORD are not set.")
        sys.exit(1)
    with smtplib.SMTP("smtp.gmail.com", 587, timeout=30) as smtp:
        smtp.starttls()
        smtp.login(gmail_user, gmail_pw)
        for user, to, claims, store in outbox:
            subject, text, html = email_body(claims, store)
            send_email(smtp, gmail_user, to, subject, text, html)
            db.upsert("private_alerts_sent", [{"user_id": user, "item": c["item"], "price": c["price"]} for c in claims],
                      "user_id,item,price")
            print(f"Emailed {len(claims)} drop(s) to user {user[:8]}…")


if __name__ == "__main__":
    main()
