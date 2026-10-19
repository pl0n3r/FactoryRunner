# Ensayo offline de kill switch y rollback — FactoryRunner #577

**Alcance:** `FakeRehearsalRunner` y `FakeRehearsalControlBot` en memoria. No modifica Factory#767, ni accede a ControlBot real, a producción o a secretos. La etiqueta `source_sha` fija el baseline de código `87b89bf5648710096e2d90a11f332412975a4771` antes de este PR; el `evidence_sha256` es el digest del recibo simulado, no una firma externa. El tiempo `observed_at` es un fixture reproducible, **no** el horario de ejecución.

## Ejecución local reproducible

```sh
node --experimental-strip-types scripts/rehearse-kill-switch-rollback.ts --source-sha 87b89bf5648710096e2d90a11f332412975a4771
python3 -m unittest tests.test_runner_kill_switch_rehearsal.RunnerKillSwitchTests.test_acceptance
```

El test ejecuta ese CLI sobre el entrypoint fake-only, contrasta el JSON con este archivo y repite el ensayo para detectar diferencias. Rechaza SHAs malformados; ni el script ni la prueba aceptan credenciales o URLs de ControlBot.

<!-- rehearsal-evidence-begin -->
```json
{
  "source_sha": "87b89bf5648710096e2d90a11f332412975a4771",
  "receipt": {
    "version": 1,
    "kind": "offline_fake_only",
    "observed_at": "2026-10-11T08:00:00Z",
    "paused_rejected_at_controlbot": true,
    "paused_rejected_at_runner": true,
    "rollback_restored": true,
    "original_runner_paused": false,
    "original_controlbot_paused": false,
    "evidence_sha256": "bbaa13a354f4014fec15c3732392c04a7bf9c916e73482b271740ad031274a2a",
    "result": "PASS"
  }
}
```
<!-- rehearsal-evidence-end -->

## Resultados y límites

- Pausa ControlBot simulada: no entrega una nueva orden.
- Pausa Runner simulada: no admite una orden ni por dispatch directo.
- Rollback: restaura instantáneas de ambos objetos in-memory.
- La huella del resumen sintetico puede validarse contra la serialización de `rehearseKillSwitchRollback`.
- El recibo se considera evidencia offline de prueba, **nunca** HEALTH/rollback de un sistema real ni go-live.
- CI y aceptación solo se acreditan sobre el HEAD exacto cuando GitHub Actions concluya.
