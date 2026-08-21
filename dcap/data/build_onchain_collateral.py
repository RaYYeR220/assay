#!/usr/bin/env python3
"""
Turn the raw Intel PCS artifacts under data/collateral/ into ONE machine-readable
file (data/collateral/onchain.json) that the Foundry deploy script / fork test
reads to populate on-chain PCCS. Keeps the deploy reproducible with no network.

Byte-exactness matters: the Intel signatures are over the exact JSON substrings
of `tcbInfo` / `enclaveIdentity` / `tcbEvaluationDataNumbers`, so those are sliced
out of the raw response text, never re-serialized.
"""
import base64
import glob
import json
import os
import re
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
COL = os.path.join(HERE, "collateral")

CA_ROOT, CA_PROCESSOR, CA_PLATFORM, CA_SIGNING = 0, 1, 2, 3


def read(path, mode="rb"):
    with open(path, mode) as f:
        return f.read()


def pem_to_der(data: bytes) -> bytes:
    txt = data.decode("utf-8", "replace")
    m = re.findall(r"-----BEGIN [A-Z ]+-----(.*?)-----END [A-Z ]+-----", txt, re.S)
    if not m:
        return data  # already DER
    return base64.b64decode("".join(m[0].split()))


def all_pem_ders(txt: str):
    return [
        base64.b64decode("".join(b.split()))
        for b in re.findall(r"-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----", txt, re.S)
    ]


def header_value(path, name):
    raw = read(path).decode("utf-8", "replace")
    for line in raw.splitlines():
        if line.lower().startswith(name.lower() + ":"):
            return urllib.parse.unquote(line.split(":", 1)[1].strip())
    return None


def slice_object(raw_text: str, key: str) -> str:
    """Byte-exact substring of the JSON value for `key` (an object)."""
    needle = '"%s":' % key
    i = raw_text.index(needle) + len(needle)
    while raw_text[i] in " \t\r\n":
        i += 1
    assert raw_text[i] == "{", "expected object for %s" % key
    depth, j, in_str, esc = 0, i, False, False
    while j < len(raw_text):
        ch = raw_text[j]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return raw_text[i:j + 1]
        j += 1
    raise ValueError("unterminated object for %s" % key)


def hx(b: bytes) -> str:
    return "0x" + b.hex()


def cn_of(der: bytes) -> str:
    try:
        from cryptography import x509
        return x509.load_der_x509_certificate(der).subject.rfc4514_string()
    except Exception:
        return ""


