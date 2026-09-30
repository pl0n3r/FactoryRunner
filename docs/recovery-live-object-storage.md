# Recovery live object storage

FactoryRunner #41 conecta el adapter Recovery existente con object storage **S3-compatible** sin mover secretos al contrato de ejecución.

## Límite
`ExecutionOrder/descriptor → connection_ref opaca → resolver runtime → driver S3-compatible → evidencia sanitizada`.

La orden nunca contiene access key, secret key, session token, DSN, URL firmada ni configuración del proveedor. `controlbot:connection/<id>` se resuelve solo desde `FACTORYRUNNER_CONNECTION_<ID>_*`; la credencial temporal S3 opcional usa el sufijo `AWS_SECURITY_TOKEN` y nunca forma parte de la orden ni de la evidencia.

El endpoint debe ser HTTPS/443, hostname público no-IP y sin path/query/credenciales. Bucket, region y prefix quedan fijados por el alias; la orden no puede cambiarlos. El driver usa path-style S3 y AWS Signature V4.

## Artefactos y operaciones
Los bytes no viajan en el descriptor. `RecoveryArtifactSource` entrega el artefacto para upload y `RecoveryArtifactSink` recibe materializaciones verificadas.

- `upload`: HEAD primero; si checksum coincide reutiliza versión, si difiere bloquea, si no existe hace PUT con metadata SHA-256.
- `verify`: HEAD y compara metadata SHA-256.
- `materialize`: GET, verifica SHA-256 y luego entrega bytes al sink.

La evidencia devuelve refs opacas derivadas de version/descriptor; nunca endpoint, bucket, credenciales ni payloads del provider.

## Authority y exclusiones
El adapter existente sigue exigiendo `authority=unchanged` y `execute=false`. No se añaden scheduler, retention deletion, restore/cutover productivo, Google Drive primary, compras ni provisionamiento de credenciales.
