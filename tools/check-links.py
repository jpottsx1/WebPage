#!/usr/bin/env python3
"""Find broken links and missing images on jeffreypotts.ca and sgeulai.com.

    python3 tools/check-links.py                    # both sites
    python3 tools/check-links.py https://sgeulai.com
    python3 tools/check-links.py --external         # also check links to other sites

It starts at each site's home page and sitemap, follows every link on the
same site (skipping /admin and /api), and checks every link, image, script
and stylesheet it finds. It only reads pages; it never submits forms.
Broken links are listed with the pages that contain them, and the exit
status is 1 if there are any.

The same file is in both repositories (jpottsx1/WebPage and
jpottsx1/sgeulai-web); keep them alike.
"""

import argparse
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from urllib.parse import urldefrag, urljoin, urlparse

SITES = ["https://jeffreypotts.ca", "https://sgeulai.com"]
UA = "Mozilla/5.0 (compatible; site-link-check; +https://jeffreypotts.ca)"
SKIP_PREFIXES = ("/admin", "/api/", "/cdn-cgi/", "/xmlrpc")
SKIP_SCHEMES = ("mailto:", "tel:", "javascript:", "data:", "sms:")


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.found = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        for name in ("href", "src"):
            if a.get(name):
                self.found.append(a[name])
        for name in ("srcset", "imagesrcset"):
            if a.get(name):
                self.found += [c.strip().split(" ")[0] for c in a[name].split(",") if c.strip()]


def fetch(url, method="GET"):
    """(status, content_type, text_or_None). status 0 means it couldn't connect."""
    req = urllib.request.Request(url, method=method, headers={"User-Agent": UA, "Accept": "text/html,*/*"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            ctype = r.headers.get("Content-Type", "")
            body = r.read().decode("utf-8", "replace") if method == "GET" and "html" in ctype else None
            return r.status, ctype, body
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", ""), None
    except Exception as e:  # DNS, TLS, timeout
        return 0, str(e), None


def status_of(url):
    status, info, _ = fetch(url, "HEAD")
    if status == 0 or status >= 400:  # some servers only answer GET properly
        status, info, _ = fetch(url, "GET")
    return status, info


def sitemap_urls(base):
    status, _, _ = fetch(base + "/sitemap.xml", "HEAD")
    if status != 200:
        return []
    req = urllib.request.Request(base + "/sitemap.xml", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        return re.findall(r"<loc>([^<]+)</loc>", r.read().decode("utf-8", "replace"))


def crawl(base, max_pages, external):
    host = urlparse(base).netloc
    queue = [base + "/"] + sitemap_urls(base)
    seen_pages, links = set(), {}  # links: url -> set of pages it appears on
    while queue and len(seen_pages) < max_pages:
        page = urldefrag(queue.pop(0))[0]
        if page in seen_pages:
            continue
        seen_pages.add(page)
        status, ctype, body = fetch(page)
        if status != 200 or body is None:
            links.setdefault(page, set()).add("(sitemap or a link)")
            continue
        parser = Links()
        parser.feed(body)
        for raw in parser.found:
            raw = raw.strip()
            if not raw or raw.startswith("#") or raw.lower().startswith(SKIP_SCHEMES):
                continue
            url = urldefrag(urljoin(page, raw))[0]
            u = urlparse(url)
            if u.scheme not in ("http", "https"):
                continue
            same = u.netloc == host
            if same and u.path.startswith(SKIP_PREFIXES):
                continue
            if not same and not external:
                continue
            links.setdefault(url, set()).add(page)
            if same and url not in seen_pages and not re.search(r"\.(jpe?g|png|webp|gif|svg|ico|css|js|zip|pdf|mp4|xml|json|txt|woff2?)$", u.path, re.I):
                queue.append(url)
    return seen_pages, links


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("sites", nargs="*", default=SITES)
    ap.add_argument("--external", action="store_true", help="also check links to other sites")
    ap.add_argument("--max-pages", type=int, default=500)
    args = ap.parse_args()

    broken_total = 0
    for base in (s.rstrip("/") for s in args.sites):
        print(f"{base}: crawling…", flush=True)
        pages, links = crawl(base, args.max_pages, args.external)
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = dict(zip(links, pool.map(status_of, links)))
        broken = {u: r for u, r in results.items() if r[0] == 0 or r[0] >= 400}
        print(f"  {len(pages)} pages, {len(links)} links checked, {len(broken)} broken")
        for url, (status, info) in sorted(broken.items()):
            label = f"error ({info})" if status == 0 else str(status)
            note = "  (some sites refuse automated checks)" if urlparse(url).netloc != urlparse(base).netloc and status in (403, 429, 503) else ""
            print(f"  ✗ {label}  {url}{note}")
            for p in sorted(links[url])[:5]:
                print(f"      on {p}")
            if len(links[url]) > 5:
                print(f"      … and {len(links[url]) - 5} more pages")
        broken_total += len(broken)
    sys.exit(1 if broken_total else 0)


if __name__ == "__main__":
    main()
