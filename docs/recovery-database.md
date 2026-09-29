# Recovery database adapter

FactoryRunner ejecuta solo dos acciones DB de Recovery derivadas de Factory #329/#330: crear un snapshot lógico y restaurar un backup verificado en un target descartable.

## Capabilities

- `recovery.database.snapshot`
- `recovery.database.restore-disposable`

Snapshot conserva `source=database`, una `snapshot_ref` opaca, idempotencia, `authority=unchanged` y `execute=false`. El checksum se calcula después, como define el pipeline de Factory.

Restore exige `backup_id`, checksum SHA-256 y `target.kind=disposable`. Targets `production`, `live`, cutover o cualquier forma distinta de disposable se rechazan antes del driver.

El adapter recibe únicamente un `connection_ref` opaco de ControlBot y delega I/O a un `RecoveryDatabaseDriver` inyectado. La orden nunca transporta DSN, passwords, tokens, SQL, dump bytes ni URLs.

Los resultados deben corresponder exactamente con las refs/checksum solicitadas y aportar `evidence_ref` segura. Cualquier fallo del driver o mismatch colapsa a `recovery_database_failed` sin eco.

No hay SQL real, dump/restore real, migraciones, broker de secretos, failover/cutover, retries, scheduler ni despliegue productivo en este slice.
