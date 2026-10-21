Última actualización automática: 2026-10-18 UTC · SHA de origen de docs/privacidad: 4931b797bd0c3bc1d289edd9d6a7bfe94844d8b5

# Carpeta para revisión jurídica · FactoryRunner

**Estado literal:** documented_not_legally_approved.
**Producto:** pl0n3r/FactoryRunner · **Versión del repo:** 0.1.0 (package.json).
**Origen verificable:** árbol Git docs/privacidad con SHA 4931b797bd0c3bc1d289edd9d6a7bfe94844d8b5; no es el SHA de un commit completo.

**Para entregar:** toma estos seis archivos o paquete-completo.md y envíalos al abogado.
Son borradores técnicos; la revisión y aprobación jurídica siguen pendientes. No autorizan go-live.

## Índice de documentos y revisión solicitada

| Copia local | Fuente exacta | Validar o corregir |
| --- | --- | --- |
| aviso-privacidad.md | docs/privacidad/aviso-privacidad.md | Aviso, transparencia y consentimiento |
| canal-derechos.md | docs/privacidad/canal-derechos.md | Canal, procedimiento y plazos |
| politica-tratamiento.md | docs/privacidad/politica-tratamiento.md | Bases, finalidades, derechos y proveedores |
| registro-tratamientos.md | docs/privacidad/registro-tratamientos.md | Inventario de datos y tratamientos |
| retencion.md | docs/privacidad/retencion.md | Plazos y eliminación de datos |
| terminos-condiciones.md | docs/privacidad/terminos-condiciones.md | Condiciones y límites del servicio |
| paquete-completo.md | Índice más las seis fuentes íntegras | Entrega consolidada |

## Hechos pendientes del responsable (no se inventan datos)

- [ ] Razón social o nombre del responsable
- [ ] Número de identificación / NIT aplicable
- [ ] Dirección física y domicilio de notificaciones
- [ ] Contacto para el ejercicio de derechos
- [ ] Procedimiento, requisitos y plazos de solicitudes
- [ ] Bases jurídicas, consentimiento, retención y transferencias
- [ ] Condiciones del servicio, jurisdicción y garantías

## Proveedores/subprocesadores documentados

Según datos.yml, tratamiento runner_location_metadata: campo location,
finalidad runner_routing. **Proveedores declarados: ninguno declarado**.
La ausencia de un proveedor declarado no prueba ausencia de subprocesadores reales.

AGENTES.md identifica a ControlBot como plano de control interno y a Hostinger
Shared/Web Hosting como objetivo de infraestructura. Esa arquitectura no demuestra
que un tercero ya procese datos, ni que exista despliegue o contrato de servicios.
El abogado debe verificarlo; no se añaden proveedores supuestos.

## Sincronización

scripts/generar_revision_juridica.py copia los seis documentos byte por byte y
genera el índice y el paquete. --check verifica sin escribir. Un workflow revisa
los cambios y abre un Issue único de desfase, sin escribir en main.

**Fase declarada:** construccion. **Estado jurídico:** pendiente de revisión.
