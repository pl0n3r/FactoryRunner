# FactoryRunner — verificación de cobertura 01/02 · Issue #693

**Corte exacto de código:** `main@fc509b8e545576cf34a342e5db1094425e6f0429` · **Fase:** `construccion` · **Rango:** 16 filas (11 `NO_VERIFICABLE`, 5 `SIN_COBERTURA`).

## Criterio de evidencia y autoridad

Los testigos son tests TS/Python preexistentes que ejecutan funciones del producto con entradas sintéticas y drivers sin red. El reporte **no acredita** fuentes, conexiones, HEALTH, capacidad, aprobación legal, Hostinger, backup/restauración, Google Drive ni go-live reales. **No hay recibo productivo** y se conserva `live_authorized=false` y `readiness=UNKNOWN`. **La verificación offline no permite go-live** ni actualiza `docs/matriz-cobertura.md`.

Las cinco filas `SIN_COBERTURA` son brechas de *fase REAL/OPERACIÓN*, no ausencias absolutas de código. Su autoridad externa no se obtiene por testigo local. No abrir hojas hijas duplicadas: #605 (slice offline completado; real no acreditado), #606 (read-only real, roster/heartbeat y #465, bloqueado), y #465 (decisión OWNER pendiente). #608 es el PR de Hostinger con QA offline en borrador; tampoco autoriza operación. Todo resultado externo sigue `UNKNOWN` hasta permiso/identidad y prueba terminal independientes.

## Registro de las 16 filas

| ID | Estado | Fase | Fuente | Predicado normativo exacto | Testigo TS/Python | Caso exacto | Seguimiento |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `RM-07` | `SIN_COBERTURA` | `REAL` | `README.md` | `Conexión a ControlBot real con transporte/identidad autorizados` | `tests/controlbot-client-contracts.test.ts` | `poll rejects identical and conflicting duplicate order ids` | `#605` |
| `RM-08` | `NO_VERIFICABLE` | `OPERACIÓN` | `README.md` | `Runner desplegado en Hostinger con /health y SHA exactos` | `tests/go-live-preflight.test.ts` | `all offline proofs enable preparation but never operation` | `—` |
| `RM-12` | `NO_VERIFICABLE` | `REAL` | `README.md` | `Sin HTTPS o credenciales reales desde README/cockpit` | `tests/test_factoryrunner_https_transport.py` | `FactoryRunnerHttpsTransportTests.test_transport_timeout_http_error_or_sensitive_output_fails_closed` | `—` |
| `RM-13` | `NO_VERIFICABLE` | `REAL` | `README.md` | `No evadir CAPTCHA, MFA ni rate limits del proveedor` | `tests/remote-adapters-no-evasion.test.ts` | `CAPTCHA, MFA and rate limits stop every remote adapter with one request and unchanged identity` | `—` |
| `RM-14` | `NO_VERIFICABLE` | `REAL` | `README.md` | `Runner no amplía por sí mismo capacidades ni autoridad` | `tests/runner-no-self-escalation.test.ts` | `unregistered execution requests are rejected, recorded and never expand manifest` | `—` |
| `GL-04` | `SIN_COBERTURA` | `REAL` | `docs/go-live-preflight.md` | `HEALTH y protocolo de ControlBot real autenticados` | `tests/controlbot-health-contract.test.ts` | `unsigned, malformed, changed or untrusted evidence fails closed` | `#605` |
| `GL-05` | `NO_VERIFICABLE` | `OPERACIÓN` | `docs/go-live-preflight.md` | `Aprobación legal/privacidad antes de PII y sesiones reales` | `tests/go-live-preflight.test.ts` | `reports cannot elevate live authority regardless of gate combinations` | `—` |
| `GL-06` | `NO_VERIFICABLE` | `OPERACIÓN` | `docs/go-live-preflight.md` | `Hostinger permisos, endpoints HTTPS y credenciales por operación` | `tests/go-live-preflight.test.ts` | `ambiguous, spoofed or invalid evidence never accepted` | `#608` |
| `GL-07` | `NO_VERIFICABLE` | `OPERACIÓN` | `docs/go-live-preflight.md` | `Backup con restauración y rollback reales verificados` | `tests/recovery-rehearsal-plan.test.ts` | `AC-04 no synthetic outcome grants real backup, restore, rollback or live authority` | `#608` |
| `GL-08` | `NO_VERIFICABLE` | `OPERACIÓN` | `docs/go-live-preflight.md` | `Switch, smoke, version y SHA comprobados en desplegado real` | `tests/kill-switch-rollback-rehearsal.test.ts` | `AC-01 tras el kill switch no se aceptan ejecuciones nuevas` | `#608` |
| `LOC-11` | `SIN_COBERTURA` | `REAL` | `docs/local-observer.md` | `Fuente de observación real autenticada y autorizada` | `tests/local-observer-source-adapter.test.ts` | `AC01 synthetic capacity export renders only synthetic UNKNOWN observer view` | `#606` |
| `LOC-12` | `SIN_COBERTURA` | `OPERACIÓN` | `docs/local-observer.md` | `Capacidad READY y heartbeat genuinos desde runners desplegados` | `tests/local-observer-empty-roster.test.ts` | `AC01 renderer direct FRESH empty roster rejects positive capacity` | `#606` |
| `LOC-13` | `NO_VERIFICABLE` | `REAL` | `docs/local-observer.md` | `Datos de usuario fuera de UI sin revisión de privacidad` | `tests/local-observer-no-pii.test.ts` | `AC-02: missing, ambiguous and poisoned personal data always fail closed` | `#606` |
| `RC-04` | `SIN_COBERTURA` | `OPERACIÓN` | `docs/reconciliacion-issues-20261024.md` | `Readiness real de #465 aún pendiente` | `tests/go-live-preflight.test.ts` | `reports cannot elevate live authority regardless of gate combinations` | `#465/#606` |
| `DB-04` | `NO_VERIFICABLE` | `OPERACIÓN` | `docs/recovery-database.md` | `Snapshot/restauración real DB verificados` | `tests/recovery-database-adapter.test.ts` | `restore is disposable only and rejects production targets` | `#608` |
| `GD-04` | `NO_VERIFICABLE` | `OPERACIÓN` | `docs/recovery-google-drive.md` | `Operación Drive con cuenta/permisos reales` | `tests/recovery-google-drive-adapter.test.ts` | `driver boundary rejects credential material URLs and extra fields` | `#608` |

