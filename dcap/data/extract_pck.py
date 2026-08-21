#!/usr/bin/env python
"""
extract_pck.py -- Given a parsed quote summary (from parse_quote.py) or a raw
quote hex/json file, split the embedded PCK certificate chain into its three
PEM certs, save PEM + DER copies, and decode the SGX Extensions OID tree from
the leaf cert (FMSPC, PCEID, CPUSVN, PCESVN, etc.) using a small hand-rolled
DER walker (no assumption taken on record author's OID map -- we walk the
actual ASN.1 and print every OID/value pair found, then apply the official
Intel SGX PCK Certificate Extension OID map to label them).

Usage:
    python extract_pck.py <quote.hex-or-json> [--list-field F --index N] [--outdir collateral]
"""
import sys
import os
import json
import argparse
import binascii

from cryptography import x509
from cryptography.hazmat.primitives import serialization

import parse_quote as pq


def eprint(*a, **kw):
    print(*a, file=sys.stderr, **kw)


# --------------------------------------------------------------------------
# Minimal DER TLV walker (just enough for SGX Extensions: SEQUENCE, OID,
# OCTET STRING, INTEGER, ENUMERATED, BOOLEAN)
# --------------------------------------------------------------------------

def read_tlv(data, off):
    tag = data[off]
    off1 = off + 1
    length_byte = data[off1]
    off2 = off1 + 1
    if length_byte & 0x80:
        n = length_byte & 0x7F
        length = int.from_bytes(data[off2:off2 + n], "big")
        content_start = off2 + n
    else:
        length = length_byte
        content_start = off2
    content_end = content_start + length
    return tag, content_start, content_end


