#!/usr/bin/env python3
"""Resolve pnpm catalog: refs in apps/server/package.json so npm pack works."""
import json
import re
import sys

WS_PATH = "../../pnpm-workspace.yaml"
PKG = "package.json"


def parse_catalog(text: str) -> dict:
    catalog = {}
    in_cat = False
    for line in text.splitlines():
        if re.match(r"^catalog:", line):
            in_cat = True
            continue
        if in_cat:
            m = re.match(r'^  (.+?):\s*"?([^"\n]+)"?,?\s*$', line)
            if m:
                catalog[m.group(1).strip('"')] = m.group(2)
            elif line and not line.startswith(" "):
                in_cat = False
    return catalog


def main() -> None:
    catalog = parse_catalog(open(WS_PATH).read())
    print(f"catalog entries: {len(catalog)}")
    orig = open(PKG).read()
    open("/tmp/orig-server-package.json", "w").write(orig)
    d = json.loads(orig)

    def resolve(name, v):
        if isinstance(v, str) and v == "catalog:":  # bare ref: keyed by dep name
            return catalog.get(name, v)
        if isinstance(v, str) and v.startswith("catalog:"):
            return catalog.get(v[len("catalog:"):], v)
        return v

    for field in ("dependencies", "devDependencies", "overrides"):
        if isinstance(d.get(field), dict):
            d[field] = {k: resolve(k, v) for k, v in d[field].items()}

    open(PKG, "w").write(json.dumps(d, indent=2) + "\n")
    unresolved = [
        v
        for field in ("dependencies", "devDependencies", "overrides")
        for v in (d.get(field) or {}).values()
        if isinstance(v, str) and v.startswith("catalog:")
    ]
    print(f"unresolved catalog refs: {len(unresolved)}")
    if unresolved:
        print(unresolved)
        sys.exit(1)


if __name__ == "__main__":
    main()