def main():
    # --- certificates from the quote's own PCK chain ---
    root_der = pem_to_der(read(os.path.join(COL, "root_ca.der")))
    pck_ca_der = pem_to_der(read(os.path.join(COL, "pck_ca.der")))

    pck_ca_cn = cn_of(pck_ca_der)
    if "Platform" in pck_ca_cn:
        pck_ca, crl_file = CA_PLATFORM, "pckcrl_platform.der"
    elif "Processor" in pck_ca_cn:
        pck_ca, crl_file = CA_PROCESSOR, "pckcrl_processor.der"
    else:
        raise SystemExit("cannot classify PCK CA: %r" % pck_ca_cn)

    pck_crl_der = pem_to_der(read(os.path.join(COL, crl_file)))

    # root CA CRL (may land as PEM or DER depending on endpoint)
    root_crl_path = None
    for cand in ("root_ca.crl.der", "root_ca.crl", "IntelSGXRootCA.der", "root_crl.der"):
        p = os.path.join(COL, cand)
        if os.path.exists(p):
            root_crl_path = p
            break
    if root_crl_path is None:
        raise SystemExit("root CA CRL not found in %s" % COL)
    root_crl_der = pem_to_der(read(root_crl_path))

    # --- TCB signing cert, from the TCB-Info-Issuer-Chain response header ---
    chain = header_value(os.path.join(COL, "headers_tcbinfo.txt"), "TCB-Info-Issuer-Chain")
    if chain is None:
        chain = header_value(os.path.join(COL, "headers_qeidentity.txt"), "SGX-Enclave-Identity-Issuer-Chain")
    if chain is None:
        raise SystemExit("issuer chain header not found")
    chain_ders = all_pem_ders(chain)
    tcb_signing_der = chain_ders[0]
    assert "Intel SGX TCB Signing" in cn_of(tcb_signing_der), cn_of(tcb_signing_der)

    # --- signed JSON collaterals (byte-exact slices) ---
    tcb_files = sorted(glob.glob(os.path.join(COL, "tcbinfo_tdx_*.json")))
    if not tcb_files:
        raise SystemExit("no tcbinfo_tdx_*.json")
    # PRIMARY_FMSPC (the quote we headline with) is uploaded first; every other
    # FMSPC we have collateral for is uploaded too, so a whole TEE committee
    # spread over several platforms verifies against one deployment.
    primary = os.environ.get("PRIMARY_FMSPC", "20a06f000000")
    tcb_files.sort(key=lambda f: (primary not in f, f))

    tcb_strs, tcb_sigs, fmspcs = [], [], []
    for tf in tcb_files:
        raw = read(tf).decode("utf-8")
        s_ = slice_object(raw, "tcbInfo")
        tcb_strs.append(s_)
        tcb_sigs.append(bytes.fromhex(json.loads(raw)["signature"]))
        fmspcs.append(json.loads(s_)["fmspc"].lower())
    tcb_raw = read(tcb_files[0]).decode("utf-8")
    tcb_str = tcb_strs[0]
    tcb_sig = tcb_sigs[0]
    tcb_obj = json.loads(tcb_str)

    qe_raw = read(os.path.join(COL, "qeidentity_tdqe.json")).decode("utf-8")
    qe_str = slice_object(qe_raw, "enclaveIdentity")
    qe_sig = bytes.fromhex(json.loads(qe_raw)["signature"])
    qe_obj = json.loads(qe_str)

    eval_str, eval_sig = "", b""
    ep = os.path.join(COL, "tcbevaldatanumbers_tdx.json")
    if os.path.exists(ep):
        eval_raw = read(ep).decode("utf-8")
        eval_str = slice_object(eval_raw, "tcbEvaluationDataNumbers")
        eval_sig = bytes.fromhex(json.loads(eval_raw)["signature"])

    tcb_eval_num = int(tcb_obj["tcbEvaluationDataNumber"])
    if int(qe_obj["tcbEvaluationDataNumber"]) != tcb_eval_num:
        print(
            "WARNING: tcbInfo evalNum=%s != qeIdentity evalNum=%s -- the versioned DAOs "
            "will reject the mismatched one" % (tcb_eval_num, qe_obj["tcbEvaluationDataNumber"]),
            file=sys.stderr,
        )

    out = {
        "fmspc": "0x" + tcb_obj["fmspc"].lower(),
        "tcbEvaluationDataNumber": tcb_eval_num,
        "pckCa": pck_ca,
        "pckCaCommonName": pck_ca_cn,
        "rootCaDer": hx(root_der),
        "rootCrlDer": hx(root_crl_der),
        "tcbSigningDer": hx(tcb_signing_der),
        "pckCaDer": hx(pck_ca_der),
        "pckCrlDer": hx(pck_crl_der),
        "fmspcs": ["0x" + f for f in fmspcs],
        "tcbInfoStrs": tcb_strs,
        "tcbInfoSigs": [hx(x) for x in tcb_sigs],
        "qeIdentityStr": qe_str,
        "qeIdentitySig": hx(qe_sig),
        "tcbEvalStr": eval_str,
        "tcbEvalSig": hx(eval_sig),
        "_meta": {
            "tcbInfoId": tcb_obj.get("id"),
            "tcbInfoVersion": tcb_obj.get("version"),
            "tcbInfoIssueDate": tcb_obj.get("issueDate"),
            "tcbInfoNextUpdate": tcb_obj.get("nextUpdate"),
            "qeIdentityId": qe_obj.get("id"),
            "qeIdentityVersion": qe_obj.get("version"),
            "qeIdentityNextUpdate": qe_obj.get("nextUpdate"),
            "rootCrlSource": os.path.basename(root_crl_path),
            "pckCrlSource": crl_file,
        },
    }

    dest = os.path.join(COL, "onchain.json")
    with open(dest, "w") as f:
        json.dump(out, f, indent=1)
    print("wrote", dest)
    for k in ("fmspc", "tcbEvaluationDataNumber", "pckCa", "pckCaCommonName"):
        print(" ", k, "=", out[k])
    print("  tcbInfos =", len(tcb_strs), fmspcs)
    print("  tcbInfo bytes =", len(tcb_str), " qeIdentity bytes =", len(qe_str), " tcbEval bytes =", len(eval_str))


if __name__ == "__main__":
    main()
