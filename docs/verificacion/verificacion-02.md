# Verificación de cobertura FactoryRunner — lote 02 de 2 (#694)

**Corte:** 5-nov-2026, desde `FactoryRunner/main@821e34cb954f816c3a97b208d9cfb068931fb046`. **Fase:** `construccion`, sin go-live.

## Decisión de evidencia

Estas 13 filas se contrastan contra código y tests existentes del repositorio. **0 promociones** a `CUBIERTO`: una prueba con fakes verifica subcontroles técnicos, no proveedor, consentimientos, restauraciones ni HEALTH productivo. Los 2 `SIN_COBERTURA` se conservan para el predicado completo y enlazan sus hojas hijas previas: **[#606](https://github.com/pl0n3r/FactoryRunner/issues/606)** (`OPEN/bloqueado`) y **[#605](https://github.com/pl0n3r/FactoryRunner/issues/605)** (`CLOSED`, cierre únicamente offline). Ninguno acredita permiso para operar. No se edita `docs/matriz-cobertura.md`; la consolidación tiene su propia hoja.

**No se inicia observación real** hasta nueva dirección específica del OWNER de #465 y puertas de privacidad/HEALTH/backup. El mandato actual para #694 permite únicamente esta verificación de pruebas y documentos, no cambia `live_authorized=false`/`readiness=UNKNOWN`. Nunca se usa un resultado `success` offline como prueba de producción.

Clases de limitación: **B**=subcontrol real probado con fake, pero falta recibo externo; **C**=contenido legal o contractual sin aprobación; **D**=predicado realmente ausente/bloqueado con hoja hija identificada, aunque existan testigos negativos.

## Trazabilidad por fila

| ID | Estado inicial | Clase | Fuente | Testigo exacto | Evidencia pendiente / acción segura |
| --- | --- | --- | --- | --- | --- |
| `LO-07` | NO_VERIFICABLE | B | `docs/recovery-live-object-storage.md` | `tests/recovery-live-object-storage.test.ts::missing suspended or unknown versioning fails closed before object operation` | Faltan proveedor S3 real, versioning/Object Lock, credenciales autorizadas, retención y recibo de restore verificable |
| `RT-05` | NO_VERIFICABLE | B | `docs/recovery-runtime-e2e.md` | `tests/recovery-runtime-e2e.test.ts::cross-provider and cross-capability inputs fail closed before fake drivers run` | Solo drivers fake; faltan snapshots/restore real autorizado y evidencia de proveedores y políticas ControlBot |
| `KS-04` | NO_VERIFICABLE | B | `docs/runner-kill-switch-rehearsal.md` | `tests/kill-switch-rollback-rehearsal.test.ts::AC-01 tras el kill switch no se aceptan ejecuciones nuevas` | No hay simulacro real firmado de kill switch y rollback en infraestructura de producción |
| `I465-01` | SIN_COBERTURA | D | `FactoryRunner#465` | `tests/go-live-preflight.test.ts::reports cannot elevate live authority regardless of gate combinations` | No iniciar observación real: requiere revocación específica de la suspensión OWNER en #465. Hoja hija #606 sigue OPEN/bloqueada; testigo solo protege NO_GO offline |
| `I465-03` | SIN_COBERTURA | D | `FactoryRunner#465` | `tests/controlbot-health-contract.test.ts::unsigned, malformed, changed or untrusted evidence fails closed` | Faltan ControlBot HTTPS real, identidad/protocolo/HEALTH autenticados y decisión OWNER; hija #605 cerrada acredita solo fake/offline, no operación |
| `PA-01` | NO_VERIFICABLE | C | `docs/privacidad/aviso-privacidad.md` | `tests/test_cobertura_factoryrunner_01.py::CoberturaFactoryrunner01Tests.test_contrato_principal` | Responsable, domicilio e identificación y canal de derechos permanecen como [COMPLETAR POR EL DUEÑO] |
| `PA-02` | NO_VERIFICABLE | B | `docs/privacidad/aviso-privacidad.md` | `tests/go-live-preflight.test.ts::all offline proofs enable preparation but never operation` | La casilla no premarcada se exige en borrador; faltan UI real, consentimiento específico y recibo autenticado |
| `PC-01` | NO_VERIFICABLE | C | `docs/privacidad/canal-derechos.md` | `tests/test_cobertura_factoryrunner_01.py::CoberturaFactoryrunner01Tests.test_contrato_principal` | Procedimiento/legitimación, plazos y contacto real siguen sin aprobación jurídica/OWNER |
| `PP-01` | NO_VERIFICABLE | C | `docs/privacidad/politica-tratamiento.md` | `tests/test_cobertura_factoryrunner_01.py::CoberturaFactoryrunner01Tests.test_contrato_principal` | Finalidad, base legal y derechos no cuentan con aprobación jurídica ni consentimiento real |
| `PRG-01` | NO_VERIFICABLE | C | `docs/privacidad/registro-tratamientos.md` | `tests/test_cobertura_factoryrunner_01.py::CoberturaFactoryrunner01Tests.test_contrato_principal` | runner_location_metadata sigue review_required; base, consentimiento, proveedores y custodia sin autorización |
| `PRT-01` | NO_VERIFICABLE | C | `docs/privacidad/retencion.md` | `tests/test_cobertura_factoryrunner_01.py::CoberturaFactoryrunner01Tests.test_contrato_principal` | No se aprobaron plazo de retención y máximo de borrado; ambos review_required |
| `PTC-01` | NO_VERIFICABLE | C | `docs/privacidad/terminos-condiciones.md` | `tests/test_cobertura_factoryrunner_01.py::CoberturaFactoryrunner01Tests.test_contrato_principal` | Términos, garantías, SLA, jurisdicción y protección legal son borrador sin aprobación |
| `PTC-02` | NO_VERIFICABLE | C | `docs/privacidad/terminos-condiciones.md` | `tests/test_cobertura_factoryrunner_01.py::CoberturaFactoryrunner01Tests.test_contrato_principal` | Identificación del responsable, contacto de soporte y controversias no están confirmados |

## Aceptación reproducible

- `python3 -m unittest discover -s tests -p 'test_verificacion_factoryrunner_02.py' -v`: inventario 13/13, identificación exacta de suites y ejecución de regresiones TS en Node 24 contra código real con drivers sintéticos. Los negativos de versión, retención, restore productivo, kill switch, autoridad offline y HEALTH falsificado detectan regresiones.
- El CI canónico es `ci / Validar` sobre el HEAD final del PR; SonarCloud, CodeQL y revisión final CodeRabbit se evalúan por SHA. No se declara ninguno verde antes de comprobarlo.
- Sin I/O productivo, host real, credenciales, datos personales, gastos, deploy ni cambios fuera de las dos rutas reclamadas. Reversión: revertir squash.

## Resultado

**13 filas verificadas documentalmente: 11 NO_VERIFICABLE, 2 SIN_COBERTURA, 0 promociones.** Lo que no puede probarse offline se conserva como brecha, no como cumplimiento.
