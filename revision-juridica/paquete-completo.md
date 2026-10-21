# Paquete completo de revisión jurídica · FactoryRunner

Estado: documented_not_legally_approved. Contiene índice y fuentes íntegras.

## Índice de entrega

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

## Fuente: docs/privacidad/aviso-privacidad.md

# Aviso de privacidad y autorización

> Estado: borrador técnico generado; **revisión jurídica requerida**.

## Responsable

- Nombre o razón social: [COMPLETAR POR EL DUEÑO]
- Identificación: [COMPLETAR POR EL DUEÑO]
- Dirección: [COMPLETAR POR EL DUEÑO]
- Canal de derechos: [COMPLETAR POR EL DUEÑO]

## Producto

`pl0n3r/FactoryRunner`

## Tratamientos documentados

| Tratamiento | Categoría | Campos | Finalidad | Base documentada | Consentimiento | Proveedores | Retención |
| --- | --- | --- | --- | --- | --- | --- | --- |
| runner_location_metadata | location | location | runner_routing | review_required | review_required | ninguno_declarado | review_required |

## Autorización técnica pendiente

La integración que recoja autorización debe presentar una **casilla no premarcada** y un enlace visible a la política de tratamiento antes de registrar la decisión de la persona. Para tratamientos que requieran consentimiento explícito, la implementación debe conservar evidencia verificable de esa decisión.

Este borrador **no acredita que exista consentimiento**, no sustituye la revisión jurídica y no autoriza por sí mismo ningún tratamiento.

## Fuente: docs/privacidad/canal-derechos.md

# Canal para ejercer derechos sobre datos personales

> Estado: borrador técnico generado; **revisión jurídica requerida**.

Producto: `pl0n3r/FactoryRunner`

## Responsable y canal

- Nombre o razón social: [COMPLETAR POR EL DUEÑO]
- Identificación: [COMPLETAR POR EL DUEÑO]
- Dirección: [COMPLETAR POR EL DUEÑO]
- Canal de derechos: [COMPLETAR POR EL DUEÑO]

## Procedimiento pendiente

- Requisitos de la solicitud: [COMPLETAR POR EL DUEÑO] — revisión jurídica requerida.
- Flujo interno de atención: [COMPLETAR POR EL DUEÑO] — revisión jurídica requerida.
- Plazos aplicables: [COMPLETAR POR EL DUEÑO] — deben ser definidos con revisión jurídica; este kit no inventa un plazo legal.

El canal debe contemplar solicitudes de acceso, rectificación/corrección, actualización, portabilidad, supresión/eliminación o revocación del consentimiento cuando corresponda. La identidad, legitimación y representación deben verificarse antes de tramitar solicitudes; los procedimientos y plazos siguen sujetos a revisión jurídica. Este documento describe una frontera técnica y no constituye aprobación jurídica.

## Fuente: docs/privacidad/politica-tratamiento.md

# Política de tratamiento de datos personales

> Estado: documento técnico generado; **no constituye aprobación jurídica**.

## Responsable

- Nombre o razón social: [COMPLETAR POR EL DUEÑO]
- Identificación: [COMPLETAR POR EL DUEÑO]
- Dirección: [COMPLETAR POR EL DUEÑO]
- Canal de derechos: [COMPLETAR POR EL DUEÑO]

## Producto

`pl0n3r/FactoryRunner`

## Tratamientos documentados

| Tratamiento | Categoría | Campos | Finalidad | Base documentada | Consentimiento | Proveedores | Retención |
| --- | --- | --- | --- | --- | --- | --- | --- |
| runner_location_metadata | location | location | runner_routing | review_required | review_required | ninguno_declarado | review_required |

## Derechos y revisión

Las solicitudes de acceso, rectificación/corrección, actualización, portabilidad, supresión/eliminación o revocación del consentimiento, cuando corresponda, se canalizan mediante el canal de derechos indicado arriba, previa verificación de identidad y legitimación. La portabilidad no implica que exista un servicio automatizado de exportación. Las finalidades, bases, consentimientos, proveedores y retenciones aquí documentadas requieren la revisión jurídica aplicable antes de declararse aprobadas.

## Fuente: docs/privacidad/registro-tratamientos.md

# Registro de tratamientos

> Estado: inventario técnico generado; **revisión jurídica requerida**.

Producto: `pl0n3r/FactoryRunner`

## runner_location_metadata

- Categoría: `location`
- Campos de software: `location`
- Finalidad: `runner_routing`
- Base documentada: `review_required` (revisión jurídica requerida)
- Consentimiento: `review_required`
- Proveedores: ninguno_declarado
- Retención: `review_required`

## Fuente: docs/privacidad/retencion.md

# Tabla de retención

> Estado: calendario técnico documentado; **revisión jurídica requerida**.

Producto: `pl0n3r/FactoryRunner`

| Tratamiento | Categoría | Retención declarada | Máximo común |
| --- | --- | --- | --- |
| runner_location_metadata | location | review_required | review_required |

## Fuente: docs/privacidad/terminos-condiciones.md

# Términos y condiciones

> Estado: borrador técnico generado; **revisión jurídica requerida antes de publicación**.

Producto: `pl0n3r/FactoryRunner`

## Responsable

- Nombre o razón social: [COMPLETAR POR EL DUEÑO]
- Identificación: [COMPLETAR POR EL DUEÑO]
- Dirección: [COMPLETAR POR EL DUEÑO]
- Canal de derechos: [COMPLETAR POR EL DUEÑO]

## Condiciones pendientes de definición

- Condiciones comerciales: [COMPLETAR POR EL DUEÑO] — revisión jurídica requerida.
- Niveles de servicio (SLA), si aplican: [COMPLETAR POR EL DUEÑO] — revisión jurídica requerida.
- Garantías y limitaciones aplicables: [COMPLETAR POR EL DUEÑO] — revisión jurídica requerida.
- Jurisdicción y mecanismo de solución de controversias: [COMPLETAR POR EL DUEÑO] — revisión jurídica requerida.

Este documento no inventa ni presume condiciones del producto. Los hechos comerciales y jurídicos anteriores deben completarse y aprobarse antes de su uso público.

