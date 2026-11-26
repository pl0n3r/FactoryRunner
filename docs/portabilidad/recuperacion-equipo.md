# Recuperación portátil A → B: ensayo sintético (#718)

**OFFLINE exclusivamente.** No instala un runner real ni autoriza ejecución,
registro remoto, failover, pagos, proveedores, despliegue o continuidad productiva.

## Si el Mac deja de funcionar: ensayo en B

1. En un checkout separado de B, verificar release, versión y SHA por el canal
   aprobado; seguir [preflight](preflight.md) e [instalación](instalacion.md).
   Para este ensayo usar únicamente el fixture local de #717.
2. Ejecutar `node --experimental-strip-types --test tests/portable-recovery-manifest.test.ts`.
   El test fabrica un snapshot/handoff sintético, cifra un backup desechable
   con AES-GCM y material de prueba público, verifica descifrado e integridad;
   no reutilizar ese material con datos reales.
3. El verificador puro recibe bytes del backup cifrado, manifest con esquema,
   versión y SHA, pin SHA-256 independiente del control plane ficticio,
   snapshot y handoff canónicos. El pin es la raíz de confianza del ensayo:
   un hash autocontenido no autentica un origen. No implementa firma real
   ni descifrado productivo. El verificador no lee discos ni redes.
4. Generar identidad B distinta de A. Solo aceptar estado durable ficticio
   observado en los últimos 300 segundos, una identidad activa (B), lease A
   revocada, lease B nueva y vigente, generación estrictamente mayor y prueba
   de fencing por fingerprint sintético coincidente. Sin prueba o ante UNKNOWN,
   detener; jamás clonar identidad, lease, órdenes o token de A.
5. Persistir el recibo únicamente en el control plane **ficticio** del ensayo;
   una copia independiente de ese estado permite reconocer el mismo reintento
   sin replay ni ejecución. Un recibo distinto falla cerrado. Sin persistencia
   autoritativa y fencing real no existe garantía de exclusión productiva.

## Qué se recupera y qué no

| Fuente | Contenido |
| --- | --- |
| GitHub/release verificada | Código, versión, SHA, esquema y documentación |
| Control plane durable | Identidad, órdenes, estado, leases, fencing y recibos; aquí solo sintéticos |
| Cache local descartable | Journal/outbox y handoff como evidencia; nunca autoridad |
| Canal seguro separado | Credenciales y perfiles se reprovisionan, nunca se incluyen en backup/fixture/log |

El test no mide RPO/RTO de producción, no hace conexión a ControlBot ni a
Hostinger, y no sustituye #606/#607/#465 ni aprobación humana. El tiempo de
ejecución reportado por node:test corresponde exclusivamente al ensayo local.
Reversión: squash revert de los tres archivos de #718; ningún dato real afectado.
