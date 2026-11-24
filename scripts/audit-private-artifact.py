"""Data-only handoff of a Pages build between isolated CI jobs.
The public intermediate artifact is authenticated ciphertext, never a raw build.
The main-only receiver validates, scans, and extracts regular files without running
any candidate JavaScript, shell code, dependency installer, or archive hooks.
"""
import base64
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile

MAX_FILE = 30 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024
MAX_ARCHIVE = MAX_TOTAL + 4 * 1024 * 1024
MAX_COUNT = 1000
NAME = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_][A-Za-z0-9_.-]*)*\Z')
TEXT = re.compile(r'\.(html|css|js|mjs|json|svg|txt|map)$', re.I)


def check(ok):
    if not ok:
        raise ValueError('private artifact validation failed')


def secret(name):
    value = os.environ.get(name, '')
    check(0 < len(value) <= 65536)
    raw = base64.b64decode(value, validate=True)
    check(base64.b64encode(raw).decode('ascii') == value)
    return raw


def openssl(*args):
    # Do not inherit the dictionary or key in subprocesses.
    env = {k: v for k, v in os.environ.items() if k not in
           ('PAYROLL_PRIVATE_TERMS_B64', 'PAYROLL_AUDIT_ARTIFACT_KEY_B64')}
    binary = os.environ.get('PAYROLL_AUDIT_OPENSSL', 'openssl')
    subprocess.run([binary, *args], check=True, env=env,
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)


def valid_name(name):
    return len(name) <= 512 and NAME.fullmatch(name) is not None


def seal(source, output):
    check(source.is_dir() and not source.is_symlink() and not output.exists())
    with tempfile.TemporaryDirectory() as directory:
        tmp = Path(directory)
        cert = tmp / 'cert.pem'
        cert.write_bytes(secret('PAYROLL_AUDIT_CERT_B64'))
        archive = tmp / 'build.tar'
        total = count = 0
        with tarfile.open(archive, 'w', format=tarfile.PAX_FORMAT) as tar:
            for current, dirs, files in os.walk(source, followlinks=False):
                for name in dirs:
                    p = Path(current) / name
                    check(not p.is_symlink() and p.is_dir())
                for name in sorted(files):
                    p = Path(current) / name
                    rel = p.relative_to(source).as_posix()
                    check(valid_name(rel) and p.is_file() and not p.is_symlink())
                    size = p.stat().st_size
                    count += 1
                    total += size
                    check(0 < size <= MAX_FILE and total <= MAX_TOTAL and count <= MAX_COUNT)
                    info = tarfile.TarInfo(rel)
                    info.size = size
                    info.mode = 0o644
                    with p.open('rb') as stream:
                        tar.addfile(info, stream)
        check(count > 0 and archive.stat().st_size <= MAX_ARCHIVE)
        sealed = tmp / 'build.cms'
        openssl('cms', '-encrypt', '-binary', '-aes-256-gcm', '-in', str(archive),
                '-outform', 'DER', '-out', str(sealed), '-recip', str(cert),
                '-keyopt', 'rsa_padding_mode:oaep', '-keyopt', 'rsa_oaep_md:sha256')
        check(sealed.stat().st_size <= MAX_ARCHIVE)
        # No plaintext is copied to the public artifact directory.
        with sealed.open('rb') as src, output.open('xb') as dst:
            while chunk := src.read(1024 * 1024):
                dst.write(chunk)
    print('[PASS] Encrypted intermediate Pages artifact')


def audit_open(cipher, target, digest):
    check(cipher.is_file() and not cipher.is_symlink() and not target.exists())
    check(0 < cipher.stat().st_size <= MAX_ARCHIVE and re.fullmatch(r'[a-f0-9]{64}', digest))
    check(hashlib.sha256(cipher.read_bytes()).hexdigest() == digest)
    terms = [line.strip().lower() for line in secret('PAYROLL_PRIVATE_TERMS_B64').decode('utf-8-sig').splitlines()
             if len(line.strip().encode('utf-16-le')) // 2 >= 3 and not line.strip().startswith('#')]
    check(bool(terms))
    with tempfile.TemporaryDirectory(dir=target.parent) as directory:
        tmp = Path(directory)
        key = tmp / 'key.pem'
        key.write_bytes(secret('PAYROLL_AUDIT_ARTIFACT_KEY_B64'))
        key.chmod(0o600)
        archive = tmp / 'build.tar'
        openssl('cms', '-decrypt', '-binary', '-inform', 'DER', '-in', str(cipher),
                '-inkey', str(key), '-out', str(archive))
        key.unlink()
        check(0 < archive.stat().st_size <= MAX_ARCHIVE)
        out = tmp / 'validated'
        out.mkdir()
        total = count = 0
        seen = set()
        with tarfile.open(archive, 'r:') as tar:
            for item in tar:
                name = item.name
                count += 1
                total += item.size
                check(item.isreg() and not item.sparse and valid_name(name) and name not in seen)
                check(0 < item.size <= MAX_FILE and count <= MAX_COUNT and total <= MAX_TOTAL)
                seen.add(name)
                check(not any(term in name.lower() for term in terms))
                stream = tar.extractfile(item)
                check(stream is not None)
                data = stream.read(MAX_FILE + 1)
                check(len(data) == item.size)
                if TEXT.search(name):
                    body = data.decode('utf8').lower()
                    check(not any(term in body for term in terms))
                dest = out / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                with dest.open('xb') as handle:
                    handle.write(data)
        check(count > 0 and 'index.html' in seen)
        # Publish only after EVERY file and path has passed. On any failure the
        # staging directory and decrypted tar disappear without an upload.
        out.rename(target)
    print(f'[PASS] Private artifact audit: {count} files')


if __name__ == '__main__':
    try:
        if len(sys.argv) == 4 and sys.argv[1] == 'seal':
            seal(Path(sys.argv[2]), Path(sys.argv[3]))
        elif len(sys.argv) == 5 and sys.argv[1] == 'audit-open':
            audit_open(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4])
        else:
            raise ValueError('invalid mode')
    except Exception:
        # Never print a dictionary match, filename, key, or subprocess output.
        print('[FAIL] Private artifact operation rejected (details redacted)', file=sys.stderr)
        sys.exit(1)
