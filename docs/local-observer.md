# FactoryRunner: observador local sintético (build-ahead)

El observador es opt-in, solo lectura y NO LIVE. No lee sesiones, procesos,
chats, perfiles o datos reales; no se conecta a ControlBot y no ejecuta órdenes
desde HTTP. No inicia servicio al instalar ni construir el proyecto.

## Arranque explícito

Con Node.js 24, desde la raíz del repositorio:

    node --experimental-strip-types scripts/local-observer-server.ts --demo --port=8765

Abrir http://127.0.0.1:8765/ en la misma máquina. Finalizar con Ctrl+C.
Sin --demo, el CLI no inicia listener. Puerto cero solo para pruebas.

## Capas vigentes: demo frente a candidato interno

Las capas están integradas en el repositorio, pero **no están conectadas a una fuente de observación real**:

| Componente | Ruta | Frontera de confianza |
| --- | --- | --- |
| DTO de snapshot | `src/local-observer-snapshot.ts` | Normaliza y rechaza paquetes inválidos; no obtiene datos |
| Renderer HTML | `src/local-observer-html.ts` | Genera HTML escapado y fail-closed, sin aceptar READY inconsistente |
| Adaptador de exports | `src/local-observer-source-adapter.ts` | Proyecta **fixtures sintéticos** ya entregados por un llamador |
| Candidato in-process | `src/local-observer-runtime-projection.ts` | Función pura sobre exports *inyectados* y reloj explícito; **no** es colector |
| CLI HTTP demo | `scripts/local-observer-server.ts` | `--demo` opt-in, exclusivamente `127.0.0.1`, sin fuentes reales |

El candidato `kind=in_process_candidate` tiene `sample_freshness=FRESH|STALE|OFFLINE|UNKNOWN`, pero esa frescura describe **solo la edad de los datos suministrados**, no prueba que se estén observando runners. Incluso si un fixture resulta FRESH, `readiness=UNKNOWN`, `capacity.available=null`, la cola global y el último resultado siguen siendo UNKNOWN. **FRESH no autoriza READY ni live**.

El candidato **no se importa ni se sirve** desde `scripts/local-observer-server.ts`. El servidor sigue `synthetic_only`: `GET /health` responde `{"mode":"synthetic_only","readiness":"UNKNOWN"}`. Ninguna capa inicia servicios, lee procesos, chats o sesiones del Mac, envía órdenes ni modifica ControlBot/AutoFactory. Para una fuente real se requieren otro contrato, consentimiento/autorización y una interfaz autenticada separada; #465 permanece abierto. El issue de go-live #431 está CLOSED/completed tras la decisión OWNER A, limitada a preflight offline reversible. La activación live sigue sin autorización y exige otra decisión explícita del dueño, además de evidencia real de seguridad, privacidad y operación.

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
- El módulo #466 normaliza el fixture y #467 escapa la vista; #482 y #483
  refuerzan el rechazo de disponibilidad positiva sin roster verificable.
  `--demo` solo acepta datos sintéticos y siempre responde UNKNOWN.
- #478 y #488 aportan adaptadores puros para exports **inyectados**: uno
  sintético y otro candidato temporal. Ninguno observa procesos reales ni
  convierte datos FRESH en autoridad operativa.
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

Los AC-01..04 del servidor usan HTTP real solo en loopback con datos
ficticios. Las capas posteriores tienen pruebas independientes; por ejemplo:

    node --experimental-strip-types --test tests/local-observer-runtime-projection.test.ts
    python3 -m unittest tests.test_local_observer_runtime_projection_contract
    python3 -m unittest tests.test_local_observer_docs_contract

La suite global sigue siendo `npm test`, `npm run typecheck` y los contratos
Python ejecutados por CI. Estas pruebas **no** demuestran que el Observador
esté instalado, que haya una fuente real, privacidad jurídica aprobada ni
autorización de go-live.

## Rollback seguro y dependencias

El Observador se construyó en **múltiples PRs y commits**, no en cuatro archivos.
Para revertirlo:

1. Revisar el historial de los PRs/commits y el grafo de dependencias de las
   hojas #466, #467, #468, #476, #478, #480, #482, #483 y #488.
2. Preparar un PR de reversión con `git revert` de los **commits de merge**,
   en **orden inverso de dependencias**. No borrar cuatro archivos manualmente:
   dejarían imports, contratos y pruebas huérfanos. Si solo falla la capa
   candidata, considerar revertir únicamente su merge, verificando referencias.
3. Ejecutar `npm run typecheck`, `npm test`, contratos Python y CI exact-HEAD
   del PR. Revisar que no quedan imports colgantes ni cambios en las fronteras
   `synthetic_only`, `NO LIVE` y `readiness=UNKNOWN`.
4. Fusionar la reversión solo con coordinación/revisión y **CI exact-main** en
   verde. Esta guía no ejecuta comandos ni despliega nada.

No hay release ni despliegue nuevo por esta documentación. El objetivo del
rollback es restaurar código y pruebas de forma coherente, **no** manipular
datos reales ni evadir la puerta humana de #431.
