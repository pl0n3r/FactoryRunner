# FactoryRunner — reconciliación de issues abiertos

**Corte autenticado:** 24 de octubre de 2026, main@789a312d7520e9813835f99d8c4e5de5ee22cb2a. Alcance: los dos issues **abiertos** observados en GitHub al iniciar esta hoja (#465 y #600). Este es un corte histórico: cualquier issue creado o reabierto después necesita una nueva auditoría; esta tabla no presume un inventario perpetuo.

**Regla de cierre:** solo CERRAR con PR efectivamente fusionado en main, todos los criterios aceptados y CI terminal verde del SHA exacto, con enlaces al hecho real. Si falta cualquiera de esas pruebas, ACTUALIZAR o DEJAR ABIERTO; nunca cerrar por reducir el contador del backlog.

| Issue | Decisión | Motivo verificable | Evidencia |
| --- | --- | --- | --- |
| [#465](https://github.com/pl0n3r/FactoryRunner/issues/465) | DEJAR ABIERTO | El Observador Local integrado es solo synthetic_only y conserva readiness=UNKNOWN. Falta una fuente local auténtica autorizada y su verificación en equipo; #431 solo aprobó preflight reversible offline. La implementación sintética y su CI verde no completan el objetivo real. | [Estado y contratos #465](https://github.com/pl0n3r/FactoryRunner/issues/465); [decisión limitada #431](https://github.com/pl0n3r/FactoryRunner/issues/431); [CI exact-main](https://github.com/pl0n3r/FactoryRunner/actions/runs/40029930158) |
| [#600](https://github.com/pl0n3r/FactoryRunner/issues/600) | ACTUALIZAR | Hoja en ejecución para auditar los issues: clasificación reparada y reserva V3 auténtica de los dos archivos de este informe. Su aceptación y cierre solo se demostrarán después de tests, PR fusionado y CI exact-main posterior; no se declara completada por la creación del informe. | [Contrato #600](https://github.com/pl0n3r/FactoryRunner/issues/600); [recibo de reserva V3](https://github.com/pl0n3r/FactoryRunner/issues/600#issuecomment-6387616153) |

## Resultado y límites

- **Cerrados por esta auditoría:** ninguno: no hay evidencia nueva para cerrar #465 y #600 todavía es trabajo en curso.
- **#465:** conservar estado: planificado hasta que existan autorización, fuente local auténtica y evidencia de aceptación real; no confundir tests sobre fixtures con HEALTH productivo o runner conectado.
- **#600:** concluir únicamente con los dos archivos previstos, pruebas de aceptación y PR autorizado. Registrar la evidencia terminal en el propio issue cuando exista, sin editar este corte histórico retrospectivamente.
- **Sin efectos operativos:** esta reconciliación no altera servicios, datos personales, producción, ControlBot, configuraciones, permisos ni decisiones del propietario.
