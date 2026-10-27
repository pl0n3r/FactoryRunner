# FactoryRunner #608 — preparación técnica Hostinger, sin activación

**Estado: OFFLINE / NO GO.** El repositorio permanece en fase
"construccion"; el preflight conserva "live_authorized=false" y
"readiness=UNKNOWN". No se contacta Hostinger ni ControlBot, se modifica DNS,
se activan cron/servicios ni se inspeccionan credenciales.

## Autoridad y separación de decisiones (AC-01)

La [puerta #612](https://github.com/pl0n3r/FactoryRunner/issues/612)
terminó con voto OWNER **A** y journal oficial v2. Esa A habilita **únicamente**
preparación documental y tests negativos offline del Issue #608, sin superar la
suspensión para operaciones reales de #465. No concede permiso de consulta
Hostinger: antes de cualquier lectura autenticada deberán existir una decisión
independiente que identifique titular, cuenta/alias, dominio, operador, permisos,
propósito, privacidad/consentimiento, límites de costo y entorno verificable.
No se registrarán valores de contraseña, token, DSN, cookies ni datos personales.
Los permisos D-059 de lectura/diagnóstico **no sustituyen** esta decisión humana
específica del Issue ni autorizan operaciones de producción.

Requiere además prueba auténtica de un backup **con restore** a entorno aislado,
rollback verificado, kill switch efectivo y ventanas/umbrales definidos. Cualquier
permiso ambiguo, caducado, incompatible o evidencia faltante: "BLOCKED", nunca
"GO". Ni un permiso declarado por un caller ni la aprobación de preparación
constituyen autorización independiente para usar un servicio real.

## Inventario operativo exigido, no verificado

| Brecha | Medición requerida de fuente autenticada | Rechazo seguro |
| --- | --- | --- |
| DNS-02 | DNS y TLS emitidos al hostname aprobado, SAN, expiración, redirección a HTTPS y cadena | DNS/hostname distinto, TLS vencido o sin identidad de fuente |
| DNS-03 | Aislamiento de orígenes, pinning del hostname, listeners públicos y rutas no autorizadas | Exposición accidental, redirección insegura o wildcard inesperado |
| SE-02 | Mapa de alias opacos, menor privilegio, rotación/revocación y custodia fuera del repo | Credencial en orden, log o commit; secreto sin custodio |
| CO-03 | Cuotas Hostinger Shared, CPU/memoria, cron, conexiones, polling HTTPS, p95/carga y costos | Límite desconocido, falta de presupuesto, p95 por encima de umbral aprobado |
| MO-03 | Señales HEALTH, error, saturación y alertas con destinatario y acuse | Canal o destinatario ausente, stale, sin ventana ni umbrales |
| SU-02 | Operación diaria de scheduler/cron, aislamiento por ejecución, soporte y escalación | Reintento sin idempotencia, logs inseguros o sin responsable |
| CR-02 | Reserva de capacidad y reversión/rollback real | Falta backup con restore comprobado o recuperación no probada |

Hostinger Shared no presupone root, Docker, Chromium local ni puertos
entrantes. Solo conexiones/cron admitidos por el proveedor tras comprobación
autorizada; ningún fallback a macOS por conjetura. Las referencias a TLS, DNS,
HTTPS o capacidad son **criterios**, no mediciones ejecutadas en esta sesión.

## Procedimiento y custodia para evaluación real posterior (AC-02)

1. Identificar autorización específica del OWNER, operador, cuenta y entorno
   mediante canal independiente, con alcance read-only explícito y fecha de
   validez; comprobar legal/privacidad y límites. Sin ello: "NO GO".
2. En un futuro ejecutor autorizado, capturar los requisitos de cada fila sin
   revelar contenido sensible, con procedencia firmada/autenticada por el
   proveedor y evidencia exacta de versión/SHA del runner. No recopilar PII.
3. Por cada evidencia, registrar los campos "project", "surface", "test", "sha",
   "release", "environment", "observed_at" UTC, "source_ref", "window" y "result".
   La prueba de fuente, el custodio y el digest deben verificarse fuera del
   documento/repo; una cadena "source_ref" no acredita autenticación.
4. Verificar restauración en destino descartable y rollback sin tocar clientes,
   junto con kill switch y alertas/soporte, antes de cualquier carga real.
5. Comparar SHA, versión, operador, fecha, ventanas, muestras, p95 y límites
   con la fuente original. Registrar "UNKNOWN" si hay stale o drift. Ningún
   workflow "success" aislado constituye smoke productivo.

Las pruebas incluidas usan solo fixtures inventadas ("*.invalid") y parser
**sin I/O**. "preflight_status" jamás produce "GO" y hasta un manifest bien
formado devuelve "REQUIRES_EXTERNAL_VERIFICATION"; "provenance_status" siempre
retorna "UNVERIFIED_SOURCE" o "UNKNOWN" porque carece de un verificador real.

## Negativas de seguridad y calidad offline (AC-03)

- No permiso específico, identidad/cuenta ajena, modo con escritura, credenciales
  en un campo, DNS/TLS inseguro, privacidad/consentimiento sin acreditar: "BLOCKED".
- Cuota Hostinger, p95 o cron sin presupuesto, tráfico sin aislamiento,
  observabilidad/monitoreo sin soporte y escalado: "BLOCKED".
- Backup sin **restore**, rollback no ensayado, kill switch "PAUSED", sin
  verificación de capacidad real: "BLOCKED". No reintentar un job idéntico para
  disfrazar errores deterministas.
- CI "Validar", CodeQL/SonarCloud y CodeRabbit **solo FINAL** contrastados contra
  el HEAD exacto antes de considerar un PR; no sustituyen resultados externos.

## Evidencia terminal (AC-04) y NO GO

Un recibo productivo necesitaría "status=VALIDATED_IN_PRODUCTION", SHA exacto,
versión, entorno, timestamp UTC, fuente autenticada y "pending=[]", además de
pruebas operativas originales, permisos y controles reales verificables. Los
estados "DEPLOY_OBSERVED", "NO_OBSERVADO", "UNKNOWN", fixture sintética,
checks incompletos, drift y campos omitidos fallan cerrados. El validador puro
"terminal_status" **jamás devuelve validación productiva**, solo "UNKNOWN" o
"REQUIRES_EXTERNAL_VERIFICATION": falta un observador independiente autenticado.

Reproducción offline: python3 -m unittest tests.test_hostinger_ops_readiness -v.

Este cambio es reversible eliminando solo este documento y
"tests/test_hostinger_ops_readiness.py". No modifica infraestructura, secretos,
cuentas ni AutoFactory; un PR de preparación debe quedar DRAFT sin merge hasta
la evidencia operativa exigida por el Issue #608.
