#!/usr/bin/env python3
"""
Refresh EVERYTHING this deployment depends on, from live sources:

  1. Real Intel TDX quotes from Phala/RedPill confidential inference nodes
     (api.redpill.ai, no API key). Saved as data/quote_*.hex.
  2. The Intel PCS collateral those quotes need (root CA + CRL, PCK CA CRL,
     TDX tcbInfo per FMSPC, TD_QE identity, TCB evaluation data numbers),
     saved under data/collateral/.

Then run build_onchain_collateral.py to fold it into data/collateral/onchain.json.

    python data/fetch_all.py && python data/build_onchain_collateral.py
"""
import base64
import json
import os
import re
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
COL = os.path.join(HERE, "collateral")
os.makedirs(COL, exist_ok=True)

REDPILL = "https://api.redpill.ai/v1"
PCS_TDX = "https://api.trustedservices.intel.com/tdx/certification/v4"
PCS_SGX = "https://api.trustedservices.intel.com/sgx/certification/v4"

# The models we pull attestations from. kimi exposes `all_attestations`: a whole
# committee of distinct TDX instances, which is what we actually want on-chain.
MODELS = [
    "deepseek/deepseek-v4-flash-0731",
    "openai/gpt-oss-120b",
    "qwen/qwen3.6-27b",
    "z-ai/glm-5.2",
    "meta-llama/llama-3.3-70b-instruct",
    "moonshotai/kimi-k2.6",
]


def get(url, timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent": "assay-dcap/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), dict(r.headers)


def decode_quote(s):
    """RedPill returns either hex or base64 depending on the endpoint version."""
    t = s.strip()
    if re.fullmatch(r"[0-9a-fA-F]+", t) and len(t) % 2 == 0:
        return bytes.fromhex(t)
    return base64.b64decode(t)


def fetch_quotes():
    fmspcs = set()
    for model in MODELS:
        body, _ = get("%s/attestation/report?model=%s" % (REDPILL, urllib.parse.quote(model)))
        d = json.loads(body)
        slug = model.replace("/", "_")
        with open(os.path.join(HERE, "att_%s.json" % slug), "wb") as f:
            f.write(body)

        wrote = []
        if d.get("intel_quote"):
            q = decode_quote(d["intel_quote"])
            p = os.path.join(HERE, "quote_%s.hex" % slug)
            open(p, "w").write(q.hex())
            wrote.append((p, q))
        for i, a in enumerate(d.get("all_attestations") or []):
            if not a.get("intel_quote"):
                continue
            q = decode_quote(a["intel_quote"])
            p = os.path.join(HERE, "quote_kimi_%02d.hex" % i) if "kimi" in slug else \
                os.path.join(HERE, "quote_%s_%02d.hex" % (slug, i))
            open(p, "w").write(q.hex())
            wrote.append((p, q))

        for p, q in wrote:
            f = fmspc_of_quote(q)
            if f:
                fmspcs.add(f)
        print("%-40s %d quote(s)" % (model, len(wrote)))
    return sorted(fmspcs)


def fmspc_of_quote(quote: bytes):
    """Pull the FMSPC straight out of the PCK leaf embedded in the quote."""
    m = re.search(rb"-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----", quote, re.S)
    if not m:
        return None
    der = base64.b64decode(b"".join(m.group(1).split()))
    oid = bytes.fromhex("060a2a864886f84d010d010404")  # 1.2.840.113741.1.13.1.4, OCTET STRING
    i = der.find(oid)
    if i < 0:
        return None
    n = der[i + len(oid)]
    return der[i + len(oid) + 1: i + len(oid) + 1 + n].hex()


def save(name, data):
    with open(os.path.join(COL, name), "wb") as f:
        f.write(data if isinstance(data, bytes) else data.encode())
    print("  ", name, len(data))


def save_headers(name, headers):
    txt = "".join("%s: %s\n" % (k, v) for k, v in headers.items())
    save(name, txt.encode())


def fetch_collateral(fmspcs):
    print("collateral for FMSPCs:", fmspcs)

    for fmspc in fmspcs:
        body, h = get("%s/tcb?fmspc=%s" % (PCS_TDX, fmspc))
        save("tcbinfo_tdx_%s.json" % fmspc, body)
        save_headers("headers_tcbinfo.txt", h)

    body, h = get("%s/qe/identity?id=TD_QE" % PCS_TDX)
    save("qeidentity_tdqe.json", body)
    save_headers("headers_qeidentity.txt", h)

    body, h = get("%s/tcbevaluationdatanumbers" % PCS_TDX)
    save("tcbevaldatanumbers_tdx.json", body)
    save_headers("headers_tcbevalnum.txt", h)

    for ca in ("platform", "processor"):
        body, h = get("%s/pckcrl?ca=%s&encoding=der" % (PCS_SGX, ca))
        save("pckcrl_%s.der" % ca, body)
        save_headers("headers_pckcrl_%s.txt" % ca, h)

    body, _ = get("https://certificates.trustedservices.intel.com/IntelSGXRootCA.der")
    save("root_ca.crl.der", body)  # this endpoint serves the root CRL in DER


def split_pck_chain():
    """Store the three certs of the primary quote's PCK chain individually."""
    primary = os.environ.get("PRIMARY_QUOTE", "quote_deepseek_deepseek-v4-flash-0731.hex")
    p = os.path.join(HERE, primary)
    if not os.path.exists(p):
        print("skip PCK chain split, no", primary)
        return
    q = bytes.fromhex(open(p).read().strip())
    pems = re.findall(rb"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", q, re.S)
    names = ["pck_leaf", "pck_ca", "root_ca"]
    for name, pem in zip(names, pems):
        save(name + ".pem", pem)
        b64 = re.search(rb"-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----", pem, re.S).group(1)
        save(name + ".der", base64.b64decode(b"".join(b64.split())))


if __name__ == "__main__":
    fmspcs = fetch_quotes()
    split_pck_chain()
    fetch_collateral(fmspcs)
    print("\nnow run: python data/build_onchain_collateral.py")
