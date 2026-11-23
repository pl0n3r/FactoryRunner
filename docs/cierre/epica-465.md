# Acta de cierre — FactoryRunner #465: Observador Local V1

> Alcance cerrado: **prototipo local, sintético, opt-in, de solo lectura**. Esta acta **no** autoriza fuente real, instalación en el Mac, conexión a ControlBot, Hostinger, tratamiento de datos personales, despliegue ni go-live.

**Issue padre:** [#465](https://github.com/pl0n3r/FactoryRunner/issues/465)  
**Hoja de verificación:** [#714](https://github.com/pl0n3r/FactoryRunner/issues/714)  
**Fecha de auditoría:** 2026-11-22  
**Base examinada:** [`main@9e721851e4625d9ac619910a99b589a200366fa8`](https://github.com/pl0n3r/FactoryRunner/commit/9e721851e4625d9ac619910a99b589a200366fa8)  
**Fase:** `construccion`. **Estado del producto:** `synthetic_only` / `readiness=UNKNOWN`.

## Matriz de aceptación original de #465

| Criterio | Estado del alcance sintético | Implementación y revisión fusionadas | Evidencia reproducible |
| --- | --- | --- | --- |
| **AC-01 — Snapshot, validación, stale, UNKNOWN y protección de datos** | **Cubierto en código** | [#466 / PR #470, squash `195526db`](https://github.com/pl0n3r/FactoryRunner/pull/470); endurecimiento posterior [#482 / PR #485](https://github.com/pl0n3r/FactoryRunner/pull/485) | [`src/local-observer-snapshot.ts`](https://github.com/pl0n3r/FactoryRunner/blob/9e721851e4625d9ac619910a99b589a200366fa8/src/local-observer-snapshot.ts) y [`tests/local-observer-snapshot.test.ts`](https://github.com/pl0n3r/FactoryRunner/blob/9e721851e4625d9ac619910a99b589a200366fa8/tests/local-observer-snapshot.test.ts) |
| **AC-02 — HTML hostil escapado, vacío, accesible y 390/1440** | **Cubierto en código** | [#467 / PR #469, squash `170c563d`](https://github.com/pl0n3r/FactoryRunner/pull/469); defensa adicional [#483 / PR #486](https://github.com/pl0n3r/FactoryRunner/pull/486) | [`src/local-observer-html.ts`](https://github.com/pl0n3r/FactoryRunner/blob/9e721851e4625d9ac619910a99b589a200366fa8/src/local-observer-html.ts) y [`tests/local-observer-html.test.ts`](https://github.com/pl0n3r/FactoryRunner/blob/9e721851e4625d9ac619910a99b589a200366fa8/tests/local-observer-html.test.ts) |
| **AC-03 — Servidor HTTP GET únicamente en loopback** | **Cubierto en código** | [#468 / PR #475, squash `7d658a03`](https://github.com/pl0n3r/FactoryRunner/pull/475) | [`scripts/local-observer-server.ts`](https://github.com/pl0n3r/FactoryRunner/blob/9e721851e4625d9ac619910a99b589a200366fa8/scripts/local-observer-server.ts), [`tests/local-observer-server.test.ts`](https://github.com/pl0n3r/FactoryRunner/blob/9e721851e4625d9ac619910a99b589a200366fa8/tests/local-observer-server.test.ts); [CI exact-HEAD `5af28c9b`](https://github.com/pl0n3r/FactoryRunner/actions/runs/38136865204) |
| **AC-04 — Integración con exports de Runner en fixtures tipadas** | **Cubierto en código, exclusivamente sintético** | [#476 / PR #477, squash `af2a8055`](https://github.com/pl0n3r/FactoryRunner/pull/477), [#478 / PR #481, squash `33dc01eb`](https://github.com/pl0n3r/FactoryRunner/pull/481), [#480 / PR #484, squash `e8867c7d`](https://github.com/pl0n3r/FactoryRunner/pull/484) | [`tests/local-observer-existing-exports.test.ts`](https://github.com/pl0n3r/FactoryRunner/blob/9e721851e4625d9ac619910a99b589a200366fa8/tests/local-observer-existing-exports.test.ts), [`tests/local-observer-source-adapter.test.ts`](https://github.com/pl0n3r/FactoryRunner/blob/9e721851e4625d9ac619910a99b589a200366fa8/tests/local-observer-source-adapter.test.ts); [CI exact-HEAD de #477](https://github.com/pl0n3r/FactoryRunner/actions/runs/38143694785) |
| **AC-05 — CI, revisión independiente y gobernanza exact-HEAD del cierre** | **Acreditado para los cambios sintéticos ya fusionados; cierre formal en #714** | [QA cruzada de #466 / PR #470](https://github.com/pl0n3r/FactoryRunner/pull/470), [revisión externa CodeRabbit de #468 / PR #475](https://github.com/pl0n3r/FactoryRunner/pull/475) y reservas V3 verificadas en esas entregas | [`ci / Validar` del HEAD exacto `main@9e721851`, success](https://github.com/pl0n3r/FactoryRunner/actions/runs/44996587884/job/137128881960), [SonarCloud sobre la misma rama y SHA](https://sonarcloud.io/dashboard?id=pl0n3r_FactoryRunner&branch=main); el PR de #714 debe acreditar sus propios gates antes de squash |

Los PR de AC-01..04 constan como **`closed/merged`** en GitHub; sus commits squash preceden al `main` auditado. No se interpreta una aprobación de código ni una ejecución de tests sintéticos como validación productiva. La revisión de CodeRabbit en [#475](https://github.com/pl0n3r/FactoryRunner/pull/475) contiene una recomendación trivial de mantenibilidad; no se le atribuye un hallazgo de seguridad alto/crítico sin evidencia.

## Pruebas y gobernanza

El [CI de `main@9e721851` (run #44996587884)](https://github.com/pl0n3r/FactoryRunner/actions/runs/44996587884) terminó `completed/success`: `ci / Validar`, validación Node y SonarCloud también quedaron `completed/success` para ese SHA. La documentación y las suites de regresión están versionadas en `main`, no dependen de observación real del equipo.

Para el **PR de cierre #714**, el estándar sigue siendo reserva oficial V3 propia, rama sin divergencia, `ci / Validar` terminal y análisis de seguridad sobre su **HEAD definitivo**, revisión CodeRabbit **FINAL una sola vez** después de CI verde y squash con protección intacta. Esta acta no afirma que esos checks de PR se hayan ejecutado antes de que GitHub los publique.

## Límites expresos: no-live y trabajo separado

La [documentación del Observador Local](https://github.com/pl0n3r/FactoryRunner/blob/9e721851e4625d9ac619910a99b589a200366fa8/docs/local-observer.md) confirma que el CLI solo inicia con `--demo`, escucha en `127.0.0.1` y su `GET /health` responde `{"mode":"synthetic_only","readiness":"UNKNOWN"}`. El [preflight de go-live](https://github.com/pl0n3r/FactoryRunner/blob/9e721851e4625d9ac619910a99b589a200366fa8/docs/go-live-preflight.md) conserva `live_authorized=false`.

La [instrucción OWNER de #465](https://github.com/pl0n3r/FactoryRunner/issues/465#issuecomment-6128276777) prohíbe trabajo **operativo nuevo** hasta decisión específica posterior. El cierre de la entrega sintética **no revoca esa decisión**, ni marca el servicio como READY, GREEN, desplegado o `VALIDATED_IN_PRODUCTION`.

Permanecen **abiertas y sin fingir cierre** hojas de requisitos reales que no pertenecen al entregable sintético: [#606 — fuente real, consentimiento y capacidad observada](https://github.com/pl0n3r/FactoryRunner/issues/606) y [#607 — backup, restauración y rollback auténticos](https://github.com/pl0n3r/FactoryRunner/issues/607). Su desbloqueo necesita la autorización y la evidencia de operador, privacidad, seguridad y operación exigidas por sus propios contratos. Ya existen esas hojas; no se crea una duplicada.

## Dictamen del alcance

**AC-01..05 del Observador Local V1 sintético: evidencias identificadas y trazadas.** Es legítimo cerrar el **alcance documental/offline** de #465 después de que #714 cumpla su PR, CI y revisión finales. **No** es legítimo usar ese cierre para declarar operativas #606/#607 o para iniciar conectividad, uso de datos reales, despliegue o go-live. Si el gate de #714 no queda terminal en verde o aparece un hallazgo grave, se conserva abierto hasta resolverlo.
