#!/usr/bin/env python3
"""Regenera copias exactas para revisión jurídica, sin aprobar su contenido."""
from __future__ import annotations
import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "revision-juridica"
SOURCES = (
    "aviso-privacidad.md", "canal-derechos.md", "politica-tratamiento.md",
    "registro-tratamientos.md", "retencion.md", "terminos-condiciones.md",
)
STAMP = re.compile(
    r"Última actualización automática: (\d{4}-\d{2}-\d{2}) UTC"
    r" · SHA de origen de docs/privacidad: ([0-9a-f]{40})"
)

def tree_sha() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD:docs/privacidad"],
        cwd=ROOT, capture_output=True, text=True, timeout=15, check=True,
    )
    sha = result.stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("SHA de fuentes inválido")
    return sha

def generation_date(check: bool) -> str:
    if not check:
        return datetime.now(timezone.utc).date().isoformat()
    heading = (OUT / "00-LEEME.md").read_text(encoding="utf-8").splitlines()[0]
    match = STAMP.fullmatch(heading)
    if not match:
        raise ValueError("Fecha/SHA de generación no canónicos")
    datetime.strptime(match.group(1), "%Y-%m-%d")
    return match.group(1)

def expected_files(date: str) -> dict[str, bytes]:
    data = json.loads((ROOT / "datos.yml").read_text(encoding="utf-8"))
    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    if data["project"] != "pl0n3r/FactoryRunner" or data["phase"] != "construccion":
        raise ValueError("Contexto de privacidad/fase inesperado")
    treatments = data["treatments"]
    if not isinstance(treatments, list):
        raise ValueError("Inventario de tratamientos inválido")
    declared = set()
    for treatment in treatments:
        providers = treatment["providers"]
        if not isinstance(providers, list) or any(not isinstance(p, str) for p in providers):
            raise ValueError("Proveedores inválidos")
        declared.update(providers)
    provider_text = ", ".join(sorted(declared)) if declared else "ninguno declarado"
    sha = tree_sha()
    index = f"""Última actualización automática: {date} UTC · SHA de origen de docs/privacidad: {sha}

# Carpeta para revisión jurídica · FactoryRunner

**Estado literal:** documented_not_legally_approved.
**Producto:** pl0n3r/FactoryRunner · **Versión del repo:** {version} (package.json).
**Origen verificable:** árbol Git docs/privacidad con SHA {sha}; no es el SHA de un commit completo.

**Para entregar:** toma estos seis archivos o paquete-completo.md y envíalos al abogado.
Son borradores técnicos; la revisión y aprobación jurídica siguen pendientes. No autorizan go-live.

## Índice de documentos y revisión solicitada

| Copia local | Fuente exacta | Validar o corregir |
| --- | --- | --- |
| aviso-privacidad.md | docs/privacidad/aviso-privacidad.md | Aviso, transparencia y consentimiento |
| canal-derechos.md | docs/privacidad/canal-derechos.md | Canal, procedimiento y plazos |
| politica-tratamiento.md | docs/privacidad/politica-tratamiento.md | Bases, finalidades, derechos y proveedores |
| registro-tratamientos.md | docs/privacidad/registro-tratamientos.md | Inventario de datos y tratamientos |
| retencion.md | docs/privacidad/retencion.md | Plazos y eliminación de datos |
| terminos-condiciones.md | docs/privacidad/terminos-condiciones.md | Condiciones y límites del servicio |
| paquete-completo.md | Índice más las seis fuentes íntegras | Entrega consolidada |

## Hechos pendientes del responsable (no se inventan datos)

- [ ] Razón social o nombre del responsable
- [ ] Número de identificación / NIT aplicable
- [ ] Dirección física y domicilio de notificaciones
- [ ] Contacto para el ejercicio de derechos
- [ ] Procedimiento, requisitos y plazos de solicitudes
- [ ] Bases jurídicas, consentimiento, retención y transferencias
- [ ] Condiciones del servicio, jurisdicción y garantías

## Proveedores/subprocesadores documentados

Según datos.yml, tratamiento runner_location_metadata: campo location,
finalidad runner_routing. **Proveedores declarados: {provider_text}**.
La ausencia de un proveedor declarado no prueba ausencia de subprocesadores reales.

AGENTES.md identifica a ControlBot como plano de control interno y a Hostinger
Shared/Web Hosting como objetivo de infraestructura. Esa arquitectura no demuestra
que un tercero ya procese datos, ni que exista despliegue o contrato de servicios.
El abogado debe verificarlo; no se añaden proveedores supuestos.

## Sincronización

scripts/generar_revision_juridica.py copia los seis documentos byte por byte y
genera el índice y el paquete. --check verifica sin escribir. Un workflow revisa
los cambios y abre un Issue único de desfase, sin escribir en main.

**Fase declarada:** construccion. **Estado jurídico:** pendiente de revisión.
"""
    files = {
        name: (ROOT / "docs" / "privacidad" / name).read_bytes()
        for name in SOURCES
    }
    bundle = (
        "# Paquete completo de revisión jurídica · FactoryRunner\n\n"
        "Estado: documented_not_legally_approved. Contiene índice y fuentes íntegras.\n\n"
        "## Índice de entrega\n\n"
    ).encode("utf-8") + index.encode("utf-8") + b"\n"
    for name in SOURCES:
        content = files[name]
        bundle += ("## Fuente: docs/privacidad/" + name + "\n\n").encode("utf-8")
        bundle += content + (b"\n" if content.endswith(b"\n") else b"\n\n")
    return {"00-LEEME.md": index.encode("utf-8"), **files, "paquete-completo.md": bundle}

def run(check: bool) -> int:
    try:
        expected = expected_files(generation_date(check))
        if check:
            if not OUT.is_dir() or OUT.is_symlink():
                print("Carpeta jurídica no disponible", file=sys.stderr)
                return 1
            if {p.name for p in OUT.iterdir()} != set(expected):
                print("Inventario jurídico desactualizado", file=sys.stderr)
                return 1
            for name, content in expected.items():
                p = OUT / name
                if p.is_symlink() or not p.is_file() or p.read_bytes() != content:
                    print("Desfase jurídico: " + name, file=sys.stderr)
                    return 1
            print("Paquete jurídico sincronizado")
            return 0
        if OUT.is_symlink():
            raise ValueError("Directorio de salida simbólico")
        OUT.mkdir(exist_ok=True)
        for name, content in expected.items():
            p = OUT / name
            if p.is_symlink():
                raise ValueError("Destino simbólico: " + name)
            if not p.exists() or p.read_bytes() != content:
                p.write_bytes(content)
        print("Paquete jurídico generado")
        return 0
    except (OSError, ValueError, KeyError, TypeError, IndexError, subprocess.SubprocessError) as exc:
        print("No se pudo verificar el paquete: " + str(exc), file=sys.stderr)
        return 2

if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--check", action="store_true", help="Solo comprobar, nunca escribir")
    sys.exit(run(cli.parse_args().check))
