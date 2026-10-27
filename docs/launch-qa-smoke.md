# FactoryRunner #609 · QA de lanzamiento, contrato de preparación

Estado actual: **PREPARACIÓN OFFLINE SOLAMENTE**. Esta especificación no constituye
acreditación de un despliegue ni habilita servicios, usuarios, tráficos,
credenciales, datos personales, cambios de DNS o gasto.

## Autoridad verificada y límites

La puerta [#611](https://github.com/pl0n3r/FactoryRunner/issues/611) fue resuelta
con opción A mediante voto humano y journal v2. Su alcance es únicamente
preparación documental y de pruebas reversibles de #609. No revoca ninguna
condición de privacidad, consentimiento, control de servicio, aprobación de
operación real ni la prohibición de activar un runtime sin puerta posterior.
La puerta [#431](https://github.com/pl0n3r/FactoryRunner/issues/431) permitió
solo preflight offline. `docs/go-live-preflight.md` continúa reportando
`live_authorized=false`, `readiness=UNKNOWN` y el observador local tiene
`synthetic_only`. La decisión #611/A no autoriza automáticamente pasar esas
variables a otro estado.

## AC-01 · Autoridad, privacidad y ámbito de servicio

Antes de CUALQUIER ensayo autenticado en infraestructura real, exigir recibos
independientes y verificables de: identidad/autorización del OWNER y operador;
identidad y permisos exactos del entorno; finalidad, minimización, privacidad,
legal/consentimiento según aplique; límites de tráfico, carga y presupuesto;
backup verificado con RESTORE real y procedimiento de rollback; kill switch
funcional y límites del proveedor. Ausencia, obsolescencia o identidad ambigua:
`BLOCKED`, nunca `GO`.

## AC-02 · Evidencia, procedencia y cadena de custodia

Diseñar una captura **read-only** cuya ejecución necesita permisos posteriores.
El recibo de cada observación deberá contener proyecto, superficie, prueba,
versión, SHA Git de 40 hex, identificador de entorno no sensible, observación UTC,
run/artifact de origen, ventana/muestras, resultado y autenticación comprobable
por la fuente independiente. No almacenar secretos, correos, teléfonos,
identificadores reales, payloads privados ni datos empresariales en GitHub.
No usar un valor `verified=true` enviado por un caller como autenticación.
No comparar muestras de builds distintos como BEFORE/AFTER atribuible sin
procedimiento documentado y una intervención autorizada.

Los campos de la estructura offline se denominan `project`, `surface`, `test`,
`sha`, `release`, `environment`, `observed_at`, `source_ref`, `window` y
`result`, todos como cadenas no vacías; `observed_at` representa UTC. El
parser local valida la estructura pero siempre devuelve `UNVERIFIED_SOURCE`
aunque el manifest declare `PASS`. La cadena no puede autenticar su fuente.

La procedencia solo puede pasar a VERIFIED por un verificador autenticado,
independiente del manifest; una cadena o JSON proporcionados por el agente no
se consideran prueba. El código offline no implementa esa autenticación.

## AC-03 · Matriz de ensayos negativos y puertas técnicas

| Frente | Negativo / condición de fallo | Prueba requerida en entorno autorizado |
| --- | --- | --- |
| Identidad y permisos | missing/expired token, actor no autorizado, tenant cruzado | petición denegada, sin efectos |
| Seguridad | SAST/SCA high/critical sin evaluar, tráfico no permitido | CodeQL/SonarCloud + revisión concreta |
| Accesibilidad | teclado bloqueado, foco perdido, semántica incompleta | resultado real aplicable a interfaz de operador |
| Rendimiento | p95 sin muestras, sin budget contractual o por encima del budget contractual | muestra atribuible a SHA y ventana |
| Smoke y HEALTH | endpoint sin 200, SHA/version distintos, stale | verificación autenticada del servicio real |
| Kill switch | PAUSED no detiene operaciones | ensayo controlado, sin tráfico real no autorizado |
| Rollback | backup sin restauración, recovery desconocido | restore y rollback probados antes de activación |

En el preflight offline, `backup_restore=PASS`, `rollback=PASS` y
`kill_switch=RUNNING` son únicamente aserciones sintéticas de estructura.
Sus valores omitidos, distintos o no terminales producen `BLOCKED`; incluso
cuando son válidos el resultado nunca pasa de
`REQUIRES_EXTERNAL_VERIFICATION`. Una aserción del caller no es evidencia de
restore real ni un kill switch auténtico.

### Soporte diario: aceptación reversible, no operación LIVE

Antes de autorizar soporte real, exigir un inventario explícito de señales
(HEALTH, errores, p95, tasa de fallos y capacidad) con identidad de fuente,
ventana, presupuesto/umbral contractual y operador designado; sin mediciones o
umbrales aprobados registrar `UNKNOWN`, nunca `GREEN`. Ante cualquier alerta
crítica simulada, exigir ruta de escalamiento, responsable y constancia de
recepción: sin responsable o acuse el resultado de aceptación es `BLOCKED`.
Un incidente simulado debe incluir criterio de contención, plan de rollback
validable y condición de cierre auditada; si falta, mantener `UNKNOWN` y
`NO LIVE`. Estas pruebas documentales no contactan personas ni automatizan
operación, órdenes, guardias o servicios.

Todas las pruebas negativas locales son sintéticas y no verifican servicios
externos. CI `Validar`, SonarCloud/CodeQL exact-HEAD y revisión FINAL son
necesarios para el PR, pero nunca acreditan por sí mismos un runtime LIVE.

## AC-04 · Evidencia terminal y decisión

Una evaluación de producción solo puede aceptar el estado literal
`VALIDATED_IN_PRODUCTION` con SHA/release/entorno exactos, checks de transición
vacíos, observador real fresco y verificación independiente de su procedencia.
`DEPLOY_OBSERVED`, `NO_OBSERVADO`, `UNKNOWN`, missing/partial, stale, unverified,
`synthetic_only` y un workflow `success` sin artifacts NO satisfacen el AC.
Este módulo mantiene la salida `UNKNOWN` a falta de una fuente confiable y
**no hace llamadas de red ni marca producción verde**.

## Cómo ejecutar la preparación offline

`python3 -m unittest tests.test_launch_qa_smoke -v`

Las cuatro pruebas implementan los targets AC-01..04 y comprueban rechazos
fail-closed ante fixtures inventadas, no simulan certificados reales ni
exigen credenciales. Para demostrar el AC real posteriormente se necesita
un expediente independiente de origen autenticado, permiso operativo,
ambiente real y resultados terminales verificables. Las acciones sobre
infraestructura conservan una puerta separada y quedan FUERA de este parche.

## Riesgo y reversión

Solo se crean este documento y `tests/test_launch_qa_smoke.py`.
Sin listeners, fetch, servicios, mutaciones de datos ni secretos.
La reversión elimina los dos archivos mediante un revert del commit.