def decode_oid(b):
    # DER OID content bytes -> dotted string
    nums = []
    first = b[0]
    nums.append(first // 40)
    nums.append(first % 40)
    val = 0
    for byte in b[1:]:
        val = (val << 7) | (byte & 0x7F)
        if not (byte & 0x80):
            nums.append(val)
            val = 0
    return ".".join(str(n) for n in nums)


def walk_sgx_extension_seq(data, off, end, indent=""):
    """The SGX extension content is: SEQUENCE OF (SEQUENCE { OID, ANY }).
    Recurse into nested SEQUENCE values (e.g. the TCB sub-sequence)."""
    entries = {}
    while off < end:
        tag, cstart, cend = read_tlv(data, off)
        assert tag == 0x30, f"expected SEQUENCE (0x30), got {tag:#x} at {off}"
        # this SEQUENCE is one {OID, value} entry
        oid_tag, oid_cstart, oid_cend = read_tlv(data, cstart)
        assert oid_tag == 0x06, f"expected OID (0x06), got {oid_tag:#x}"
        oid = decode_oid(data[oid_cstart:oid_cend])
        val_off = oid_cend
        val_tag, val_cstart, val_cend = read_tlv(data, val_off)
        raw_value = data[val_cstart:val_cend]
        eprint(f"{indent}OID {oid}  tag=0x{val_tag:02x}  len={val_cend - val_cstart}  "
               f"hex={raw_value.hex()}")
        entry = {"tag": val_tag, "raw": raw_value}
        if val_tag == 0x30:
            # nested SEQUENCE of OID/value entries (e.g. the TCB sub-tree)
            eprint(f"{indent}  -> nested SEQUENCE, descending")
            entry["nested"] = walk_sgx_extension_seq(data, val_cstart, val_cend, indent + "  ")
        entries[oid] = entry
        off = cend
    return entries


# Official Intel SGX PCK Certificate Extension OID map
# (Intel SGX PCK Certificate and Certificate Revocation List Profile spec)
OID_NAMES = {
    "1.2.840.113741.1.13.1": "sgx-extensions",
    "1.2.840.113741.1.13.1.1": "ppid",
    "1.2.840.113741.1.13.1.2": "tcb",
    "1.2.840.113741.1.13.1.2.1": "sgxtcbcomp01svn",
    "1.2.840.113741.1.13.1.2.2": "sgxtcbcomp02svn",
    "1.2.840.113741.1.13.1.2.3": "sgxtcbcomp03svn",
    "1.2.840.113741.1.13.1.2.4": "sgxtcbcomp04svn",
    "1.2.840.113741.1.13.1.2.5": "sgxtcbcomp05svn",
    "1.2.840.113741.1.13.1.2.6": "sgxtcbcomp06svn",
    "1.2.840.113741.1.13.1.2.7": "sgxtcbcomp07svn",
    "1.2.840.113741.1.13.1.2.8": "sgxtcbcomp08svn",
    "1.2.840.113741.1.13.1.2.9": "sgxtcbcomp09svn",
    "1.2.840.113741.1.13.1.2.10": "sgxtcbcomp10svn",
    "1.2.840.113741.1.13.1.2.11": "sgxtcbcomp11svn",
    "1.2.840.113741.1.13.1.2.12": "sgxtcbcomp12svn",
    "1.2.840.113741.1.13.1.2.13": "sgxtcbcomp13svn",
    "1.2.840.113741.1.13.1.2.14": "sgxtcbcomp14svn",
    "1.2.840.113741.1.13.1.2.15": "sgxtcbcomp15svn",
    "1.2.840.113741.1.13.1.2.16": "sgxtcbcomp16svn",
    "1.2.840.113741.1.13.1.2.17": "pcesvn",
    "1.2.840.113741.1.13.1.2.18": "cpusvn",
    "1.2.840.113741.1.13.1.3": "pceid",
    "1.2.840.113741.1.13.1.4": "fmspc",
    "1.2.840.113741.1.13.1.5": "sgxtype",
    "1.2.840.113741.1.13.1.6": "platforminstanceid",
    "1.2.840.113741.1.13.1.7": "configuration",
}

SGX_EXTENSION_OID = "1.2.840.113741.1.13.1"


def split_pem_chain(pem_text):
    certs = []
    cur = []
    in_cert = False
    for line in pem_text.splitlines():
        if "BEGIN CERTIFICATE" in line:
            in_cert = True
            cur = [line]
        elif "END CERTIFICATE" in line:
            cur.append(line)
            certs.append("\n".join(cur) + "\n")
            in_cert = False
        elif in_cert:
            cur.append(line)
    return certs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--field", default="intel_quote")
    ap.add_argument("--list-field", default=None)
    ap.add_argument("--index", type=int, default=0)
    ap.add_argument("--outdir", default="collateral")
    ap.add_argument("--out", default=None, help="write extraction summary JSON here")
    args = ap.parse_args()

    quote_bytes, meta = pq.load_quote_bytes(args.input, args.field, args.list_field, args.index)
    summary = pq.parse_quote(quote_bytes)
    pem_chain = summary["pckCertChainPem"]
    if not pem_chain:
        eprint("No PCK cert chain PEM found in this quote.")
        sys.exit(1)

    cert_pems = split_pem_chain(pem_chain)
    eprint(f"[chain] found {len(cert_pems)} PEM certificates")
    if len(cert_pems) != 3:
        eprint(f"[chain] WARNING: expected 3 certs (leaf, intermediate CA, root CA), got {len(cert_pems)}")

    certs = [x509.load_pem_x509_certificate(p.encode()) for p in cert_pems]
    names = ["pck_leaf", "pck_ca", "root_ca"]

    os.makedirs(args.outdir, exist_ok=True)
    for name, pem, cert in zip(names, cert_pems, certs):
        pem_path = os.path.join(args.outdir, f"{name}.pem")
        der_path = os.path.join(args.outdir, f"{name}.der")
        with open(pem_path, "w", encoding="utf-8") as f:
            f.write(pem)
        der_bytes = cert.public_bytes(serialization.Encoding.DER)
        with open(der_path, "wb") as f:
            f.write(der_bytes)
        eprint(f"[write] {pem_path} , {der_path} ({len(der_bytes)} bytes DER)")
        eprint(f"        subject={cert.subject.rfc4514_string()}")
        eprint(f"        issuer ={cert.issuer.rfc4514_string()}")

    leaf, ca, root = certs

    # ---- SGX extension walk on the leaf cert ----
    ext = leaf.extensions.get_extension_for_oid(x509.ObjectIdentifier(SGX_EXTENSION_OID))
    raw = ext.value.value if hasattr(ext.value, "value") else bytes(ext.value)
    eprint(f"\n[sgx-ext] raw extnValue length={len(raw)} bytes, walking DER tree:")
    tag, cstart, cend = read_tlv(raw, 0)
    assert tag == 0x30
    tree = walk_sgx_extension_seq(raw, cstart, cend)

    def get_raw(oid):
        e = tree.get(oid)
        return e["raw"] if e else None

    fmspc = get_raw(OID_NAMES_REV := "1.2.840.113741.1.13.1.4")
    pceid = get_raw("1.2.840.113741.1.13.1.3")
    tcb_entry = tree.get("1.2.840.113741.1.13.1.2")
    cpusvn = pcesvn = None
    tcb_comps = {}
    if tcb_entry and "nested" in tcb_entry:
        nested = tcb_entry["nested"]
        cpusvn_raw = nested.get("1.2.840.113741.1.13.1.2.18")
        pcesvn_raw = nested.get("1.2.840.113741.1.13.1.2.17")
        cpusvn = cpusvn_raw["raw"] if cpusvn_raw else None
        pcesvn = pcesvn_raw["raw"] if pcesvn_raw else None
        for i in range(1, 17):
            k = f"1.2.840.113741.1.13.1.2.{i}"
            if k in nested:
                tcb_comps[f"sgxtcbcomp{i:02d}svn"] = nested[k]["raw"].hex()

    # Also check per the TASK's claimed (non-standard) OID mapping:
    # CPUSVN @ .2.1 and PCESVN @ .2.2 -- report both interpretations.
    task_cpusvn_21 = tcb_entry["nested"].get("1.2.840.113741.1.13.1.2.1") if tcb_entry else None
    task_pcesvn_22 = tcb_entry["nested"].get("1.2.840.113741.1.13.1.2.2") if tcb_entry else None

    pubkey_uncompressed = leaf.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    assert pubkey_uncompressed[0] == 0x04
    pubkey_64 = pubkey_uncompressed[1:]

    ca_cn = ca.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)
    ca_cn_str = ca_cn[0].value if ca_cn else None
    if ca_cn_str and "Platform" in ca_cn_str:
        ca_kind = "Intel SGX PCK Platform CA"
    elif ca_cn_str and "Processor" in ca_cn_str:
        ca_kind = "Intel SGX PCK Processor CA"
    else:
        ca_kind = f"unknown ({ca_cn_str})"

    leaf_cn = leaf.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)
    leaf_issuer_cn = leaf.issuer.get_attributes_for_oid(x509.NameOID.COMMON_NAME)

    result = {
        "fmspc": fmspc.hex() if fmspc else None,
        "pceid": pceid.hex() if pceid else None,
        "cpusvn_official_2_18": cpusvn.hex() if cpusvn else None,
        "pcesvn_official_2_17": pcesvn.hex() if pcesvn else None,
        "cpusvn_task_claim_2_1": task_cpusvn_21["raw"].hex() if task_cpusvn_21 else None,
        "pcesvn_task_claim_2_2": task_pcesvn_22["raw"].hex() if task_pcesvn_22 else None,
        "tcb_comps": tcb_comps,
        "leaf_subject_cn": leaf_cn[0].value if leaf_cn else None,
        "leaf_issuer_cn": leaf_issuer_cn[0].value if leaf_issuer_cn else None,
        "leaf_public_key_uncompressed_64": pubkey_64.hex(),
        "intermediate_ca_cn": ca_cn_str,
        "intermediate_ca_kind": ca_kind,
        "root_ca_subject_cn": (root.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME) or [None])[0].value
                              if root.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME) else None,
    }

    eprint("\n[result]")
    eprint(json.dumps(result, indent=2))

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)
    else:
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
