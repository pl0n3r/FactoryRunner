# Recovery runtime E2E

Este slice cierra el epic Recovery de FactoryRunner con una prueba de integración determinista sobre los adapters ya fusionados. No añade runtime, provider ni credenciales.

## Flujo probado

La suite `tests/recovery-runtime-e2e.test.ts` recorre:

1. descriptor object storage `primary_offsite` → `RecoveryObjectStorageAdapter` → evidencia con versión inmutable;
2. descriptor Google Drive `cold_copy` → `RecoveryGoogleDriveAdapter` → evidencia con versión remota;
3. descriptor DB snapshot → `RecoveryDatabaseAdapter` → evidencia de snapshot;
4. descriptor DB restore → el mismo adapter → evidencia, únicamente con target `disposable`.

Todos los drivers son fakes inyectados. Capturan exactamente el comando que recibiría un provider real y devuelven evidencia determinista.

## Boundary de seguridad

La prueba verifica que comandos y evidencia agregada no contienen passwords, tokens, OAuth/service-account material, private keys, DSN, URLs o SQL. También confirma que `authority`, `execute` y roles de policy no cruzan hacia los drivers.

Cross-provider, cross-capability y restore DB a target productivo fallan cerrado antes de invocar I/O.

## Límites

No hay red, SDK de storage/Drive, DB real, subprocess, scheduler, retries, Recovery Health, ControlBot live, pagos ni despliegue productivo. Factory/ControlBot continúan siendo autoridad de policy/readiness; FactoryRunner solo ejecuta capabilities explícitas y devuelve evidencia sanitizada.
