"""Scheduled check: refresh prices, record history, write alerts.

Reads data/config.json and data/items.json, writes data/coupons.json,
data/history.json and data/latest.json, and writes alert.md when a price
adjustment is due or a price dropped since the last check (the workflow
turns that file into a GitHub issue).
"""

import datetime as dt
import json
import time
from pathlib import Path

from costco import apply_coupon, check_items, warehouse_coupons

DATA = Path(__file__).resolve().parent.parent / "data"
ALERT = DATA.parent / "alert.md"
ADJUST_DAYS = 30  # Costco's price adjustment window


def load(name, default):
    path = DATA / name
    return json.loads(path.read_text()) if path.exists() else default


def save(name, value):
    (DATA / name).write_text(json.dumps(value, indent=1) + "\n")


def main():
    today = dt.date.today()
    warehouse = str(load("config.json", {}).get("warehouse", "233"))
    items = load("items.json", [])
    history = load("history.json", {})

    coupons = warehouse_coupons()
    save("coupons.json", {"updated": today.isoformat(), "coupons": coupons})

    numbers = [str(i["item"]) for i in items]
    results = {}
    for start in range(0, len(numbers), 20):
        for r in check_items(numbers[start:start + 20], warehouse):
            results[r["item"]] = apply_coupon(r, coupons)
        time.sleep(1)

    lines = []
    for i in items:
        n = str(i["item"])
        r = results[n]
        past = history.setdefault(n, [])
        if past and past[-1]["date"] == today.isoformat():
            past.pop()  # re-run on the same day replaces that day's entry
        previous = past[-1]["price"] if past else None
        if r["price"] is None:
            continue
        past.append({"date": today.isoformat(), "price": r["price"]})
        label = f"**{r['name'] or n}** (#{n}): now ${r['price']:.2f}"
        paid = i.get("paid")
        bought = dt.date.fromisoformat(i["date"]) if i.get("date") else None
        in_window = bought is None or (today - bought).days <= ADJUST_DAYS
        if paid and r["price"] < paid and in_window:
            lines.append(f"- Price adjustment due: {label}, you paid ${paid:.2f}. "
                         f"Ask for ${paid - r['price']:.2f} back.")
        elif previous is not None and r["price"] < previous:
            lines.append(f"- Price drop: {label}, was ${previous:.2f}.")

    save("history.json", history)
    save("latest.json", {"date": today.isoformat(), "warehouse": warehouse,
                         "results": list(results.values())})
    if lines:
        ALERT.write_text(f"Costco #{warehouse} check on {today.isoformat()}\n\n" + "\n".join(lines) + "\n")
        print(ALERT.read_text())
    else:
        print("No drops.")


if __name__ == "__main__":
    main()
