#!/usr/bin/env python
"""
parse_quote.py -- Parser for Intel DCAP ECDSA-P256 TDX v4 quotes (TEE type 0x81,
TD10ReportBody). Empirically-validated layout (see comments), robust to the
nested QEReportCertificationData -> PCK cert chain structure used by Automata.

Usage:
    python parse_quote.py <quote.hex>                       # hex text file
    python parse_quote.py <attestation.json>                 # reads .intel_quote
    python parse_quote.py <attestation.json> --field intel_quote
    python parse_quote.py <attestation.json> --list-field all_attestations --index 0
    python parse_quote.py <quote.hex> --out summary.json

Prints a human-readable structure walk to stderr, and a JSON summary to
stdout (or --out file).
"""
import sys
import os
import json
import struct
import argparse
import hashlib


def eprint(*a, **kw):
    print(*a, file=sys.stderr, **kw)


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------

def _decode_quote_string(s):
    """Quote payloads observed in the wild are either plain hex (5 single-quote
    models here) or base64 (Moonshot/Kimi's all_attestations entries). Try hex
    first, fall back to base64."""
    s = s.strip()
    try:
        return bytes.fromhex(s), "hex"
    except ValueError:
        pass
    import base64
    return base64.b64decode(s), "base64"


def load_quote_bytes(path, field="intel_quote", list_field=None, index=0):
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read().strip()

    if path.lower().endswith(".json") or raw.lstrip().startswith("{"):
        d = json.loads(raw)
        if list_field:
            container = d[list_field][index]
        else:
            container = d
        hexstr = container[field]
        meta = {k: v for k, v in container.items() if k != field}
        b, enc = _decode_quote_string(hexstr)
        eprint(f"[load] decoded {field} as {enc}")
        return b, meta

    # Treat as a bare hex/base64 string (possibly with whitespace/newlines).
    compact = "".join(raw.split())
    b, enc = _decode_quote_string(compact)
    eprint(f"[load] decoded file contents as {enc}")
    return b, {}


# --------------------------------------------------------------------------
# Header (48 bytes)
# --------------------------------------------------------------------------

def parse_header(b):
    off = 0
    version, ak_type = struct.unpack_from("<HH", b, off)
    off += 4
    tee_type, = struct.unpack_from("<I", b, off)
    off += 4
    qe_svn, pce_svn = struct.unpack_from("<HH", b, off)
    off += 4
    qe_vendor_id = b[off:off + 16]
    off += 16
    # NOTE: empirically (and per the standard sgx_quote_header_t / TDX quote
    # header used by Intel DCAP QVL) userData is the LAST 20 bytes of the
    # 48-byte header, i.e. at offset 28, immediately after qeVendorId -- NOT
    # at offset 32 as a naive reading might suggest (offset 32 would overrun
    # the 48-byte header by 4 bytes: 32+20=52). Verified against the
    # deepseek quote: bytes[28:48] decode to exactly signing_address (20
    # bytes) left-padded... actually decode directly matches reportData[0:20].
    user_data = b[off:off + 20]
    off += 20
    assert off == 48, f"header parse consumed {off} bytes, expected 48"

    eprint(f"[header] version={version} attestationKeyType={ak_type} "
           f"teeType=0x{tee_type:08x} qeSvn={qe_svn} pceSvn={pce_svn}")
    eprint(f"[header] qeVendorId={qe_vendor_id.hex()}")
    eprint(f"[header] userData={user_data.hex()}")

    return {
        "version": version,
        "attestationKeyType": ak_type,
        "teeType": tee_type,
        "teeTypeHex": f"0x{tee_type:08x}",
        "qeSvn": qe_svn,
        "pceSvn": pce_svn,
        "qeVendorId": qe_vendor_id.hex(),
        "userData": user_data.hex(),
    }, off


# --------------------------------------------------------------------------
# TD10 report body (584 bytes)
# --------------------------------------------------------------------------

TD10_FIELDS = [
    ("teeTcbSvn", 16),
    ("mrSeam", 48),
    ("mrSignerSeam", 48),
    ("seamAttributes", 8),
    ("tdAttributes", 8),
    ("xFAM", 8),
    ("mrTd", 48),
    ("mrConfigId", 48),
    ("mrOwner", 48),
    ("mrOwnerConfig", 48),
    ("rtMr0", 48),
    ("rtMr1", 48),
    ("rtMr2", 48),
    ("rtMr3", 48),
    ("reportData", 64),
]


