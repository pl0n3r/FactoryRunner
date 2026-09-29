# Recovery Google Drive cold-copy adapter

FactoryRunner ejecuta Google Drive únicamente como **cold copy** de Recovery. El control plane permanece en Factory/ControlBot y el adapter no decide policy, health, readiness ni autoridad.

## Contrato

Capabilities permitidas:

- `recovery.google-drive.upload`
- `recovery.google-drive.materialize`
- `recovery.google-drive.verify`

El descriptor debe ser Factory Recovery v1 con `provider=google_drive`, `role=cold_copy`, `authority=unchanged` y `execute=false`. La operación debe coincidir con la capability y `descriptor_id` se recalcula de forma determinista.

El driver recibe únicamente `connection_ref` opaca, refs de objeto, checksum, namespace, proyecto e idempotency key. OAuth, service-account JSON, email, shared URLs, provider payloads y campos extra se rechazan antes de llegar al driver.

## Resultado y fallos

Un resultado exitoso conserva exactamente `object_ref` y checksum y añade `remote_version_ref` y `evidence_ref` opacas. Cualquier mismatch o fallo del driver colapsa a `recovery_google_drive_failed`, sin eco de errores del proveedor.

Google Drive nunca se trata como primary offsite. Object storage sigue siendo la copia técnica primaria; iCloud no es provider Recovery admitido.

## Límites

No hay SDK de Google, OAuth real, navegador, red real, scheduler, retries automáticos, DB restore, retention deletion, Recovery Health, pagos ni despliegue productivo en este slice.
