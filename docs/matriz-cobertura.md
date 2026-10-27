# Matriz de cobertura normativa — FactoryRunner

**Corte:** 27-oct-2026 · `main@33277d549a82e9cba5371982d1d80e43e06bd0d5` · **alcance:** [#602](https://github.com/pl0n3r/FactoryRunner/issues/602). Fuentes: los nueve documentos de `docs/` (excluidas las carpetas auxiliares de privacidad), `README.md` e [issue #465](https://github.com/pl0n3r/FactoryRunner/issues/465). `docs/privacidad/` y `revision-juridica/` requieren auditoría legal independiente: aquí no se presume aprobación.

**Método:** descomposición en obligaciones verificables por apartado y decisión; un `CUBIERTO` sólo acredita el **contrato offline** señalado por una ruta y un PR efectivamente fusionado, no una instalación. `EN_CURSO` enlaza un Issue abierto; `NO_VERIFICABLE` especifica evidencia faltante; `SIN_COBERTURA` requiere issue nuevo antes del merge (en este corte no se afirmó ningún gap sin antes contrastar el issue existente #465). Ausencia de dato, service health y SHA productivos nunca es GREEN. No hay autorización para operar ControlBot/FactoryRunner ni activar host, browser o servicios reales.

**Semántica de fase:** `OFFLINE` = código/fixture/pruebas, `REAL` = integración con sistema verdadero, `OPERACIÓN` = ejecución continua y evidencia productiva, `N/A` = excluido por decisión. Las tres fases son independientes: cumplir OFFLINE no acredita REAL ni OPERACIÓN. Evidencias de fuente código/prueba se vinculan a PRs cerrados por merge, verificados contra GitHub; el test de esta hoja valida además su formato.

| ID / fuente | Requisito resumido | Estado | Evidencia | Issue | Fase |
| --- | --- | --- | --- | --- | --- |
| RM-01 / `README.md` | Separar ControlBot control plane y FactoryRunner execution plane | CUBIERTO | `src/controlbot/client.ts` y [PR #19](https://github.com/pl0n3r/FactoryRunner/pull/19) | — | OFFLINE |
| RM-02 / `README.md` | Identidad y heartbeat deterministas y fail-closed | CUBIERTO | `tests/runner-contracts.test.ts` y [PR #10](https://github.com/pl0n3r/FactoryRunner/pull/10) | — | OFFLINE |
| RM-03 / `README.md` | Órdenes/eventos idempotentes y referencias opacas | CUBIERTO | `tests/order-event-contracts.test.ts` y [PR #12](https://github.com/pl0n3r/FactoryRunner/pull/12) | — | OFFLINE |
| RM-04 / `README.md` | GitReadAdapter sin escritura ni credenciales | CUBIERTO | `src/adapters/git-read.ts` y [PR #14](https://github.com/pl0n3r/FactoryRunner/pull/14) | — | OFFLINE |
| RM-05 / `README.md` | BrowserExecutionAdapter desacoplado del proveedor | CUBIERTO | `src/adapters/browser.ts` y [PR #17](https://github.com/pl0n3r/FactoryRunner/pull/17) | — | OFFLINE |
| RM-06 / `README.md` | Contrato de cliente ControlBot poll/ACK/event/heartbeat | CUBIERTO | `tests/controlbot-client-contracts.test.ts` y [PR #19](https://github.com/pl0n3r/FactoryRunner/pull/19) | — | OFFLINE |
| RM-07 / `README.md` | Conexión a ControlBot real con transporte/identidad autorizados | EN_CURSO | Falta endpoint vivo autenticado, consentimiento y decisión owner; contratos solo fake | [FR #465](https://github.com/pl0n3r/FactoryRunner/issues/465) | REAL |
| RM-08 / `README.md` | Runner desplegado en Hostinger con /health y SHA exactos | NO_VERIFICABLE | Falta deploy autorizado, HEALTH productivo y recibo exact-SHA | — | OPERACIÓN |
| RM-09 / `README.md` | Node 24, typecheck y contratos en CI | CUBIERTO | `tests/test_factoryrunner_typecheck_contract.py` y [PR #15](https://github.com/pl0n3r/FactoryRunner/pull/15) | — | OFFLINE |
| RM-10 / `README.md` | No absorber AutoFactory, herramienta manual independiente | DESCARTADO | Fuera del execution plane por AGENTES.md y D-063; integración prohibida | — | N/A |
| RM-11 / `README.md` | Estado durable debe pertenecer al ControlBot | CUBIERTO | `tests/controlbot-client-contracts.test.ts` y [PR #19](https://github.com/pl0n3r/FactoryRunner/pull/19) | — | OFFLINE |
| RM-12 / `README.md` | Sin HTTPS o credenciales reales desde README/cockpit | NO_VERIFICABLE | La portada enlaza panel restringido; falta evidencia de conectividad real | — | REAL |
| GL-01 / `docs/go-live-preflight.md` | Preflight offline recibe SHA y seis pruebas explícitas | CUBIERTO | `tests/go-live-preflight.test.ts` y [PR #586](https://github.com/pl0n3r/FactoryRunner/pull/586) | — | OFFLINE |
| GL-02 / `docs/go-live-preflight.md` | Rechazar campos extra, gates duplicados y SHA discordante | CUBIERTO | `tests/test_go_live_preflight_contract.py` y [PR #586](https://github.com/pl0n3r/FactoryRunner/pull/586) | — | OFFLINE |
| GL-03 / `docs/go-live-preflight.md` | Estado del preflight preparado no autoriza live ni READY | CUBIERTO | `src/go-live-preflight.ts` y [PR #586](https://github.com/pl0n3r/FactoryRunner/pull/586) | — | OFFLINE |
| GL-04 / `docs/go-live-preflight.md` | HEALTH y protocolo de ControlBot real autenticados | EN_CURSO | ControlBot real aún sin HEALTH acreditado; #465 exige fuente/autoridad | [FR #465](https://github.com/pl0n3r/FactoryRunner/issues/465) | REAL |
| GL-05 / `docs/go-live-preflight.md` | Aprobación legal/privacidad antes de PII y sesiones reales | NO_VERIFICABLE | Falta aprobación legal y base legítima autenticada; datos.yml indica review_required | — | OPERACIÓN |
| GL-06 / `docs/go-live-preflight.md` | Hostinger permisos, endpoints HTTPS y credenciales por operación | NO_VERIFICABLE | Falta evidencia de hosting, límites y autorización independiente | — | OPERACIÓN |
| GL-07 / `docs/go-live-preflight.md` | Backup con restauración y rollback reales verificados | NO_VERIFICABLE | Sólo fakes/preflight; faltan recibos de restore y rollback reales | — | OPERACIÓN |
| GL-08 / `docs/go-live-preflight.md` | Switch, smoke, version y SHA comprobados en desplegado real | NO_VERIFICABLE | Sin despliegue/observación genuinos ni VALIDATED_IN_PRODUCTION | — | OPERACIÓN |
| LOC-01 / `docs/local-observer.md` | Observador requiere --demo opt-in y loopback | CUBIERTO | `tests/local-observer-server.test.ts` y [PR #484](https://github.com/pl0n3r/FactoryRunner/pull/484) | — | OFFLINE |
| LOC-02 / `docs/local-observer.md` | Sin --demo no iniciar listener | CUBIERTO | `tests/test_local_observer_server_contract.py` y [PR #484](https://github.com/pl0n3r/FactoryRunner/pull/484) | — | OFFLINE |
| LOC-03 / `docs/local-observer.md` | Host/Origin y CSP restringidos, GET-only | CUBIERTO | `tests/local-observer-server.test.ts` y [PR #484](https://github.com/pl0n3r/FactoryRunner/pull/484) | — | OFFLINE |
| LOC-04 / `docs/local-observer.md` | DTO snapshot rechaza paquetes inconsistentes | CUBIERTO | `src/local-observer-snapshot.ts` y [PR #470](https://github.com/pl0n3r/FactoryRunner/pull/470) | — | OFFLINE |
| LOC-05 / `docs/local-observer.md` | Renderer escapa HTML y no finge READY | CUBIERTO | `tests/local-observer-html.test.ts` y [PR #469](https://github.com/pl0n3r/FactoryRunner/pull/469) | — | OFFLINE |
| LOC-06 / `docs/local-observer.md` | Adaptador de exportación usa fixtures inyectados | CUBIERTO | `src/local-observer-source-adapter.ts` y [PR #481](https://github.com/pl0n3r/FactoryRunner/pull/481) | — | OFFLINE |
| LOC-07 / `docs/local-observer.md` | Candidato in-process con reloj/frescura explícitos | CUBIERTO | `src/local-observer-runtime-projection.ts` y [PR #489](https://github.com/pl0n3r/FactoryRunner/pull/489) | — | OFFLINE |
| LOC-08 / `docs/local-observer.md` | FRESH en fixture no habilita READY ni capacidad real | CUBIERTO | `tests/test_local_observer_runtime_projection_contract.py` y [PR #489](https://github.com/pl0n3r/FactoryRunner/pull/489) | — | OFFLINE |
| LOC-09 / `docs/local-observer.md` | GET /health sólo sintético y UNKNOWN | CUBIERTO | `tests/test_local_observer_server_contract.py` y [PR #484](https://github.com/pl0n3r/FactoryRunner/pull/484) | — | OFFLINE |
| LOC-10 / `docs/local-observer.md` | Prohibido leer procesos, chats, sesiones o perfiles del Mac | CUBIERTO | `tests/local-observer-server.test.ts` y [PR #484](https://github.com/pl0n3r/FactoryRunner/pull/484) | — | OFFLINE |
| LOC-11 / `docs/local-observer.md` | Fuente de observación real autenticada y autorizada | EN_CURSO | Observador current=synthetic_only; fuente real y consentimiento no acreditados | [FR #465](https://github.com/pl0n3r/FactoryRunner/issues/465) | REAL |
| LOC-12 / `docs/local-observer.md` | Capacidad READY y heartbeat genuinos desde runners desplegados | EN_CURSO | No hay roster de procesos reales; falta conexión y fuentes confiables | [FR #465](https://github.com/pl0n3r/FactoryRunner/issues/465) | OPERACIÓN |
| LOC-13 / `docs/local-observer.md` | Datos de usuario fuera de UI sin revisión de privacidad | NO_VERIFICABLE | Falta auditoría de tratamiento real y permiso por operación | — | REAL |
| RC-01 / `docs/reconciliacion-issues-20261024.md` | Issue #465 permanece abierto sin evidencia live | CUBIERTO | `docs/reconciliacion-issues-20261024.md` y [PR #601](https://github.com/pl0n3r/FactoryRunner/pull/601) | — | OFFLINE |
| RC-02 / `docs/reconciliacion-issues-20261024.md` | Cierre de issues requiere PR fusionado y CI exact-main | CUBIERTO | `tests/test_reconciliacion_issues_20261024.py` y [PR #601](https://github.com/pl0n3r/FactoryRunner/pull/601) | — | OFFLINE |
| RC-03 / `docs/reconciliacion-issues-20261024.md` | Corte 24-oct histórico no representa backlog de hoy | CUBIERTO | `docs/reconciliacion-issues-20261024.md` y [PR #601](https://github.com/pl0n3r/FactoryRunner/pull/601) | — | OFFLINE |
| RC-04 / `docs/reconciliacion-issues-20261024.md` | Readiness real de #465 aún pendiente | EN_CURSO | #465 sigue OPEN/planificado; nuevo trabajo operativo prohibido sin voto | [FR #465](https://github.com/pl0n3r/FactoryRunner/issues/465) | OPERACIÓN |
| DB-01 / `docs/recovery-database.md` | Snapshot lógico con descriptor/connection_ref opaca | CUBIERTO | `tests/recovery-database-adapter.test.ts` y [PR #34](https://github.com/pl0n3r/FactoryRunner/pull/34) | — | OFFLINE |
| DB-02 / `docs/recovery-database.md` | Restore sólo a target disposable | CUBIERTO | `tests/test_recovery_database_adapter.py` y [PR #34](https://github.com/pl0n3r/FactoryRunner/pull/34) | — | OFFLINE |
| DB-03 / `docs/recovery-database.md` | Sin DSN ni secretos/SQL en orden y evidencia | CUBIERTO | `src/adapters/recovery-database.ts` y [PR #34](https://github.com/pl0n3r/FactoryRunner/pull/34) | — | OFFLINE |
| DB-04 / `docs/recovery-database.md` | Snapshot/restauración real DB verificados | NO_VERIFICABLE | Los drivers de pruebas son fake; faltan DSN fuera del repo, operador y recibo real | — | OPERACIÓN |
| GD-01 / `docs/recovery-google-drive.md` | Google Drive limitado a cold_copy y tres capabilities | CUBIERTO | `tests/recovery-google-drive-adapter.test.ts` y [PR #32](https://github.com/pl0n3r/FactoryRunner/pull/32) | — | OFFLINE |
| GD-02 / `docs/recovery-google-drive.md` | Descriptores rechazan OAuth, URL compartida y payloads | CUBIERTO | `src/adapters/recovery-google-drive.ts` y [PR #32](https://github.com/pl0n3r/FactoryRunner/pull/32) | — | OFFLINE |
| GD-03 / `docs/recovery-google-drive.md` | Errores de driver sanitizados y refs opacas | CUBIERTO | `tests/test_recovery_google_drive_adapter.py` y [PR #32](https://github.com/pl0n3r/FactoryRunner/pull/32) | — | OFFLINE |
| GD-04 / `docs/recovery-google-drive.md` | Operación Drive con cuenta/permisos reales | NO_VERIFICABLE | Sólo fake-injected; falta autorización/OAuth seguro y prueba del proveedor | — | OPERACIÓN |
| OS-01 / `docs/recovery-object-storage.md` | Object storage primary_offsite con descriptor/versión | CUBIERTO | `src/adapters/recovery-object-storage.ts` y [PR #30](https://github.com/pl0n3r/FactoryRunner/pull/30) | — | OFFLINE |
| OS-02 / `docs/recovery-object-storage.md` | Error/mismatch fail-closed sin eco de driver | CUBIERTO | `tests/recovery-object-storage-adapter.test.ts` y [PR #30](https://github.com/pl0n3r/FactoryRunner/pull/30) | — | OFFLINE |
| OS-03 / `docs/recovery-object-storage.md` | Sin scheduler ni retention deletion desde el descriptor | CUBIERTO | `src/adapters/recovery-object-storage.ts` y [PR #30](https://github.com/pl0n3r/FactoryRunner/pull/30) | — | OFFLINE |
| LO-01 / `docs/recovery-live-object-storage.md` | Endpoint S3-compatible HTTPS/443 sin credenciales en orden | CUBIERTO | `tests/recovery-live-object-storage.test.ts` y [PR #42](https://github.com/pl0n3r/FactoryRunner/pull/42) | — | OFFLINE |
| LO-02 / `docs/recovery-live-object-storage.md` | Resolución runtime desde connection_ref opaca | CUBIERTO | `src/adapters/recovery-object-storage.ts` y [PR #44](https://github.com/pl0n3r/FactoryRunner/pull/44) | — | OFFLINE |
| LO-03 / `docs/recovery-live-object-storage.md` | Preflight GET de Versioning Enabled | CUBIERTO | `tests/test_recovery_bucket_preflight.py` y [PR #48](https://github.com/pl0n3r/FactoryRunner/pull/48) | — | OFFLINE |
| LO-04 / `docs/recovery-live-object-storage.md` | Preflight GET Object Lock Enabled con XML estricto | CUBIERTO | `tests/test_recovery_object_lock.py` y [PR #46](https://github.com/pl0n3r/FactoryRunner/pull/46) | — | OFFLINE |
| LO-05 / `docs/recovery-live-object-storage.md` | Rechazar nodos XML anidados fraudulentos | CUBIERTO | `tests/recovery-live-object-storage.test.ts` y [PR #464](https://github.com/pl0n3r/FactoryRunner/pull/464) | — | OFFLINE |
| LO-06 / `docs/recovery-live-object-storage.md` | Upload/verify/materialize comprobados contra driver mock | CUBIERTO | `tests/recovery-live-object-storage.test.ts` y [PR #42](https://github.com/pl0n3r/FactoryRunner/pull/42) | — | OFFLINE |
| LO-07 / `docs/recovery-live-object-storage.md` | Preflight/versión/retención y restore reales en proveedor | NO_VERIFICABLE | Driver potencial existe; falta cuenta autorizada y atestación de S3 real | — | OPERACIÓN |
| RT-01 / `docs/recovery-runtime-e2e.md` | E2E object storage primary con fake y versión | CUBIERTO | `tests/recovery-runtime-e2e.test.ts` y [PR #38](https://github.com/pl0n3r/FactoryRunner/pull/38) | — | OFFLINE |
| RT-02 / `docs/recovery-runtime-e2e.md` | E2E cold-copy Drive con fake y versión | CUBIERTO | `tests/recovery-runtime-e2e.test.ts` y [PR #38](https://github.com/pl0n3r/FactoryRunner/pull/38) | — | OFFLINE |
| RT-03 / `docs/recovery-runtime-e2e.md` | E2E DB snapshot y restore disposable con fake | CUBIERTO | `tests/recovery-runtime-e2e.test.ts` y [PR #38](https://github.com/pl0n3r/FactoryRunner/pull/38) | — | OFFLINE |
| RT-04 / `docs/recovery-runtime-e2e.md` | Rechazar cross-provider/capability y secretos | CUBIERTO | `tests/recovery-runtime-e2e.test.ts` y [PR #38](https://github.com/pl0n3r/FactoryRunner/pull/38) | — | OFFLINE |
| RT-05 / `docs/recovery-runtime-e2e.md` | Runtime Recovery productivo completo | NO_VERIFICABLE | Prueba sólo fake; faltan proveedores, identidad, backups/restore reales | — | OPERACIÓN |
| KS-01 / `docs/runner-kill-switch-rehearsal.md` | Ensayo fake pausa ControlBot y rechaza orden | CUBIERTO | `tests/test_runner_kill_switch_rehearsal.py` y [PR #581](https://github.com/pl0n3r/FactoryRunner/pull/581) | — | OFFLINE |
| KS-02 / `docs/runner-kill-switch-rehearsal.md` | Ensayo fake pausa Runner y rechaza dispatch | CUBIERTO | `tests/kill-switch-rollback-rehearsal.test.ts` y [PR #581](https://github.com/pl0n3r/FactoryRunner/pull/581) | — | OFFLINE |
| KS-03 / `docs/runner-kill-switch-rehearsal.md` | Rollback in-memory determinista con digest | CUBIERTO | `docs/runner-kill-switch-rehearsal.md` y [PR #581](https://github.com/pl0n3r/FactoryRunner/pull/581) | — | OFFLINE |
| KS-04 / `docs/runner-kill-switch-rehearsal.md` | Kill switch + rollback reales end-to-end | NO_VERIFICABLE | Recibo offline no es HEALTH y no hay deploy/rollback real autorizado | — | OPERACIÓN |
| I465-01 / [Issue #465](https://github.com/pl0n3r/FactoryRunner/issues/465) | No comenzar observación real hasta nueva dirección owner | EN_CURSO | Issue #465 OPEN y decisión explícita de no-go/live; [#465](https://github.com/pl0n3r/FactoryRunner/issues/465) | [FR #465](https://github.com/pl0n3r/FactoryRunner/issues/465) | REAL |
| I465-02 / [Issue #465](https://github.com/pl0n3r/FactoryRunner/issues/465) | Mantener fuente synthetic_only, sin registrar señales reales | CUBIERTO | `tests/test_local_observer_demo_wiring_contract.py` y [PR #484](https://github.com/pl0n3r/FactoryRunner/pull/484) | — | OFFLINE |
| I465-03 / [Issue #465](https://github.com/pl0n3r/FactoryRunner/issues/465) | Contrastar protocolo y HEALTH real del ControlBot antes de operar | EN_CURSO | Faltan fuentes y operación real; #465 sigue abierto | [FR #465](https://github.com/pl0n3r/FactoryRunner/issues/465) | OPERACIÓN |

## Resumen auditable

| Estado | Filas |
| --- | ---: |
| CUBIERTO | 47 |
| EN_CURSO | 7 |
| SIN_COBERTURA | 0 |
| DESCARTADO | 1 |
| NO_VERIFICABLE | 12 |
| TOTAL | 67 |

**Cobertura comprobada:** **70.1% CUBIERTO** (47/67). Es cobertura de **requisitos documentales y contratos offline**, no porcentaje de preparación productiva.

### Dependencias y criterios de reentrada

- **OFFLINE:** los contratos de identidad, ejecución, cliente, observers y recovery tienen implementaciones y pruebas acotadas; los PRs indicados están fusionados. Esto acredita código, no disponibilidad.
- **REAL:** [#465](https://github.com/pl0n3r/FactoryRunner/issues/465) sigue `OPEN/estado: planificado` para fuente auténtica; el propietario ordenó no comenzar trabajo nuevo de observación operativa hasta decisión de go-live. La instrucción dirigida para #602 autoriza esta documentación, no revoca ese veto.
- **OPERACIÓN:** no existen evidencias de `VALIDATED_IN_PRODUCTION`, backups/restores reales, identidad de servicio/ControlBot, HTTPS/credenciales autorizadas ni HEALTH genuino. `docs/go-live-preflight.md` mantiene `live_authorized=false` y `readiness=UNKNOWN`; `docs/local-observer.md` conserva `synthetic_only`.
- **Brechas sin issue:** no se registran `SIN_COBERTURA` nuevas en este corte: las brechas operativas están en el issue existente #465 o clasificadas `NO_VERIFICABLE` por falta de pruebas/autoridad. No convertir incertidumbre en defecto confirmado ni abrir nuevo backlog sin motivo permitido por Factory#1289. Si un test/procedencia posterior demuestra una capacidad normativa **ausente**, abrir hoja específica con `factory-plan-task`, `factory-acceptance` y paths propios; mantener fuera de la operación real hasta autoridad.

**Reproducir:** `python3 -m unittest tests.test_matriz_cobertura`; el CI completo ejecuta `python3 -m unittest discover -s tests -p 'test_*.py'`. Revertir el squash de #602 retira únicamente esta matriz y su prueba, sin afectar runtime, configuración, secrets ni hosting.