def parse_td10_body(b, off):
    start = off
    out = {}
    for name, size in TD10_FIELDS:
        out[name] = b[off:off + size].hex()
        off += size
    consumed = off - start
    assert consumed == 584, f"TD10ReportBody parse consumed {consumed} bytes, expected 584"
    eprint(f"[td10body] consumed {consumed} bytes (expected 584) OK")
    eprint(f"[td10body] mrTd={out['mrTd']}")
    eprint(f"[td10body] rtMr0={out['rtMr0']}")
    eprint(f"[td10body] rtMr1={out['rtMr1']}")
    eprint(f"[td10body] rtMr2={out['rtMr2']}")
    eprint(f"[td10body] rtMr3={out['rtMr3']}")
    eprint(f"[td10body] reportData={out['reportData']}")
    eprint(f"[td10body] reportData[0:20]={out['reportData'][:40]}")
    return out, off


# --------------------------------------------------------------------------
# Quote signature data (variable length, starts with u32 length prefix)
# --------------------------------------------------------------------------

QE_CERT_DATA_TYPE_NAMES = {
    1: "PPID (plain)",
    2: "PPID + PCESVN + PCEID (plain)",
    3: "PPID + PCESVN + PCEID (encrypted, RSA-2048-OAEP)",
    4: "PPID + PCESVN + PCEID (encrypted, RSA-3072-OAEP)",
    5: "PCK Cert Chain (PEM, concatenated leaf/intermediate/root)",
    6: "QE Report Certification Data (nested)",
    7: "PLATFORM_MANIFEST",
}


def parse_signature_data(b, off):
    total_len = len(b)
    sig_len, = struct.unpack_from("<I", b, off)
    off += 4
    sig_data_start = off
    eprint(f"[sigdata] quoteSignatureDataLen={sig_len} starting at offset {sig_data_start}, "
           f"bytes remaining in buffer={total_len - sig_data_start}")

    ecdsa_sig = b[off:off + 64]
    off += 64
    ecdsa_attestation_key = b[off:off + 64]
    off += 64
    eprint(f"[sigdata] ecdsaSignature={ecdsa_sig.hex()}")
    eprint(f"[sigdata] ecdsaAttestationKey={ecdsa_attestation_key.hex()}")

    outer_cert_type, = struct.unpack_from("<H", b, off)
    outer_cert_data_size, = struct.unpack_from("<I", b, off + 2)
    off += 6
    eprint(f"[sigdata] outer certType={outer_cert_type} "
           f"({QE_CERT_DATA_TYPE_NAMES.get(outer_cert_type, 'unknown')}) "
           f"certDataSize={outer_cert_data_size}")

    outer_cert_data = b[off:off + outer_cert_data_size]
    off_after_outer = off + outer_cert_data_size

    # sanity: sig_len should equal everything from sig_data_start to off_after_outer
    declared_end = sig_data_start + sig_len
    eprint(f"[sigdata] computed end offset={off_after_outer}, declared end (start+sigLen)={declared_end} "
           f"{'MATCH' if off_after_outer == declared_end else 'MISMATCH'}")

    result = {
        "ecdsaSignature": ecdsa_sig.hex(),
        "ecdsaAttestationKey": ecdsa_attestation_key.hex(),
        "qeCertDataType": outer_cert_type,
        "qeCertDataTypeDesc": QE_CERT_DATA_TYPE_NAMES.get(outer_cert_type, "unknown"),
        "qeReportRaw": None,
        "qeReportSignature": None,
        "qeAuthData": None,
        "certType": None,
        "certTypeDesc": None,
        "pckCertChainPem": None,
    }

    if outer_cert_type == 6:
        # Nested QEReportCertificationData structure:
        #   Enclave_report qe_report      [384 bytes]
        #   uint8_t qe_report_signature[64]
        #   uint16_t qe_auth_data_size
        #   uint8_t  qe_auth_data[qe_auth_data_size]
        #   uint16_t cert_type            (inner, expect 5 = PCK cert chain PEM)
        #   uint32_t cert_data_size
        #   uint8_t  cert_data[cert_data_size]
        p = 0
        qe_report_raw = outer_cert_data[p:p + 384]
        p += 384
        qe_report_signature = outer_cert_data[p:p + 64]
        p += 64
        qe_auth_data_size, = struct.unpack_from("<H", outer_cert_data, p)
        p += 2
        qe_auth_data = outer_cert_data[p:p + qe_auth_data_size]
        p += qe_auth_data_size

        inner_cert_type, = struct.unpack_from("<H", outer_cert_data, p)
        inner_cert_data_size, = struct.unpack_from("<I", outer_cert_data, p + 2)
        p += 6
        inner_cert_data = outer_cert_data[p:p + inner_cert_data_size]
        p += inner_cert_data_size

        eprint(f"[sigdata][nested] qeReport=384 bytes, qeReportSignature=64 bytes")
        eprint(f"[sigdata][nested] qeAuthDataSize={qe_auth_data_size} qeAuthData={qe_auth_data.hex()}")
        eprint(f"[sigdata][nested] inner certType={inner_cert_type} "
               f"({QE_CERT_DATA_TYPE_NAMES.get(inner_cert_type, 'unknown')}) "
               f"certDataSize={inner_cert_data_size}")
        eprint(f"[sigdata][nested] consumed {p} of {len(outer_cert_data)} outer cert_data bytes "
               f"{'MATCH' if p == len(outer_cert_data) else 'MISMATCH (padding follows)'}")

        pck_pem = None
        if inner_cert_type == 5:
            pck_pem = inner_cert_data.rstrip(b"\x00").decode("utf-8", errors="replace")
            n_certs = pck_pem.count("-----BEGIN CERTIFICATE-----")
            eprint(f"[sigdata][nested] PCK cert chain PEM contains {n_certs} certificates")

        result.update({
            "qeReportRaw": qe_report_raw.hex(),
            "qeReportSignature": qe_report_signature.hex(),
            "qeAuthData": qe_auth_data.hex(),
            "certType": inner_cert_type,
            "certTypeDesc": QE_CERT_DATA_TYPE_NAMES.get(inner_cert_type, "unknown"),
            "pckCertChainPem": pck_pem,
        })
    elif outer_cert_type == 5:
        # Some quotes may skip the QEReportCertificationData nesting and put
        # the PCK cert chain directly at the outer level.
        pck_pem = outer_cert_data.rstrip(b"\x00").decode("utf-8", errors="replace")
        n_certs = pck_pem.count("-----BEGIN CERTIFICATE-----")
        eprint(f"[sigdata] outer cert_data is PCK chain directly, {n_certs} certificates")
        result.update({
            "certType": outer_cert_type,
            "certTypeDesc": QE_CERT_DATA_TYPE_NAMES.get(outer_cert_type, "unknown"),
            "pckCertChainPem": pck_pem,
        })
    else:
        eprint(f"[sigdata] WARNING: unhandled outer certType {outer_cert_type}, "
               f"raw cert_data stored only as hex")
        result["certDataRaw"] = outer_cert_data.hex()

    # trailing bytes after the declared signature data (buffer padding)
    trailing = b[off_after_outer:]
    if trailing:
        non_zero = trailing.strip(b"\x00")
        eprint(f"[sigdata] {len(trailing)} trailing bytes after signature data "
               f"({'all zero padding' if not non_zero else 'NON-ZERO trailing data!'})")

    return result, off_after_outer


