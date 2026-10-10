"""Costco in-warehouse price lookups (no login).

check_items(): costco.com's product summary API. Given receipt item numbers
and a warehouse number it returns the in-store price at that warehouse,
including warehouse-only items that are not listed on costco.com.

warehouse_coupons(): the current coupon book from the Warehouse Savings
page. The product API leaves these coupons out for warehouse-only items.
"""

import json
import re
import urllib.request

SUMMARY_URL = "https://gdx-api.costco.com/catalog/product/product-api/v2/products/summary"
SUMMARY_CLIENT_ID = "4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf"
SUMMARY_HEADERS = {"client-identifier": "b1be4e95-8696-4d93-8f50-5b5632922209", "costco-env": "prd"}
SAVINGS_URL = "https://www.costco.com/o/-/warehouse-savings"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36"


def check_items(items, warehouse):
    """In-warehouse prices for up to 20 item numbers at one warehouse.

    whsNumber must be "847,<warehouse>": 847 is costco.com's online catalog,
    and only one physical warehouse is answered per call.
    """
    url = (f"{SUMMARY_URL}?clientId={SUMMARY_CLIENT_ID}&items={','.join(map(str, items))}"
           f"&whsNumber=847,{warehouse}&locales=en-us")
    req = urllib.request.Request(url, headers={**SUMMARY_HEADERS, "User-Agent": UA,
                                               "Accept-Encoding": "identity"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    out = {str(i): {"item": str(i), "name": None, "price": None, "discount": None} for i in items}
    for p in data.get("productData", []):
        prices = {d["warehouseNumber"]: d for d in p.get("displayPrice", [])}
        wh = prices.get(str(warehouse))
        name = p["descriptions"][0]["object"]["shortDescription"] if p.get("descriptions") else None
        out[p["id"]] = {
            "item": p["id"],
            "name": " ".join(name.split()) if name else None,
            "price": wh["deliveredPrice"] if wh and wh["deliveredPrice"] else None,
            "discount": wh["aggregatedDiscountAmt"] or None if wh else None,
        }
    return [out[str(i)] for i in items]


def warehouse_coupons():
    """Current coupon book: {item number: {"final": price or None, "off": $ off or None}}."""
    req = urllib.request.Request(SAVINGS_URL, headers={"User-Agent": UA, "Accept-Language": "en-US"})
    with urllib.request.urlopen(req, timeout=60) as r:
        page = r.read().decode("utf-8", "replace").replace('\\"', '"')
    coupons = {}
    for m in re.finditer(r'"itemNumber":"([0-9, ]+)"', page):
        start = page.find('"pricesOffCSObject":[', m.end())
        if start == -1 or start - m.end() > 3000:
            continue
        block = page[start:page.find('"priceTable"', start)]
        values = re.findall(r'"value":\["([^"]*)"\]', block)
        text = " ".join(re.findall(r'"append_text":"([^"]*)"', block))
        off = re.search(r"\$(\d+(?:\.\d+)?) OFF", text)
        try:
            if not values:
                entry = {"final": None, "off": float(off.group(1))} if off else None
            elif "after" in text.lower():
                entry = {"final": float(values[0]), "off": float(off.group(1)) if off else None}
            else:
                entry = {"final": None, "off": float(values[0])}
        except ValueError:
            entry = None
        if entry:
            for item in re.split(r"[ ,]+", m.group(1).strip()):
                if item:
                    coupons[item] = entry
    return coupons


def apply_coupon(result, coupons):
    """Lower the price by an in-store coupon the API didn't already include."""
    coupon = coupons.get(result["item"])
    if not coupon or result["price"] is None or result["discount"]:
        return result
    price = result["price"]
    result["price"] = coupon["final"] if coupon["final"] is not None else round(price - coupon["off"], 2)
    result["discount"] = coupon["off"] if coupon["off"] is not None else round(price - result["price"], 2)
    return result
