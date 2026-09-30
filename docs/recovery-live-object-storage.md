# Recovery live object storage

FactoryRunner conecta el adapter Recovery existente con object storage **S3-compatible** sin mover secretos al contrato de ejecución.

## Límite

`ExecutionOrder/descriptor → connection_ref opaca → resolver runtime → preflight bucket → driver S3-compatible → evidencia sanitizada`.

La orden nunca contiene access key, secret key, session token, DSN, URL firmada ni configuración del proveedor. `controlbot:connection/<id>` se resuelve solo desde `FACTORYRUNNER_CONNECTION_<ID>_*`; la credencial temporal S3 opcional usa el sufijo `AWS_SECURITY_TOKEN` y nunca forma parte de la orden ni de la evidencia.

El endpoint debe ser HTTPS/443, hostname público no-IP y sin path/query/credenciales. Bucket, region y prefix quedan fijados por el alias; la orden no puede cambiarlos. El driver usa path-style S3 y AWS Signature V4.

## Preflight del bucket

Antes de cualquier `upload`, `verify` o `materialize`, el driver hace dos lecturas S3 firmadas y read-only sobre el bucket configurado:

1. `GET ?versioning` debe devolver exactamente `Status=Enabled`.
2. `GET ?object-lock` debe devolver exactamente `ObjectLockEnabled=Enabled`.

Ausencia, `Suspended`, valor desconocido, XML ambiguo/inválido, respuesta no-2xx o proveedor incompatible bloquean la operación antes de tocar objetos. El preflight exitoso se cachea solo en memoria dentro de esa instancia del driver; una instancia nueva vuelve a verificar. No se persiste un estado de confianza y la evidencia de objetos anterior nunca sustituye el preflight actual.

El parser limita tamaño y estructura del XML y no incorpora payloads del proveedor a resultados o errores. El código no contiene branching por proveedor: endpoint, región, bucket y alias siguen siendo configuración runtime.

## Artefactos y operaciones

Los bytes no viajan en el descriptor. `RecoveryArtifactSource` entrega el artefacto para upload y `RecoveryArtifactSink` recibe materializaciones verificadas.

- `upload`: tras el preflight, HEAD primero; si checksum coincide reutiliza una versión que además pruebe Object Lock `COMPLIANCE`, si difiere bloquea, si no existe hace PUT con SHA-256 + retención y verifica HEAD posterior.
- `verify`: preflight + HEAD; exige checksum, VersionId, `COMPLIANCE` y retain-until futuro.
- `materialize`: preflight + HEAD immutable; GET debe corresponder a la misma VersionId/checksum antes de escribir al sink.

La evidencia devuelve refs opacas derivadas de version/descriptor; nunca endpoint, bucket, credenciales ni payloads del provider.

## Authority y exclusiones

El adapter existente sigue exigiendo `authority=unchanged` y `execute=false`. No se añaden scheduler, mutación de versioning/Object Lock, retention deletion, restore/cutover productivo, Google Drive primary, compras ni provisionamiento de credenciales.