## Resultado y brecha por fila

- **RM-07:** La API mock y las pruebas de sesión autentican formato, no endpoint real. #605 cerrado por slice offline; recibo REAL sigue ausente.
- **RM-08:** Preflight offline siempre false; Hostinger /health, operador, versión y SHA nunca observados.
- **RM-12:** Transporte HTTPS/credenciales por referencia probados con fakes, no certificar sesión ControlBot real.
- **RM-13:** Retos CAPTCHA/MFA/rate-limit detienen ejecución simulada y no alteran identidad; no observado con proveedor real.
- **RM-14:** Capability drift y admisión sintética se bloquean, no existe autorización externa para nuevas capabilities.
- **GL-04:** HEALTH firmado con key de simulador y nonce; falta identidad ControlBot real, D-043 y recibo terminal (#605).
- **GL-05:** En datos.yml bases/retención/consentimiento review_required, responsable sin completar; sin PII/usuario real.
- **GL-06:** Hostinger requiere permiso real, HTTPS y credenciales externas; #608 DRAFT y evidencias pendientes.
- **GL-07:** Plan de backup/restore/rollback con fixtures no acredita restauración real; #608 pendiente.
- **GL-08:** Kill switch y rollback sintéticos no sustituyen deploy/smoke/version/SHA observados.
- **LOC-11:** DTO synthetic_only y UNKNOWN; fuente read-only auténtica requiere autorización #465 / #606.
- **LOC-12:** Fixture con roster vacío no autoriza capacidad READY real; #606 bloqueado.
- **LOC-13:** Pruebas PII sintéticas no sustituyen consentimiento y base jurídica real; #606.
- **RC-04:** #465 pendiente como puerta de dirección; falso permiso go-live nunca se deriva de pruebas offline.
- **DB-04:** Restauración solo en target disposable in-memory; DB real y recibo verificado quedan pendientes.
- **GD-04:** Adapter cold_copy acepta referencias opacas; no cuenta OAuth, permiso o recibo de proveedor real.

## Ejecución y falsación

- `python3 -m unittest -v tests.test_verificacion_factoryrunner_01`: comprueba inventario 16/16 versus la matriz original, estados, fuentes, títulos exactos, presencia de testigos, negativos de omisión/duplicación/promoción falsa y ejecuta las suites TypeScript reales más el contrato Python de transporte HTTPS.
- Los tests TS ejercitan escenarios negativos explícitos: identidades/nonce inválidos, órdenes duplicadas, capacidades nuevas, CAPTCHA/MFA/rate-limit, evidencia stale, presencia de PII, rostros vacíos, restauración no desechable, credenciales/URLs OAuth o DB prohibidas y pruebas de go-live inválidas; ningún test realiza operaciones externas.
- AC-01 acredita **revisión documental y subcontroles**; no cierra brechas REAL/OPERACIÓN. AC-02 demuestra fallo ante degradación del material de prueba y controles del producto. AC-03 requiere `ci / Validar` autenticado terminal en SHA exacto del PR; no se presume por el pase local.
- Riesgo acotado a dos archivos de documentación/tests; sin cambios a código productivo, workflows, matriz, proveedores, cuentas, datos personales, secretos o infraestructura. Revert del squash elimina ambos archivos; ninguna operación debe deshacerse en sistemas externos.
