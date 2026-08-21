#!/usr/bin/env python
"""
build_manifest.py -- finish processing the raw Intel PCS collateral fetched
into ./collateral/:
  - URL-decode the *-Issuer-Chain response headers into PEM files
  - Convert the SGX Root CA CRL from PEM to DER
  - Extract the byte-exact "tcbInfo" / "enclaveIdentity" substrings (and
    their signatures) from the raw JSON response bodies (NOT via
    json.dumps/re-serialization -- the on-chain signature is over the exact
    original bytes)
  - Emit collateral/manifest.json with sha256 + hex for every artifact, for
    Foundry tests to consume without network access.
"""
import os
import re
import json
import hashlib
import urllib.parse
import base64

HERE = os.path.dirname(os.path.abspath(__file__))
COL = os.path.join(HERE, "collateral")


def sha256_hex(b):
    return hashlib.sha256(b).hexdigest()


def read_bytes(name):
    with open(os.path.join(COL, name), "rb") as f:
        return f.read()


def write_bytes(name, b):
    with open(os.path.join(COL, name), "wb") as f:
        f.write(b)


def write_text(name, s):
    with open(os.path.join(COL, name), "w", encoding="utf-8", newline="") as f:
        f.write(s)


def extract_header_value(header_file, header_name):
    """Headers were captured with curl -D; a header value may itself contain
    literal newlines that curl does NOT fold (Intel sends the PEM chain as a
    single header line with embedded %0A for real newlines, all on one
    physical line). We just grab everything from 'HeaderName:' to the end of
    that logical line."""
    with open(os.path.join(COL, header_file), "r", encoding="utf-8") as f:
        text = f.read()
    m = re.search(rf"^{re.escape(header_name)}:\s*(.*)$", text, re.MULTILINE)
    if not m:
        raise ValueError(f"{header_name} not found in {header_file}")
    return urllib.parse.unquote(m.group(1).strip())


def find_json_substring(raw_text, key):
    """Locate the byte-exact substring of raw_text that is the value for
    "key": ... at the top level, by scanning brace/bracket depth rather than
    re-serializing (json.dumps could reorder keys / change whitespace and
    would break the Ed25519/ECDSA signature verification which is computed
    over the exact original bytes)."""
    marker = f'"{key}"'
    idx = raw_text.index(marker)
    colon = raw_text.index(":", idx + len(marker))
    p = colon + 1
    while raw_text[p] in " \t\r\n":
        p += 1
    start = p
    if raw_text[p] != "{":
        raise ValueError(f"expected object value for {key}")
    depth = 0
    in_string = False
    escape = False
    end = None
    for i in range(p, len(raw_text)):
        c = raw_text[i]
        if in_string:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == '"':
                in_string = False
        else:
            if c == '"':
                in_string = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
    if end is None:
        raise ValueError(f"unterminated object for {key}")
    return raw_text[start:end]


def find_json_string_value(raw_text, key):
    marker = f'"{key}"'
    idx = raw_text.index(marker)
    colon = raw_text.index(":", idx + len(marker))
    p = colon + 1
    while raw_text[p] in " \t\r\n":
        p += 1
    assert raw_text[p] == '"'
    j = p + 1
    while raw_text[j] != '"':
        if raw_text[j] == "\\":
            j += 1
        j += 1
    return raw_text[p + 1:j]


