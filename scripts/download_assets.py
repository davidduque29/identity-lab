"""Descarga los assets originales y verifica su SHA-256, sin dependencias externas."""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parent.parent

def main():
    assets = json.loads((ROOT / 'scripts/assets.json').read_text())
    for asset in assets:
        target = ROOT / asset['path']
        expected = asset['sha256']
        if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == expected:
            print('Verificado:', asset['path'])
            continue
        print('Descargando:', asset['path'])
        with urllib.request.urlopen(asset['url'], timeout=60) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != expected:
            raise RuntimeError('Integridad incorrecta: ' + asset['path'] + '. No se instalará el archivo.')
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + '.download')
        temporary.write_bytes(data)
        temporary.replace(target)
    print('Assets listos. Ejecuta: python -m http.server 8000 --directory dist')

if __name__ == '__main__':
    main()

