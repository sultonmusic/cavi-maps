"""Create Atlas-only local certificates. Never installs certificates or alters trust."""
import argparse
import datetime as dt
import ipaddress
import json
import pathlib
import socket
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

try:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
except ImportError:
    print('Нужна библиотека cryptography. Выполните: python -m pip install -r scripts/requirements-https.txt')
    sys.exit(1)


def write_private(file, key):
    file.write_bytes(key.private_bytes(serialization.Encoding.PEM,
                                     serialization.PrivateFormat.PKCS8,
                                     serialization.NoEncryption()))
    file.chmod(0o600)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', default='node')
    parser.add_argument('--output-dir', type=pathlib.Path,
                        default=pathlib.Path(__file__).resolve().parents[1] / 'security')
    args = parser.parse_args()
    ips = {'127.0.0.1', '::1'}
    try:
        code = "console.log(JSON.stringify(Object.values(require('node:os').networkInterfaces()).flat().filter(a=>a.family==='IPv4'&&!a.internal).map(a=>a.address)))"
        result = subprocess.run([args.node, '-e', code], check=True, capture_output=True, text=True)
        ips.update(json.loads(result.stdout))
    except (OSError, subprocess.SubprocessError, ValueError):
        ips.update(a[4][0] for a in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET))
    ips = sorted(str(ipaddress.ip_address(ip)) for ip in ips)
    directory = args.output_dir.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    ca_key_file, ca_file = directory / 'atlas-local-ca-key.pem', directory / 'atlas-local-ca.crt'
    server_key_file, server_file = directory / 'server-key.pem', directory / 'server-cert.pem'
    now = dt.datetime.now(dt.timezone.utc)
    if ca_key_file.exists() != ca_file.exists():
        raise ValueError('Неполная пара файлов CA в security. Восстановите оба файла из локальной копии либо переместите папку security и создайте новую пару.')
    if ca_file.exists():
        ca_key = serialization.load_pem_private_key(ca_key_file.read_bytes(), password=None)
        ca = x509.load_pem_x509_certificate(ca_file.read_bytes())
        if ca.public_key().public_numbers() != ca_key.public_key().public_numbers():
            raise ValueError('Сертификат CA не соответствует закрытому ключу.')
        if ca.not_valid_after_utc < now + dt.timedelta(days=100):
            raise ValueError('Сертификат CA скоро истечёт. Переместите security, запустите HTTPS.cmd и заново настройте доверие.')
    else:
        ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Atlas Local CA')])
        ca = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
              .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
              .not_valid_before(now - dt.timedelta(minutes=5)).not_valid_after(now + dt.timedelta(days=1825))
              .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
              .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False,
                             key_encipherment=False, data_encipherment=False, key_agreement=False,
                             key_cert_sign=True, crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
              .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
              .sign(ca_key, hashes.SHA256()))
        write_private(ca_key_file, ca_key)
        ca_file.write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    refresh = True
    if server_file.exists() and server_key_file.exists():
        try:
            server = x509.load_pem_x509_certificate(server_file.read_bytes())
            server_key = serialization.load_pem_private_key(server_key_file.read_bytes(), password=None)
            names = server.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            refresh = (set(str(ip) for ip in names.get_values_for_type(x509.IPAddress)) != set(ips)
                       or server.not_valid_after_utc < now + dt.timedelta(days=14)
                       or server.public_key().public_numbers() != server_key.public_key().public_numbers())
            server.verify_directly_issued_by(ca)
        except (ValueError, TypeError, x509.ExtensionNotFound):
            refresh = True
    if refresh:
        server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        server = (x509.CertificateBuilder()
                  .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')]))
                  .issuer_name(ca.subject).public_key(server_key.public_key())
                  .serial_number(x509.random_serial_number())
                  .not_valid_before(now - dt.timedelta(minutes=5)).not_valid_after(now + dt.timedelta(days=90))
                  .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                  .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')] +
                                 [x509.IPAddress(ipaddress.ip_address(ip)) for ip in ips]), critical=False)
                  .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
                  .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False,
                                 key_encipherment=True, data_encipherment=False, key_agreement=False,
                                 key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
                  .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
                  .sign(ca_key, hashes.SHA256()))
        write_private(server_key_file, server_key)
        server_file.write_bytes(server.public_bytes(serialization.Encoding.PEM))
    print('Локальные сертификаты готовы. Доверие системы не изменялось.')
    print('Адреса сертификата: localhost, ' + ', '.join(ips))
    print('На телефон передайте только: ' + str(ca_file))
    print('Отпечаток CA SHA-256: ' + ca.fingerprint(hashes.SHA256()).hex(':').upper())
    print('Закрытые ключи в security остаются на этом компьютере и не включаются в ZIP.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Не удалось создать сертификаты: ' + str(error), file=sys.stderr)
        sys.exit(1)
