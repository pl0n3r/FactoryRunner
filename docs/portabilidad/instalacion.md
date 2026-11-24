# FactoryRunner: bootstrap portátil **sintético/offline** (#717)

Este es un ensayo de preparación, no una instalación de FactoryRunner en producción.
`start` **no lanza** procesos, contenedores, listeners ni scheduler: solo registra
`SIMULATED_ACTIVE` en un estado desechable. Nunca establece READY ni conexión a
ControlBot, Hostinger o cuentas. El estado durable permanece en ControlBot.

## Requisitos y sandbox

- Node.js **24**, Git y un checkout local existente. Docker/WSL2 no son requisitos
  para **el ensayo**; cualquier adapter real faltante queda `UNAVAILABLE/UNKNOWN`.
- Crear fuera del repo, solo en el directorio temporal del sistema, un sandbox
  **privado** por `mktemp -d /tmp/factoryrunner-offline-XXXXXX` (Linux/macOS),
  o el equivalente temporal en WSL2. No reutilizar directorios con datos reales.
- El workspace permitido es **exactamente** `<sandbox>/runner`; dentro de
  `<sandbox>/releases` se escribe antes un fixture local JSON de tres campos:
  `{"schema_version":1,"kind":"OFFLINE_FIXTURE","version":"1.0.0"}`.
  Guardarlo como `release-1.0.0.json` y calcular SHA-256 del **archivo exacto**.
  El script no crea ni descarga assets ni acepta hash implícito.

## Operaciones (sustituir las rutas por absolutas bajo el mismo sandbox)

```sh
node --experimental-strip-types scripts/portable-preflight.ts
node --experimental-strip-types scripts/portable-bootstrap.ts doctor --workspace "$SANDBOX/runner"
node --experimental-strip-types scripts/portable-bootstrap.ts install --workspace "$SANDBOX/runner" --artifact "$SANDBOX/releases/release-1.0.0.json" --sha "$SHA256"
node --experimental-strip-types scripts/portable-bootstrap.ts status --workspace "$SANDBOX/runner"
node --experimental-strip-types scripts/portable-bootstrap.ts start --workspace "$SANDBOX/runner"
node --experimental-strip-types scripts/portable-bootstrap.ts stop --workspace "$SANDBOX/runner"
node --experimental-strip-types scripts/portable-bootstrap.ts update --workspace "$SANDBOX/runner" --artifact "$SANDBOX/releases/release-1.0.1.json" --sha "$SHA256_NEXT"
node --experimental-strip-types scripts/portable-bootstrap.ts rollback --workspace "$SANDBOX/runner"
```

`install`/`start`/`stop` y actualización del mismo SHA son idempotentes.
La actualización exige versión semver superior compatible y `STOPPED`;
`rollback` restaura solo la revisión anterior y exige `STOPPED`. Cualquier
SHA incorrecto, manifiesto alterado, path fuera de sandbox, symlink, lock ocupado,
Node no compatible, host no reconocido o estado corrupto falla cerrado con un
código estable, **sin imprimir entradas crudas**, sin borrar datos ajenos.
Solo el fixture temporal se destruye manualmente tras la prueba.

## Compatibilidad y evidencia

CI en Ubuntu Linux x64/Node 24 prueba CLI, tests, typecheck y build; ello **no**
certifica instalación real. macOS Intel/ARM, Linux ARM64 y Windows vía WSL2 solo
están documentados, **NO ACREDITADOS** con matriz real. Windows nativo no se
asume compatible. En ningún caso se modifican perfiles, HOME, permisos del host,
instalaciones globales, repos Git, contenedores o datos reales. Para recuperación
durable, nuevo `runner_id`, backup cifrado y fencing se requieren #718/#607 y
las puertas humanas/operativas separadas de #711, #465/#606. Reversión del cambio
de código: squash revert del PR, sin tocar los workspaces de terceros.
