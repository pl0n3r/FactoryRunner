# FactoryRunner: observador local sintético (build-ahead)

El observador es opt-in, solo lectura y NO LIVE. No lee sesiones, procesos,
chats, perfiles o datos reales; no se conecta a ControlBot y no ejecuta órdenes
desde HTTP. No inicia servicio al instalar ni construir el proyecto.

## Arranque explícito

Con Node.js 24, desde la raíz del repositorio:

    node --experimental-strip-types scripts/local-observer-server.ts --demo --port=8765

Abrir http://127.0.0.1:8765/ en la misma máquina. Finalizar con Ctrl+C.
Sin --demo, el CLI no inicia listener. Puerto cero solo para pruebas.

## Seguridad

- Listener IPv4 fijo en 127.0.0.1; sin 0.0.0.0, IPv6, LAN, túneles,
  Internet ni HTTP saliente.
- Únicamente GET / (HTML estático de #467) y GET /health (readiness=UNKNOWN).
  No permite POST, órdenes, WebSocket, SSE, colas ni escritura.
- Host exacto 127.0.0.1:<puerto>, una sola cabecera. Origin, si existe,
  debe ser http://127.0.0.1:<puerto>. Deniega alias localhost, dominios
  externos, DNS rebinding y puertos distintos. Sin CORS ni redirecciones.
- CSP default-src 'none', style-src 'unsafe-inline' para CSS embebido,
  Cache-Control no-store, nosniff, frame-deny, timeouts y límite de tamaño.
- El módulo #466 normaliza el fixture y #467 escapa la vista. Inputs
  observed/cached/ambiguos se reducen a UNKNOWN sintético. La frescura
  relativa del heartbeat no valida frescura absoluta al momento de consulta.
- Errores sin eco de datos y sin credenciales. No se declaran READY reales.

## Justificación de HTTP local (regla Sonar S5332)

El diseño de esta **demo de construcción** usa HTTP en texto claro de manera
intencional solo en `127.0.0.1` para compatibilidad con una prueba Node sin
material criptográfico ni certificados. El único contenido permitido es
**sintético**, jamás secretos, datos reales ni credenciales. La conexión
requiere Host exacto, Origin local cuando se presenta, socket remoto loopback,
CSP y sin CORS. Los dos usos del literal `http://` llevan una excepción
`NOSONAR` circunscrita a esas dos líneas; **no** autorizan cambiar a
`0.0.0.0`, habilitar acceso remoto o servir fuentes reales. Si en un futuro
se conectan datos o se pretende acceso fuera del host, se deberá crear un
nuevo contrato con autenticación y TLS, sin reutilizar esta excepción.

## Pruebas y límites

    node --experimental-strip-types --test tests/local-observer-server.test.ts
    python3 -m unittest tests.test_local_observer_server_contract

AC-01..04 usan HTTP real solo en loopback con cierre determinista y datos
ficticios. No demuestran servidor instalado, producción, privacidad jurídica
aprobada ni autorización de go-live. CI exact-HEAD y revisión de QA/seguridad
siguen siendo puertas de integración. Revertir estos cuatro archivos
nuevos elimina íntegramente el prototipo.