# --------------------------------------------------------------------------
# Top level
# --------------------------------------------------------------------------

def parse_quote(b):
    eprint(f"[quote] total length: {len(b)} bytes")
    header, off = parse_header(b)
    body, off = parse_td10_body(b, off)
    sigdata, off = parse_signature_data(b, off)

    summary = {}
    summary.update(header)
    summary["tcbSvn"] = body["teeTcbSvn"]
    summary["mrSeam"] = body["mrSeam"]
    summary["mrSignerSeam"] = body["mrSignerSeam"]
    summary["seamAttributes"] = body["seamAttributes"]
    summary["tdAttributes"] = body["tdAttributes"]
    summary["xFAM"] = body["xFAM"]
    summary["mrTd"] = body["mrTd"]
    summary["mrConfigId"] = body["mrConfigId"]
    summary["mrOwner"] = body["mrOwner"]
    summary["mrOwnerConfig"] = body["mrOwnerConfig"]
    summary["rtMr0"] = body["rtMr0"]
    summary["rtMr1"] = body["rtMr1"]
    summary["rtMr2"] = body["rtMr2"]
    summary["rtMr3"] = body["rtMr3"]
    summary["reportData"] = body["reportData"]
    summary.update(sigdata)
    return summary


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", help="path to .hex file (raw hex text) or .json attestation file")
    ap.add_argument("--field", default="intel_quote", help="JSON field holding the hex quote")
    ap.add_argument("--list-field", default=None,
                     help="if set, JSON field holding a list of dicts (e.g. all_attestations)")
    ap.add_argument("--index", type=int, default=0, help="index into --list-field list")
    ap.add_argument("--out", default=None, help="write JSON summary here (default: stdout)")
    args = ap.parse_args()

    quote_bytes, meta = load_quote_bytes(args.input, args.field, args.list_field, args.index)
    eprint(f"[load] {args.input}: {len(quote_bytes)} bytes loaded, sha256={hashlib.sha256(quote_bytes).hexdigest()}")
    if meta:
        eprint(f"[load] sibling metadata keys: {list(meta.keys())}")

    summary = parse_quote(quote_bytes)
    out_text = json.dumps(summary, indent=2)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(out_text)
        eprint(f"[out] wrote summary to {args.out}")
    else:
        print(out_text)


if __name__ == "__main__":
    main()