def main():
    manifest = {"artifacts": {}}

    def add_artifact(key, filename, url, content_bytes=None):
        if content_bytes is None:
            content_bytes = read_bytes(filename)
        manifest["artifacts"][key] = {
            "filename": filename,
            "url": url,
            "sha256": sha256_hex(content_bytes),
            "size": len(content_bytes),
        }
        return content_bytes

    # ---- 1. URL-decode issuer chain headers -> PEM files ----
    tcb_chain_pem = extract_header_value("headers_tcbinfo.txt", "TCB-Info-Issuer-Chain")
    write_text("tcb_signing_chain.pem", tcb_chain_pem)
    print(f"[write] tcb_signing_chain.pem ({len(tcb_chain_pem)} chars, "
          f"{tcb_chain_pem.count('BEGIN CERTIFICATE')} certs)")

    qe_chain_pem = extract_header_value("headers_qeidentity.txt", "SGX-Enclave-Identity-Issuer-Chain")
    write_text("qe_identity_issuer_chain.pem", qe_chain_pem)
    print(f"[write] qe_identity_issuer_chain.pem ({qe_chain_pem.count('BEGIN CERTIFICATE')} certs)")

    pck_crl_platform_chain_pem = extract_header_value("headers_pckcrl_platform.txt", "SGX-PCK-CRL-Issuer-Chain")
    write_text("pck_crl_platform_issuer_chain.pem", pck_crl_platform_chain_pem)
    print(f"[write] pck_crl_platform_issuer_chain.pem ({pck_crl_platform_chain_pem.count('BEGIN CERTIFICATE')} certs)")

    pck_crl_processor_chain_pem = extract_header_value("headers_pckcrl_processor.txt", "SGX-PCK-CRL-Issuer-Chain")
    write_text("pck_crl_processor_issuer_chain.pem", pck_crl_processor_chain_pem)
    print(f"[write] pck_crl_processor_issuer_chain.pem ({pck_crl_processor_chain_pem.count('BEGIN CERTIFICATE')} certs)")

    # The TCB signing chain's *first* cert is the "Intel SGX TCB Signing" cert
    # (the direct issuer of tcbInfo/enclaveIdentity signatures); the second is
    # the Intel SGX Root CA (self-signed). Split them out.
    from cryptography import x509
    def split_pem_chain(pem_text):
        certs, cur, in_cert = [], [], False
        for line in pem_text.splitlines():
            if "BEGIN CERTIFICATE" in line:
                in_cert = True; cur = [line]
            elif "END CERTIFICATE" in line:
                cur.append(line); certs.append("\n".join(cur) + "\n"); in_cert = False
            elif in_cert:
                cur.append(line)
        return certs

    tcb_chain_certs = split_pem_chain(tcb_chain_pem)
    tcb_signing_pem = tcb_chain_certs[0]
    write_text("tcb_signing_ca.pem", tcb_signing_pem)
    tcb_signing_der = x509.load_pem_x509_certificate(tcb_signing_pem.encode()).public_bytes(
        __import__("cryptography.hazmat.primitives.serialization", fromlist=["Encoding"]).Encoding.DER)
    write_bytes("tcb_signing_ca.der", tcb_signing_der)
    print(f"[write] tcb_signing_ca.pem / .der ({len(tcb_signing_der)} bytes)")

    # ---- 2. Root CA CRL: PEM -> DER ----
    root_crl_pem_bytes = read_bytes("root_ca.crl")
    from cryptography import x509 as x509mod
    root_crl_obj = x509mod.load_pem_x509_crl(root_crl_pem_bytes)
    from cryptography.hazmat.primitives import serialization
    root_crl_der = root_crl_obj.public_bytes(serialization.Encoding.DER)
    write_bytes("root_ca.crl.der", root_crl_der)
    print(f"[write] root_ca.crl.der ({len(root_crl_der)} bytes, from PEM {len(root_crl_pem_bytes)} bytes)")

    # ---- 3. Byte-exact tcbInfo / enclaveIdentity substrings ----
    tcbinfo_raw = read_bytes("tcbinfo_tdx_20a06f000000.json").decode("utf-8")
    qeidentity_raw = read_bytes("qeidentity_tdqe.json").decode("utf-8")

    tcb_info_json_string = find_json_substring(tcbinfo_raw, "tcbInfo")
    tcb_info_signature = find_json_string_value(tcbinfo_raw, "signature")
    # sanity: re-parse the extracted substring and compare a few fields against
    # the full json.loads result
    reparsed = json.loads(tcb_info_json_string)
    full = json.loads(tcbinfo_raw)
    assert reparsed == full["tcbInfo"], "tcbInfo substring extraction mismatch!"
    assert tcb_info_signature == full["signature"]
    print(f"[extract] tcbInfo substring: {len(tcb_info_json_string)} bytes, "
          f"id={reparsed['id']} version={reparsed['version']} "
          f"tcbEvaluationDataNumber={reparsed['tcbEvaluationDataNumber']}")

    qe_identity_json_string = find_json_substring(qeidentity_raw, "enclaveIdentity")
    qe_identity_signature = find_json_string_value(qeidentity_raw, "signature")
    reparsed_qe = json.loads(qe_identity_json_string)
    full_qe = json.loads(qeidentity_raw)
    assert reparsed_qe == full_qe["enclaveIdentity"]
    assert qe_identity_signature == full_qe["signature"]
    print(f"[extract] enclaveIdentity substring: {len(qe_identity_json_string)} bytes, "
          f"id={reparsed_qe['id']} version={reparsed_qe['version']} "
          f"tcbEvaluationDataNumber={reparsed_qe['tcbEvaluationDataNumber']}")

    # ---- 4. Register all artifacts (raw fetched files + derived files) ----
    add_artifact("pckLeaf", "pck_leaf.der", "(derived from deepseek quote's embedded PCK cert chain, certType=5)")
    add_artifact("pckCa", "pck_ca.der", "(derived from deepseek quote's embedded PCK cert chain, certType=5)")
    add_artifact("rootCa", "root_ca.der", "(derived from deepseek quote's embedded PCK cert chain, certType=5)")
    add_artifact("rootCaFetched", "intel_root_ca.der", "https://certificates.trustedservices.intel.com/IntelSGXRootCA.der")
    add_artifact("rootCrlPem", "root_ca.crl", "https://certificates.trustedservices.intel.com/IntelSGXRootCA.crl")
    add_artifact("rootCrlDer", "root_ca.crl.der", "https://certificates.trustedservices.intel.com/IntelSGXRootCA.crl (converted from PEM)")
    add_artifact("tcbInfoJson", "tcbinfo_tdx_20a06f000000.json",
                 "https://api.trustedservices.intel.com/tdx/certification/v4/tcb?fmspc=20a06f000000")
    add_artifact("qeIdentityJson", "qeidentity_tdqe.json",
                 "https://api.trustedservices.intel.com/tdx/certification/v4/qe/identity?id=TD_QE")
    add_artifact("pckCrlPlatformDer", "pckcrl_platform.der",
                 "https://api.trustedservices.intel.com/sgx/certification/v4/pckcrl?ca=platform&encoding=der")
    add_artifact("pckCrlProcessorDer", "pckcrl_processor.der",
                 "https://api.trustedservices.intel.com/sgx/certification/v4/pckcrl?ca=processor&encoding=der")
    add_artifact("tcbSigningChainPem", "tcb_signing_chain.pem", "(from TCB-Info-Issuer-Chain response header, URL-decoded)")
    add_artifact("tcbSigningCaDer", "tcb_signing_ca.der", "(first cert of TCB-Info-Issuer-Chain header, DER)")
    add_artifact("qeIdentityIssuerChainPem", "qe_identity_issuer_chain.pem",
                 "(from SGX-Enclave-Identity-Issuer-Chain response header, URL-decoded)")
    add_artifact("pckCrlPlatformIssuerChainPem", "pck_crl_platform_issuer_chain.pem",
                 "(from SGX-PCK-CRL-Issuer-Chain response header for ca=platform, URL-decoded)")
    add_artifact("pckCrlProcessorIssuerChainPem", "pck_crl_processor_issuer_chain.pem",
                 "(from SGX-PCK-CRL-Issuer-Chain response header for ca=processor, URL-decoded)")

    # ---- 5. Hex payloads for Foundry ----
    manifest["hex"] = {
        "rootCaDer": read_bytes("root_ca.der").hex(),
        "rootCaFetchedDer": read_bytes("intel_root_ca.der").hex(),
        "rootCrlDer": read_bytes("root_ca.crl.der").hex(),
        "pckCaDer": read_bytes("pck_ca.der").hex(),
        "pckCrlDer": read_bytes("pckcrl_platform.der").hex(),  # PCK CA kind = Platform CA (see report)
        "pckCrlPlatformDer": read_bytes("pckcrl_platform.der").hex(),
        "pckCrlProcessorDer": read_bytes("pckcrl_processor.der").hex(),
        "pckLeafDer": read_bytes("pck_leaf.der").hex(),
        "tcbSigningCaDer": tcb_signing_der.hex(),
        "tcbInfoJson": tcbinfo_raw.encode("utf-8").hex(),
        "qeIdentityJson": qeidentity_raw.encode("utf-8").hex(),
    }

    # ---- 6. Byte-exact tcbInfo/enclaveIdentity strings + signatures ----
    manifest["onchain"] = {
        "tcbInfoTcbInfoJsonString": tcb_info_json_string,
        "tcbInfoSignature": tcb_info_signature,
        "qeIdentityEnclaveIdentityJsonString": qe_identity_json_string,
        "qeIdentitySignature": qe_identity_signature,
        "tcbInfo_id": reparsed["id"],
        "tcbInfo_version": reparsed["version"],
        "tcbInfo_tcbEvaluationDataNumber": reparsed["tcbEvaluationDataNumber"],
        "tcbInfo_fmspc": reparsed["fmspc"],
        "qeIdentity_id": reparsed_qe["id"],
        "qeIdentity_version": reparsed_qe["version"],
        "qeIdentity_tcbEvaluationDataNumber": reparsed_qe["tcbEvaluationDataNumber"],
    }

    with open(os.path.join(COL, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"\n[write] manifest.json ({len(manifest['artifacts'])} artifacts registered)")


if __name__ == "__main__":
    main()
