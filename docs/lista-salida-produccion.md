# Lista de salida a producción — FactoryRunner

**Corte:** 27 de octubre de 2026 · `main@7d9675c0561165254fc105a573ce96bafc2b832f` · [issue #604](https://github.com/pl0n3r/FactoryRunner/issues/604). Auditoría de **67 requisitos** en **19 áreas**. Este documento no constituye aprobación de salida a producción.

## Criterios de clasificación

- **LISTO:** sólo evidencia **OFFLINE** concreta y PR fusionado de ese contrato; no significa servicio productivo sano ni `VALIDATED_IN_PRODUCTION`.
- **EN_CURSO:** exige hoja ejecutable no bloqueada con `factory-plan-task` y rutas exclusivas o un PR abierto. #465 planificado y #1 roadmap no cuentan. Una hoja bloqueada tampoco acredita avance ejecutado.
- **SIN_COBERTURA:** requisito operativo sin evidencia real, con hoja canónica creada/enlazada; las hojas #605, #606, #607, #608, #609 están **bloqueadas** hasta autorización. El vínculo no cambia ese estado ni habilita ejecución.
- **DEL_DUEÑO:** decisión, cuenta, política legal o gasto que requiere autoridad del dueño; se deja descrita, **sin generar trabajo manual** y sin asumir permiso de acción.
- **NO_APLICA:** exclusión por decisión o arquitectura explícita. La fase separa `OFFLINE`, `OPERACIÓN` y `N/A`.

**Fuentes:** `decisiones.yml` D-054..D-065; `AGENTES.md`, `README.md`, todos los documentos Recovery, observador, preflight, privacidad; [#431](https://github.com/pl0n3r/FactoryRunner/issues/431) y [#465](https://github.com/pl0n3r/FactoryRunner/issues/465); matriz [#602](https://github.com/pl0n3r/FactoryRunner/issues/602) integrada mediante PR #603. [#431/A](https://github.com/pl0n3r/FactoryRunner/issues/431#issuecomment-6325484732) sólo autorizó **preflight offline** y no tráfico real. Continúan `live_authorized=false`, `readiness=UNKNOWN` y `synthetic_only`. Sin compras, credenciales, exposición de DNS/Hostinger, backups o datos reales. La política D-065 prohíbe secretos en órdenes, logs y repo; AutoFactory permanece independiente por D-063.

## Registro de requisitos

| ID | Área | Requisito | Estado | Evidencia | Issue | Fase |
| --- | --- | --- | --- | --- | --- | --- |
| BK-01 | Respaldos y restauración | Contrato DB snapshot y restore descartable sin secretos | LISTO | `tests/recovery-database-adapter.test.ts` y [PR #34](https://github.com/pl0n3r/FactoryRunner/pull/34) | — | OFFLINE |
| BK-02 | Respaldos y restauración | Backup real, checksum, restore y RPO/RTO verificados | SIN_COBERTURA | Falta recibo genuino de backup/restore, no mock | [FR #607](https://github.com/pl0n3r/FactoryRunner/issues/607) | OPERACIÓN |
| BK-03 | Respaldos y restauración | Restore a destino temporal sin tocar producción | SIN_COBERTURA | Falta prueba real en un target disposable | [FR #607](https://github.com/pl0n3r/FactoryRunner/issues/607) | OPERACIÓN |
| BK-04 | Respaldos y restauración | Política de conservación y custodio de backups | NO_APLICA | Excluido: uso interno, sin tratamiento de datos de terceros (decisión del dueño 30-oct-2026; #658 no planeado) | — | N/A |
| MO-01 | Monitoreo y alertas | Servidor demo no anuncia readiness real | LISTO | `tests/local-observer-server.test.ts` y [PR #484](https://github.com/pl0n3r/FactoryRunner/pull/484) | — | OFFLINE |
| MO-02 | Monitoreo y alertas | Fuente autenticada, roster y heartbeat genuinos | SIN_COBERTURA | Falta colección real autorizada, no synthetic_only | [FR #606](https://github.com/pl0n3r/FactoryRunner/issues/606) | OPERACIÓN |
| MO-03 | Monitoreo y alertas | Alertas de caída, saturación y canal de escalado | SIN_COBERTURA | Falta evidencia real de alerta y destinatario | [FR #608](https://github.com/pl0n3r/FactoryRunner/issues/608) | OPERACIÓN |
| MO-04 | Monitoreo y alertas | Política de logs y protección de PII | NO_APLICA | Excluido: uso interno, sin tratamiento de datos de terceros (decisión del dueño 30-oct-2026; #659 no planeado) | — | N/A |
| DNS-01 | Dominios, DNS y TLS | Identificar dominio y propiedad de registros DNS | DEL_DUEÑO | Falta decisión de dominio y autoridad sobre zona DNS | — | OPERACIÓN |
| DNS-02 | Dominios, DNS y TLS | TLS válido, expiración, HTTPS y control de hostname | SIN_COBERTURA | Falta certificado y prueba autenticada de endpoint real | [FR #608](https://github.com/pl0n3r/FactoryRunner/issues/608) | OPERACIÓN |
| DNS-03 | Dominios, DNS y TLS | Verificar hostname contra redirección y exposición no autorizada | SIN_COBERTURA | Falta prueba de red y aislamiento en Hostinger | [FR #608](https://github.com/pl0n3r/FactoryRunner/issues/608) | OPERACIÓN |
| SE-01 | Secretos y accesos | Refs opacas sin secretos en payload Recovery | LISTO | `src/adapters/recovery-google-drive.ts` y [PR #32](https://github.com/pl0n3r/FactoryRunner/pull/32) | — | OFFLINE |
| SE-02 | Secretos y accesos | Provisionamiento externo, rotación y revocación de secretos | SIN_COBERTURA | Falta vault/gestión de credenciales real con prueba de revocación | [FR #608](https://github.com/pl0n3r/FactoryRunner/issues/608) | OPERACIÓN |
| SE-03 | Secretos y accesos | Identidades y permisos mínimos por entorno | DEL_DUEÑO | Falta aprobación del titular de las cuentas de servicio | — | OPERACIÓN |
| CO-01 | Costos y límites | Arquitectura compartida sin requerir Docker ni root | LISTO | `src/controlbot/client.ts` y [PR #19](https://github.com/pl0n3r/FactoryRunner/pull/19) | — | OFFLINE |
| CO-02 | Costos y límites | Aprobar presupuesto, plan y facturación | DEL_DUEÑO | Falta decisión de gastos/cuotas de Hostinger y servicios externos | — | OPERACIÓN |
| CO-03 | Costos y límites | Medir cuotas, cron, conexiones y límites de carga reales | SIN_COBERTURA | Falta atestación de capacidad frente al workload objetivo | [FR #608](https://github.com/pl0n3r/FactoryRunner/issues/608) | OPERACIÓN |
| PV-01 | Privacidad y aspectos legales | Inventario técnico de privacidad deja explícita revisión jurídica | LISTO | `docs/matriz-cobertura.md` y [PR #603](https://github.com/pl0n3r/FactoryRunner/pull/603) | — | OFFLINE |
| PV-02 | Privacidad y aspectos legales | Aprobar aviso, derechos, retención y responsable | NO_APLICA | Excluido: uso interno, sin tratamiento de datos de terceros (decisión del dueño 30-oct-2026; #663 no planeado) | — | N/A |
| PV-03 | Privacidad y aspectos legales | Consentimiento para cuentas, ubicación y sesiones reales | NO_APLICA | Excluido: uso interno, sin tratamiento de datos de terceros (decisión del dueño 30-oct-2026; #664 no planeado) | — | N/A |
| PV-04 | Privacidad y aspectos legales | Términos, terceros, transferencia y SLA | NO_APLICA | Excluido: uso interno, sin tratamiento de datos de terceros (decisión del dueño 30-oct-2026; #665 no planeado) | — | N/A |
| SU-01 | Soporte y operación diaria | Runbook soporte diario, escalación e incidentes | SIN_COBERTURA | Falta ensayo operativo de soporte, escalación y acuse. [PR #630](https://github.com/pl0n3r/FactoryRunner/pull/630) MERGED entrega `docs/launch-qa-smoke.md` y `tests/test_launch_qa_smoke.py`, solo preparación y negativos OFFLINE. | [FR #609](https://github.com/pl0n3r/FactoryRunner/issues/609) | OPERACIÓN |
| SU-02 | Soporte y operación diaria | Operación del scheduler/alertas y bitácora | SIN_COBERTURA | Falta runbook y evidencia de continuidad operativa | [FR #608](https://github.com/pl0n3r/FactoryRunner/issues/608) | OPERACIÓN |
| SU-03 | Soporte y operación diaria | Responsable de soporte y horario/SLA | DEL_DUEÑO | Falta definición de autoridad y niveles de servicio | — | OPERACIÓN |
| MI-01 | Migración de datos | Estado durable pertenece a ControlBot, no al Runner | LISTO | `tests/controlbot-client-contracts.test.ts` y [PR #19](https://github.com/pl0n3r/FactoryRunner/pull/19) | — | OFFLINE |
| MI-02 | Migración de datos | Conciliación de datos, rollback y cutover real | SIN_COBERTURA | Falta ensayo de migración con controles de checksum | [FR #607](https://github.com/pl0n3r/FactoryRunner/issues/607) | OPERACIÓN |
| MI-03 | Migración de datos | Autoridad de ventana y uso de datos reales | DEL_DUEÑO | Falta decisión específica de migración/cambio de entorno | — | OPERACIÓN |
| MI-04 | Migración de datos | Migrar AutoFactory dentro de FactoryRunner | NO_APLICA | Excluido: decisión D-063 conserva AutoFactory independiente | — | N/A |
| RB-01 | Reversión y apagado de emergencia | Ensayo determinista de pausa y rollback fake | LISTO | `tests/kill-switch-rollback-rehearsal.test.ts` y [PR #581](https://github.com/pl0n3r/FactoryRunner/pull/581) | — | OFFLINE |
| RB-02 | Reversión y apagado de emergencia | Ensayo de apagado/rollback contra runner genuino | SIN_COBERTURA | Falta ensayo real exact-SHA de apagado, rollback y RESTORE. [PR #630](https://github.com/pl0n3r/FactoryRunner/pull/630) MERGED aporta `tests/test_launch_qa_smoke.py` fail-closed con fixtures, no recuperación autenticada. | [FR #609](https://github.com/pl0n3r/FactoryRunner/issues/609) | OPERACIÓN |
| RB-03 | Reversión y apagado de emergencia | Restaurar backup y confirmar estado sano real | SIN_COBERTURA | Falta ensayo reversible autenticado de recuperación | [FR #607](https://github.com/pl0n3r/FactoryRunner/issues/607) | OPERACIÓN |
| RB-04 | Reversión y apagado de emergencia | Delegación de pausa/reanudación de tráfico | DEL_DUEÑO | Falta aprobación del titular de operación real | — | OPERACIÓN |
| SG-01 | Seguridad y pruebas | Pruebas Python/Node en CI y contrato de aceptación | LISTO | `tests/test_matriz_cobertura.py` y [PR #603](https://github.com/pl0n3r/FactoryRunner/pull/603) | — | OFFLINE |
| SG-02 | Seguridad y pruebas | Contratos rechazan secretos y restore cruzado | LISTO | `tests/recovery-runtime-e2e.test.ts` y [PR #38](https://github.com/pl0n3r/FactoryRunner/pull/38) | — | OFFLINE |
| SG-03 | Seguridad y pruebas | ACL y autenticación ControlBot real | SIN_COBERTURA | Falta ACL y autenticación ControlBot reales. [PR #633](https://github.com/pl0n3r/FactoryRunner/pull/633) MERGED aporta `tests/test_factoryrunner_controlbot_http_session_client.py` con HEALTH simulado y transporte falso, sin red. | [FR #605](https://github.com/pl0n3r/FactoryRunner/issues/605) | OPERACIÓN |
| SG-04 | Seguridad y pruebas | Seguridad de rate limits, MFA y ejecución sin escalada | SIN_COBERTURA | Falta validar rate limits, MFA y permisos en entorno autorizado. [PR #630](https://github.com/pl0n3r/FactoryRunner/pull/630) MERGED añade `tests/test_launch_qa_smoke.py` de negativos offline, no ensayo real. | [FR #609](https://github.com/pl0n3r/FactoryRunner/issues/609) | OPERACIÓN |
| SG-05 | Seguridad y pruebas | Autorizar pruebas externas de seguridad si aplican | DEL_DUEÑO | Falta alcance y proveedor de pentest autorizado | — | OPERACIÓN |
| AX-01 | Accesibilidad y rendimiento | Demo del observador limitada a loopback | LISTO | `scripts/local-observer-server.ts` y [PR #484](https://github.com/pl0n3r/FactoryRunner/pull/484) | — | OFFLINE |
| AX-02 | Accesibilidad y rendimiento | Verificar accesibilidad aplicable a interfaz operativa | SIN_COBERTURA | Falta auditoría de accesibilidad de interfaz real con resultado verificable. [PR #630](https://github.com/pl0n3r/FactoryRunner/pull/630) MERGED documenta criterios en `docs/launch-qa-smoke.md`, no ensayo auténtico. | [FR #609](https://github.com/pl0n3r/FactoryRunner/issues/609) | OPERACIÓN |
| AX-03 | Accesibilidad y rendimiento | Rendimiento p95 y pruebas de estrés con umbrales | SIN_COBERTURA | Falta benchmark p95/estrés real y presupuesto contractual aprobado. [PR #630](https://github.com/pl0n3r/FactoryRunner/pull/630) MERGED define exigencias en `docs/launch-qa-smoke.md`, no mediciones. | [FR #609](https://github.com/pl0n3r/FactoryRunner/issues/609) | OPERACIÓN |
| AX-04 | Accesibilidad y rendimiento | Usar Chromium local con root como requisito obligatorio | NO_APLICA | Excluido: diseño D-064 prohíbe presumir root/Docker en Hostinger | — | N/A |
| SM-01 | Smoke de producción | Preflight offline fail-closed no autoriza go-live | LISTO | `tests/go-live-preflight.test.ts` y [PR #586](https://github.com/pl0n3r/FactoryRunner/pull/586) | — | OFFLINE |
| SM-02 | Smoke de producción | Smoke de HEALTH real, versión/SHA y dashboard | SIN_COBERTURA | Falta smoke HTTP/HEALTH de entorno auténtico con versión/SHA. [PR #630](https://github.com/pl0n3r/FactoryRunner/pull/630) MERGED incluye `tests/test_launch_qa_smoke.py` que rechaza recibos no autenticados, sin validar producción. | [FR #609](https://github.com/pl0n3r/FactoryRunner/issues/609) | OPERACIÓN |
| SM-03 | Smoke de producción | Smoke de recuperación después de rollback | SIN_COBERTURA | Falta smoke real posterior a rollback con recibo terminal. [PR #630](https://github.com/pl0n3r/FactoryRunner/pull/630) MERGED cubre solo preflight sintético en `tests/test_launch_qa_smoke.py`. | [FR #609](https://github.com/pl0n3r/FactoryRunner/issues/609) | OPERACIÓN |
| SM-04 | Smoke de producción | Permiso específico de activación live adicional a #431/A | DEL_DUEÑO | Falta decisión nueva y explícita de despliegue/cutover | — | OPERACIÓN |
| CR-01 | Credenciales del ejecutor | Driver Recovery recibe sólo alias de conexión opaca | LISTO | `src/adapters/recovery-database.ts` y [PR #34](https://github.com/pl0n3r/FactoryRunner/pull/34) | — | OFFLINE |
| CR-02 | Credenciales del ejecutor | Rotación, expiración, aislamiento y revocación de tokens reales | SIN_COBERTURA | Falta gestor de secretos real y prueba de revocación | [FR #608](https://github.com/pl0n3r/FactoryRunner/issues/608) | OPERACIÓN |
| CR-03 | Credenciales del ejecutor | Acceso a cuentas externas y consentimiento | DEL_DUEÑO | Falta aprobación de identidades y titularidad del ejecutor | — | OPERACIÓN |
| AI-01 | Aislamiento de ejecuciones | Capabilities/órdenes con límites y negativos offline | LISTO | `tests/runner-contracts.test.ts` y [PR #10](https://github.com/pl0n3r/FactoryRunner/pull/10) | — | OFFLINE |
| AI-02 | Aislamiento de ejecuciones | Probar separación tenant/perfil/browser real | SIN_COBERTURA | Falta ensayo de aislamiento efectivo y protección de sesiones | [FR #608](https://github.com/pl0n3r/FactoryRunner/issues/608) | OPERACIÓN |
| AI-03 | Aislamiento de ejecuciones | Observador demo no lee procesos ni sesiones del Mac | LISTO | `tests/local-observer-server.test.ts` y [PR #484](https://github.com/pl0n3r/FactoryRunner/pull/484) | — | OFFLINE |
| DB-01 | Recuperación base de datos | Restore DB sólo en target disposable | LISTO | `tests/test_recovery_database_adapter.py` y [PR #34](https://github.com/pl0n3r/FactoryRunner/pull/34) | — | OFFLINE |
| DB-02 | Recuperación base de datos | Snapshot/restore real y checksum verificados | SIN_COBERTURA | Falta comprobación contra servidor de prueba descartable | [FR #607](https://github.com/pl0n3r/FactoryRunner/issues/607) | OPERACIÓN |
| DB-03 | Recuperación base de datos | E2E DB sintético sin DSN ni SQL en orden | LISTO | `tests/recovery-runtime-e2e.test.ts` y [PR #38](https://github.com/pl0n3r/FactoryRunner/pull/38) | — | OFFLINE |
| GD-01 | Recuperación Google Drive | Drive cold-copy con refs y resultados sanitizados | LISTO | `src/adapters/recovery-google-drive.ts` y [PR #32](https://github.com/pl0n3r/FactoryRunner/pull/32) | — | OFFLINE |
| GD-02 | Recuperación Google Drive | Subir/materializar/verificar cold-copy real | SIN_COBERTURA | Falta prueba Drive real autorizada y checksum/versión | [FR #607](https://github.com/pl0n3r/FactoryRunner/issues/607) | OPERACIÓN |
| GD-03 | Recuperación Google Drive | Drive como almacenamiento primario Recovery | NO_APLICA | Excluido: contrato docs/recovery-google-drive.md obliga cold_copy | — | N/A |
| OS-01 | Recuperación almacenamiento | Versioning y Object Lock como preflight fail-closed | LISTO | `tests/test_recovery_object_lock.py` y [PR #46](https://github.com/pl0n3r/FactoryRunner/pull/46) | — | OFFLINE |
| OS-02 | Recuperación almacenamiento | Resolver refs opacas a configuración en runtime | LISTO | `src/recovery/connection-resolver.ts` y [PR #42](https://github.com/pl0n3r/FactoryRunner/pull/42) | — | OFFLINE |
| OS-03 | Recuperación almacenamiento | Versionado, retención y restore S3 real | SIN_COBERTURA | Falta recibo real de provider, checksum y COMPLIANCE | [FR #607](https://github.com/pl0n3r/FactoryRunner/issues/607) | OPERACIÓN |
| KS-01 | Kill switch ensayado | Ensayo de kill switch/rollback fake con recibo | LISTO | `docs/runner-kill-switch-rehearsal.md` y [PR #581](https://github.com/pl0n3r/FactoryRunner/pull/581) | — | OFFLINE |
| KS-02 | Kill switch ensayado | Kill switch real detiene tareas y habilita reversión | SIN_COBERTURA | Falta ensayo real de pausa, despacho detenido y recuperación. [PR #630](https://github.com/pl0n3r/FactoryRunner/pull/630) MERGED incorpora criterios OFFLINE en `docs/launch-qa-smoke.md`, sin accionar el kill switch. | [FR #609](https://github.com/pl0n3r/FactoryRunner/issues/609) | OPERACIÓN |
| KS-03 | Kill switch ensayado | Autoridad de corte, reanudación y emergencia | DEL_DUEÑO | Falta aprobación del dueño de protocolo y responsable de parada | — | OPERACIÓN |
| OB-01 | Observador local auténtico | Local demo sólo GET/loopback y no LIVE | LISTO | `tests/test_local_observer_server_contract.py` y [PR #484](https://github.com/pl0n3r/FactoryRunner/pull/484) | — | OFFLINE |
| OB-02 | Observador local auténtico | Fuente auténtica y capacidad/heartbeat | SIN_COBERTURA | Falta observación autenticada, no fixture FRESH | [FR #606](https://github.com/pl0n3r/FactoryRunner/issues/606) | OPERACIÓN |
| OB-03 | Observador local auténtico | ControlBot conectado, HTTPS y HEALTH compatible | SIN_COBERTURA | Falta conexión HTTPS ControlBot auténtica, identidad y HEALTH exact-SHA. [PR #633](https://github.com/pl0n3r/FactoryRunner/pull/633) MERGED aporta `tests/test_factoryrunner_controlbot_http_session_client.py` con cliente deshabilitado y simulación, no observación real. | [FR #605](https://github.com/pl0n3r/FactoryRunner/issues/605) | OPERACIÓN |
| OB-04 | Observador local auténtico | Mantener readiness UNKNOWN sin evidencia externa | LISTO | `docs/local-observer.md` y [PR #484](https://github.com/pl0n3r/FactoryRunner/pull/484) | — | OFFLINE |

## Resumen final

| Estado | Filas |
| --- | ---: |
| LISTO | 22 |
| EN_CURSO | 0 |
| SIN_COBERTURA | 27 |
| DEL_DUEÑO | 10 |
| NO_APLICA | 8 |
| TOTAL | 67 |

**Hojas nuevas creadas en este despacho: 3**, [#607](https://github.com/pl0n3r/FactoryRunner/issues/607), [#608](https://github.com/pl0n3r/FactoryRunner/issues/608) y [#609](https://github.com/pl0n3r/FactoryRunner/issues/609). **Hojas existentes reutilizadas: 2**, [#605](https://github.com/pl0n3r/FactoryRunner/issues/605) y [#606](https://github.com/pl0n3r/FactoryRunner/issues/606). **Sin cobertura todavía: 27 filas**; las 5 hojas canónicas enlazadas están bloqueadas, sin ejecución real. `LISTO` corresponde solo a 22 contratos OFFLINE, no a readiness productiva.

### Qué bloquea el go-live

- **Decisión OWNER y legal:** falta voto explícito nuevo de activación, aprobación de tratamiento de datos, responsables y cuentas, términos, presupuesto y límites. La opción #431/A no lo sustituye.
- **Infraestructura y ControlBot:** falta conexión autenticada, identidad, acceso externo seguro, DNS/TLS, monitoreo y observador auténtico (hojas #605, #606, #608).
- **Continuidad real:** faltan backup/restore probados en DB disposable, Drive cold-copy y S3 versionado/Object Lock, RPO/RTO y rollback de datos genuinos (hoja #607).
- **Operación/seguridad y smoke:** faltan negativa de permisos, aislamiento real, soporte, accesibilidad cuando aplique, p95, smoke exact-version/SHA y kill switch real (hojas #608/#609).

**Criterio de salida:** solo una decisión de activación posterior, permisos/verificación legal, evidencias reales terminales de cada puerta, `HEALTH 200`/versión/SHA exactos donde aplique, respaldo y rollback efectivos, CI exact-HEAD en verde y smoke real podrían habilitar una evaluación posterior. Este documento **no realiza** despliegues, migraciones, compras ni reconfiguración.

**Regresión:** `python3 -m unittest tests.test_lista_salida_produccion`. El CI completo usa `python3 -m unittest discover -s tests -p 'test_*.py'`. La reversión del squash retira únicamente esta documentación y su test.
