# Recovery object storage adapter

Factory #328/#329 produce el descriptor declarativo; FactoryRunner ejecuta únicamente una capability exacta mediante `RecoveryObjectStorageAdapter`.

Capabilities: `recovery.object-storage.upload|materialize|verify`. El descriptor debe conservar provider `object_storage`, role `primary_offsite`, checksum, idempotency, `authority=unchanged`, `execute=false` y `descriptor_id` canónico.

El adapter recibe un `connection_ref` opaco `controlbot:connection/...` y delega I/O a un driver inyectado. El driver nunca recibe passwords, tokens, URLs firmadas ni payloads desde la orden. Su resultado debe devolver el mismo object_ref/checksum, una immutable_version_ref y una evidence_ref seguras.

Errores del driver y resultados incoherentes se convierten en `recovery_object_storage_failed` sin eco. No hay retries automáticos, scheduler, Google Drive, DB restore, Recovery Health, payments ni producción live en este slice.
