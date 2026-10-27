# FactoryRunner #614 — contraste de las 22 filas no verificables

**Corte:** `main@a9228133d353726503c3a7d1d025a45a5e1b03a7` · reserva V3 `84234110-091f-4b3e-b6f8-c30ef6470547` · [Issue #614](https://github.com/pl0n3r/FactoryRunner/issues/614).

**Método:** se leyó cada requisito en su fuente y se buscó una implementación/documento candidato y una prueba existente en el árbol exacto de `main`. La **existencia** de una prueba offline no acredita que el requisito REAL/OPERACIÓN funcione. En privacidad no se encontraron tests genuinos de consentimiento o aprobación: se indica `SIN PRUEBA`, sin inventar evidencia.

## Veredictos por fila

| ID | Fuente | Archivo contrastado | Test candidato | Estado | Evidencia faltante original | Fase |
| --- | --- | --- | --- | --- | --- | --- |
| RM-08 | `README.md` | `src/go-live-preflight.ts` | `tests/go-live-preflight.test.ts` | NO_VERIFICABLE | Falta deploy autorizado, HEALTH productivo y recibo exact-SHA | OPERACIÓN |
| RM-12 | `README.md` | `src/controlbot/https-transport.ts` | `tests/test_factoryrunner_https_transport.py` | NO_VERIFICABLE | La portada enlaza panel restringido; falta evidencia de conectividad real | REAL |
| RM-13 | `README.md` | `src/browser-remote-origin-policy.ts` | `tests/test_factoryrunner_browser_remote_origin_policy.py` | NO_VERIFICABLE | Falta prueba contractual específica e inspección de adaptadores remotos que demuestre que no se eluden controles externos | REAL |
| RM-14 | `README.md` | `src/execution-admission.ts` | `tests/test_factoryrunner_admission.py` | NO_VERIFICABLE | Falta demostrar alcance completo en la conexión y ejecución reales; los tests offline no acreditan autorización operacional | REAL |
| GL-05 | `docs/go-live-preflight.md` | `datos.yml` | `tests/test_go_live_preflight_contract.py` | NO_VERIFICABLE | Falta aprobación legal y base legítima autenticada; datos.yml indica review_required | OPERACIÓN |
| GL-06 | `docs/go-live-preflight.md` | `src/go-live-preflight.ts` | `tests/go-live-preflight.test.ts` | NO_VERIFICABLE | Falta evidencia de hosting, límites y autorización independiente | OPERACIÓN |
| GL-07 | `docs/go-live-preflight.md` | `src/go-live-preflight.ts` | `tests/go-live-preflight.test.ts` | NO_VERIFICABLE | Sólo fakes/preflight; faltan recibos de restore y rollback reales | OPERACIÓN |
| GL-08 | `docs/go-live-preflight.md` | `src/go-live-preflight.ts` | `tests/go-live-preflight.test.ts` | NO_VERIFICABLE | Sin despliegue/observación genuinos ni VALIDATED_IN_PRODUCTION | OPERACIÓN |
| LOC-13 | `docs/local-observer.md` | `src/local-observer-source-adapter.ts` | `tests/test_local_observer_docs_contract.py` | NO_VERIFICABLE | Falta auditoría de tratamiento real y permiso por operación | REAL |
| DB-04 | `docs/recovery-database.md` | `src/adapters/recovery-database.ts` | `tests/recovery-database-adapter.test.ts` | NO_VERIFICABLE | Los drivers de pruebas son fake; faltan DSN fuera del repo, operador y recibo real | OPERACIÓN |
| GD-04 | `docs/recovery-google-drive.md` | `src/adapters/recovery-google-drive.ts` | `tests/recovery-google-drive-adapter.test.ts` | NO_VERIFICABLE | Sólo fake-injected; falta autorización/OAuth seguro y prueba del proveedor | OPERACIÓN |
| LO-07 | `docs/recovery-live-object-storage.md` | `src/recovery/live-object-storage.ts` | `tests/recovery-live-object-storage.test.ts` | NO_VERIFICABLE | Driver potencial existe; falta cuenta autorizada y atestación de S3 real | OPERACIÓN |
| RT-05 | `docs/recovery-runtime-e2e.md` | `docs/recovery-runtime-e2e.md` | `tests/recovery-runtime-e2e.test.ts` | NO_VERIFICABLE | Prueba sólo fake; faltan proveedores, identidad, backups/restore reales | OPERACIÓN |
| KS-04 | `docs/runner-kill-switch-rehearsal.md` | `scripts/rehearse-kill-switch-rollback.ts` | `tests/kill-switch-rollback-rehearsal.test.ts` | NO_VERIFICABLE | Recibo offline no es HEALTH y no hay deploy/rollback real autorizado | OPERACIÓN |
| PA-01 | `docs/privacidad/aviso-privacidad.md` | `docs/privacidad/aviso-privacidad.md` | SIN PRUEBA | NO_VERIFICABLE | Faltan identificación, dirección y canal del responsable: plantilla [COMPLETAR POR EL DUEÑO] sin aprobación jurídica | OPERACIÓN |
| PA-02 | `docs/privacidad/aviso-privacidad.md` | `docs/privacidad/aviso-privacidad.md` | SIN PRUEBA | NO_VERIFICABLE | Falta integración autorizada y evidencia de consentimiento real; plantilla técnica no prueba captura válida | REAL |
| PC-01 | `docs/privacidad/canal-derechos.md` | `docs/privacidad/canal-derechos.md` | SIN PRUEBA | NO_VERIFICABLE | Faltan responsable, flujo, plazos legales y revisión jurídica, sin canal operativo demostrado | OPERACIÓN |
| PP-01 | `docs/privacidad/politica-tratamiento.md` | `docs/privacidad/politica-tratamiento.md` | SIN PRUEBA | NO_VERIFICABLE | Faltan revisión jurídica y bases/consentimientos aprobados; política actual sigue siendo borrador | OPERACIÓN |
| PRG-01 | `docs/privacidad/registro-tratamientos.md` | `datos.yml` | SIN PRUEBA | NO_VERIFICABLE | Falta comprobación legal y funcional del tratamiento; base, consentimiento y retención son review_required | REAL |
| PRT-01 | `docs/privacidad/retencion.md` | `docs/privacidad/retencion.md` | SIN PRUEBA | NO_VERIFICABLE | Faltan plazos autorizados y revisión jurídica; ambos campos son review_required | OPERACIÓN |
| PTC-01 | `docs/privacidad/terminos-condiciones.md` | `docs/privacidad/terminos-condiciones.md` | SIN PRUEBA | NO_VERIFICABLE | Faltan condiciones del propietario y revisión jurídica previa a publicación | OPERACIÓN |
| PTC-02 | `docs/privacidad/terminos-condiciones.md` | `docs/privacidad/terminos-condiciones.md` | SIN PRUEBA | NO_VERIFICABLE | Faltan datos identificativos y mecanismo de controversias aprobados, sin evidencia de soporte real | OPERACIÓN |

## Alcance y continuidad

**Resultado: 22/22** filas con contraste reproducible; ninguna promovida a CUBIERTO o SIN_COBERTURA sin prueba real o hoja autorizada. Las obligaciones de ejecución y proveedor siguen sujetas a #605/#606 y a las puertas humanas de go-live, legalidad, consentimiento, protección de datos y permisos. `live_authorized=false`, `synthetic_only` y `readiness=UNKNOWN` conservan su significado.

La matriz añade CT-01 como **DESCARTADO únicamente como fuente de requisitos**: este informe es evidencia derivada, no un requisito funcional. Así el inventario tiene 78 filas: 47 CUBIERTO (offline), 0 EN_CURSO, 7 SIN_COBERTURA, 2 DESCARTADO y 22 NO_VERIFICABLE; **60.3%** de contratos documentales/offline, nunca de preparación productiva.

**Fuera de alcance:** ni deploy, cuenta de proveedor, datos reales, credenciales, Hostinger, browser automation, ControlBot conectado o activación live. No se crean Issues nuevos ni se modifican scripts fuera de la reserva.